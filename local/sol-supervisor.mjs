import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const kinds = new Set(['started', 'checkpoint', 'heartbeat', 'worker_error', 'completed',
  'approval_pending', 'approval_timeout', 'stream_lost', 'process_exit', 'backend_state', 'stalled', 'review_ready'])
const actionable = new Set(['worker_error', 'approval_timeout', 'stalled', 'review_ready'])
const backgroundTerminal = new Set(['completed', 'failed', 'cancelled'])
const epoch = x => Number.isSafeInteger(x) && x > 0
const metadata = value => typeof value === 'string' && /^[a-z0-9_.:-]{1,190}$/i.test(value) ? value : null

export function createSolSupervisor({ stateDir, wake, notify, now = Date.now }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(stateDir, 'sol-supervisor.sqlite'))
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS supervisor_events (
      scope TEXT NOT NULL, worker TEXT NOT NULL, incident TEXT NOT NULL, event TEXT NOT NULL,
      at INTEGER NOT NULL, PRIMARY KEY(scope,worker,incident));
    CREATE TABLE IF NOT EXISTS supervisor_wakes (
      scope TEXT NOT NULL, worker TEXT NOT NULL, incident TEXT NOT NULL, phase TEXT NOT NULL,
      PRIMARY KEY(scope,worker,incident));`)
  const insert = db.prepare('INSERT OR IGNORE INTO supervisor_events VALUES(?,?,?,?,?)')
  const claim = db.prepare("INSERT OR IGNORE INTO supervisor_wakes VALUES(?,?,?,'claimed')")
  const settle = db.prepare('UPDATE supervisor_wakes SET phase=? WHERE scope=? AND worker=? AND incident=?')
  const events = db.prepare('SELECT event FROM supervisor_events WHERE scope=? AND worker=? ORDER BY at,rowid')
  const lastBackend = db.prepare(`SELECT event,incident FROM supervisor_events WHERE scope=? AND worker=?
    AND json_extract(event,'$.kind')='backend_state' ORDER BY at DESC,rowid DESC LIMIT 2`)
  const freshestTurn = db.prepare(`SELECT event,incident FROM supervisor_events WHERE scope=? AND worker=?
    AND json_extract(event,'$.kind') IN ('started','completed','worker_error') ORDER BY at DESC,rowid DESC LIMIT 1`)
  const claims = db.prepare('SELECT incident,phase FROM supervisor_wakes WHERE scope=? AND worker=?')
  const inFlight = new Set()
  let closed = false
  function scoped(scope) {
    const { sessionId, cwd, group, runId } = scope
    if (![sessionId,cwd,group,runId].every(x => typeof x === 'string' && x) || !isAbsolute(cwd)) {
      throw Error('Sol supervision requires an exact session, project, group and run')
    }
    return JSON.stringify([sessionId,cwd,group,runId])
  }
  function backgroundState(records) {
    return records.findLast(record => record.kind === 'backend_state')?.state ?? 'unknown'
  }
  function observe(scope, event) {
    if (closed) throw Error('Supervisor is closed')
    const key = scoped(scope)
    const { kind, workerId, turnId, eventId, diagnostic, state } = event
    if (!kinds.has(kind) || typeof workerId !== 'string' || !workerId) throw Error('Invalid supervision event')
    const at = epoch(event.at) ? event.at : now()
    const safe = { kind, workerId, turnId: metadata(turnId), at, state: metadata(state), diagnostic: metadata(diagnostic) }
    const occurrence = metadata(eventId) ?? ([ 'checkpoint', 'heartbeat', 'backend_state' ].includes(kind) ? at : '')
    const groupReview = kind === 'review_ready'
    const ledgerWorker = groupReview ? '@group' : workerId
    const incident = JSON.stringify([groupReview ? null : safe.turnId,kind,occurrence])
    let recorded, backend, claimed, terminalEvidence
    db.exec('BEGIN IMMEDIATE')
    try {
      const priorLatestTurn = freshestTurn.get(key,workerId)
      recorded = insert.run(key,ledgerWorker,incident,JSON.stringify(safe),at).changes === 1
      const [currentBackend, priorBackend] = lastBackend.all(key,workerId)
      backend = currentBackend ? JSON.parse(currentBackend.event).state ?? 'unknown' : 'unknown'
      terminalEvidence = recorded && kind==='backend_state' && backgroundTerminal.has(safe.state) &&
        currentBackend?.incident === incident &&
        (!priorBackend || JSON.parse(priorBackend.event).state !== safe.state)
      let activeObservation = true
      if (safe.turnId && kind !== 'review_ready' && priorLatestTurn) {
        const prev = JSON.parse(priorLatestTurn.event)
        if (prev.turnId === safe.turnId && prev.kind === 'completed') activeObservation = false
        else if (prev.turnId !== safe.turnId && prev.at > at) activeObservation = false
      }
      if (recorded && (actionable.has(kind) && activeObservation || terminalEvidence && safe.state==='failed') &&
          backend !== 'running' && typeof wake === 'function') {
        claimed = claim.run(key,ledgerWorker,incident).changes === 1
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    if (!recorded) return { recorded:false, wake:'duplicate' }
    const notice = { scope, event:safe, backend, incident }
    if ((terminalEvidence || actionable.has(kind) || ['completed','stream_lost','approval_pending','process_exit'].includes(kind)) && notify) {
      void Promise.resolve().then(()=>notify(notice)).catch(()=>{})
    }
    if (!claimed) return {recorded:true,wake:'none'}
    const work = Promise.resolve().then(()=>wake(notice))
      .then(value=>settle.run(value?.accepted ? 'accepted' : 'not_accepted',key,ledgerWorker,incident),
        ()=>settle.run('uncertain',key,ledgerWorker,incident))
      .finally(()=>inFlight.delete(work))
    inFlight.add(work)
    return {recorded:true,wake:'claimed'}
  }
  return {
    observe,
    snapshot(scope, workerId) {
      const key = scoped(scope)
      const records = events.all(key,workerId).map(row=>JSON.parse(row.event))
      return {
        turn: records.findLast(row=>['started','completed','worker_error'].includes(row.kind))?.kind ?? 'unknown',
        process: records.findLast(row=>['heartbeat','process_exit'].includes(row.kind))?.kind ?? 'unknown',
        background: backgroundState(records), records, wakes:claims.all(key,workerId),
      }
    },
    checkStalled(scope,{workerId,turnId,leaseId,deadline}) {
      if (!leaseId || !turnId || !epoch(deadline) || deadline > now()) return {recorded:false,wake:'none'}
      const key = scoped(scope)
      const records = events.all(key,workerId).map(row=>JSON.parse(row.event))
      const turn = records.findLast(row=>row.turnId===turnId && ['started','completed','worker_error'].includes(row.kind))
      if (turn?.kind !== 'started' || records.some(row=>row.turnId===turnId && row.kind === 'checkpoint' && row.at > deadline)) {
        return {recorded:false,wake:'none'}
      }
      return observe(scope,{kind:'stalled',workerId,turnId,eventId:leaseId,diagnostic:'explicit_deadline_elapsed'})
    },
    async close() { closed = true; await Promise.allSettled(inFlight); db.close() },
  }
}
