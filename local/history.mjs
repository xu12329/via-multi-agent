import { workerAvatar } from './avatars.mjs'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export async function openHistory(directory, runId, now = Date.now, { readOnly = false, sessionScoped = false, mail = false } = {}) {
  if (!isAbsolute(directory)) throw Error('Provide an absolute Via history directory')
  const { DatabaseSync } = await import('node:sqlite')
  const file = join(directory, 'history.sqlite')
  if (!readOnly) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    closeSync(openSync(file, 'a', 0o600))
  }
  const db = new DatabaseSync(file, { readOnly })
  db.exec('PRAGMA busy_timeout = 5000')
  if (!readOnly) db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      cwd TEXT NOT NULL, scope TEXT NOT NULL, seq INTEGER NOT NULL,
      run_id TEXT NOT NULL, dedupe TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (cwd, scope, seq),
      UNIQUE (cwd, scope, run_id, dedupe)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS member_events ON events(cwd, scope, kind, seq);
  `)
  if (sessionScoped && !readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS session_groups (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      cwd TEXT NOT NULL
    );
  `)
  if (mail && !readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS mail_summaries (
      cwd TEXT NOT NULL, scope TEXT NOT NULL, run_id TEXT NOT NULL, message_id TEXT NOT NULL,
      status TEXT NOT NULL, summary TEXT, evidence TEXT,
      PRIMARY KEY (cwd, scope, run_id, message_id)
    ) WITHOUT ROWID;
  `)
  const hasMailTable = mail && Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mail_summaries'").get())
  const reserveMail = mail && !readOnly && db.prepare(`INSERT OR IGNORE INTO mail_summaries
    (cwd, scope, run_id, message_id, status) VALUES (?, ?, ?, ?, ?)`)
  const claimMail = mail && !readOnly && db.prepare(`UPDATE mail_summaries SET status = 'sending'
    WHERE cwd = ? AND scope = ? AND run_id = ? AND message_id = ? AND status = 'pending'`)
  const settleMail = mail && !readOnly && db.prepare(`UPDATE mail_summaries SET status = ?, summary = ?, evidence = ?
    WHERE cwd = ? AND scope = ? AND run_id = ? AND message_id = ? AND status IN ('pending', 'sending', 'failed', 'uncertain')`)
  const recentMail = mail && (hasMailTable ? db.prepare(`
    SELECT e.data AS original, s.run_id AS summaryRun, s.status AS summaryStatus, s.summary,
      (SELECT p.data FROM events p WHERE p.cwd=e.cwd AND p.scope=e.scope AND p.run_id=e.run_id
       AND p.dedupe IN ('message_read:' || json_extract(e.data,'$.messageId'),
                        'message_delivery:' || json_extract(e.data,'$.messageId'))
       ORDER BY p.kind='message_read' DESC LIMIT 1) AS receipt,
      EXISTS(SELECT 1 FROM events reply WHERE reply.cwd=e.cwd AND reply.scope=e.scope AND reply.run_id=e.run_id
        AND reply.kind='message_reply' AND json_extract(reply.data,'$.replyTo')=json_extract(e.data,'$.messageId')) AS replied
    FROM events e LEFT JOIN mail_summaries s ON s.cwd=e.cwd AND s.scope=e.scope AND s.run_id=e.run_id
      AND s.message_id=json_extract(e.data,'$.messageId')
    WHERE e.cwd=? AND e.scope=? AND e.kind IN ('message_sent','message_reply')
    ORDER BY json_extract(e.data,'$.sentAt') DESC,e.seq DESC LIMIT ?
  `) : db.prepare(`
    SELECT e.data AS original, NULL AS summaryRun, NULL AS summaryStatus, NULL AS summary,
      (SELECT p.data FROM events p WHERE p.cwd=e.cwd AND p.scope=e.scope AND p.run_id=e.run_id
       AND p.dedupe IN ('message_read:' || json_extract(e.data,'$.messageId'),
                        'message_delivery:' || json_extract(e.data,'$.messageId'))
       ORDER BY p.kind='message_read' DESC LIMIT 1) AS receipt,
      EXISTS(SELECT 1 FROM events reply WHERE reply.cwd=e.cwd AND reply.scope=e.scope AND reply.run_id=e.run_id
        AND reply.kind='message_reply' AND json_extract(reply.data,'$.replyTo')=json_extract(e.data,'$.messageId')) AS replied
    FROM events e
    WHERE e.cwd=? AND e.scope=? AND e.kind IN ('message_sent','message_reply')
    ORDER BY json_extract(e.data,'$.sentAt') DESC,e.seq DESC LIMIT ?
  `))
  const summariesForGroup = hasMailTable && db.prepare(`SELECT run_id AS runId, message_id AS messageId, status, summary
    FROM mail_summaries WHERE cwd = ?1 AND scope = ?2 AND (?3 IS NULL OR run_id = ?3)`)
  const findSummary = hasMailTable && db.prepare(`SELECT status, summary FROM mail_summaries
    WHERE cwd = ? AND scope = ? AND run_id = ? AND message_id = ?`)
  const listSessionGroups = sessionScoped && db.prepare('SELECT name, cwd FROM session_groups ORDER BY id DESC')
  const latestMailGroupQuery = sessionScoped && db.prepare(`
    SELECT sg.name, sg.cwd
    FROM session_groups sg
    LEFT JOIN events e ON e.cwd = sg.cwd AND e.scope = sg.name AND e.kind IN ('message_sent', 'message_reply')
    GROUP BY sg.id, sg.name, sg.cwd
    ORDER BY MAX(COALESCE(json_extract(e.data, '$.sentAt'), json_extract(e.data, '$.at'))) IS NULL ASC,
      MAX(COALESCE(json_extract(e.data, '$.sentAt'), json_extract(e.data, '$.at'))) DESC,
      sg.id DESC
    LIMIT 1
  `)
  const findSessionGroup = sessionScoped && db.prepare('SELECT cwd FROM session_groups WHERE name = ?')
  const bindSessionGroup = sessionScoped && !readOnly && db.prepare(
    'INSERT INTO session_groups (name, cwd) VALUES (?, ?) ON CONFLICT (name) DO NOTHING',
  )
  const latest = db.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM events WHERE cwd = ? AND scope = ?')
  const first = db.prepare('SELECT data FROM events WHERE cwd = ? AND scope = ? AND seq = 1')
  const groups = db.prepare('SELECT scope FROM events WHERE cwd = ? AND seq = 1 ORDER BY scope')
  const projects = db.prepare(`
    SELECT cwd AS path,
      MAX(CASE WHEN kind IN ('message_sent','message_reply','message_delivery','message_read')
        THEN json_extract(data, '$.at') END) AS lastCommunicationAt,
      MAX(json_extract(data, '$.at')) AS lastActivityAt
    FROM events
    GROUP BY cwd
  `)
  const insert = db.prepare(`
    INSERT INTO events (cwd, scope, seq, run_id, dedupe, actor, kind, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cwd, scope, run_id, dedupe) DO NOTHING
  `)
  const page = db.prepare(`
    SELECT data FROM events WHERE cwd = ?1 AND scope = ?2 AND seq > ?3 AND seq <= ?4
    AND (?5 IS NULL OR json_extract(data, '$.at') >= ?5)
    AND (?6 IS NULL OR json_extract(data, '$.at') <= ?6) AND (?8 IS NULL OR run_id = ?8) ORDER BY seq LIMIT ?7
  `)
  const operatorEvents = db.prepare(`
    SELECT data FROM events WHERE cwd = ? AND scope = ? AND kind = 'operator_event' AND seq > ?
    AND json_extract(data, '$.kind') IN ('completed', 'worker_error', 'approval_pending', 'approval_timeout', 'coordinator_mail', 'worker_started', 'worker_saved', 'worker_blocked')
    ORDER BY seq LIMIT 6
  `)
  const approvalEvents = db.prepare(`
    SELECT data FROM events
    WHERE cwd = ?1 AND scope = ?2 AND seq IN (
      SELECT MAX(seq) FROM events WHERE cwd = ?1 AND scope = ?2 AND kind = 'operator_event' AND seq <= ?3
      AND (?4 IS NULL OR run_id = ?4) AND json_type(data, '$.approval') = 'object' GROUP BY json_extract(data, '$.approval.requestId')
    ) ORDER BY seq DESC
  `)
  const members = db.prepare(`
    SELECT data FROM events
    WHERE cwd = ?1 AND scope = ?2 AND seq IN (
      SELECT MAX(seq) FROM events
      WHERE cwd = ?1 AND scope = ?2 AND seq <= ?3 AND kind IN ('member_registered', 'worker_state') AND (?4 IS NULL OR run_id = ?4)
      GROUP BY actor
    ) ORDER BY seq
  `)
  const runRows = db.prepare(`
    SELECT run_id AS runId, MIN(json_extract(data, '$.at')) AS at, MAX(seq) AS head
    FROM events WHERE cwd = ? AND scope = ? GROUP BY run_id ORDER BY MIN(seq)
  `)
  const avatarOrder = db.prepare(`
    SELECT actor FROM events
    WHERE cwd = ? AND scope = ? AND kind IN ('member_registered', 'worker_state')
    AND (json_extract(data, '$.role') IS NULL OR json_extract(data, '$.role') != 'coordinator')
    GROUP BY actor ORDER BY MIN(seq)
  `)
  function avatars(cwd, group) {
    return new Map(avatarOrder.all(cwd, group).map(({ actor }, index) => [actor, workerAvatar(index)]))
  }
  const byKey = db.prepare('SELECT data FROM events WHERE cwd = ? AND scope = ? AND run_id = ? AND dedupe = ?')
  const lastMessageTask = db.prepare(`
    SELECT data FROM events
    WHERE cwd = ? AND scope = ? AND run_id = ? AND kind = 'message_task_state' AND json_extract(data, '$.messageId') = ?
    ORDER BY seq DESC LIMIT 1
  `)
  const actor = id => `${runId}:${id}`

  function append(task, type, details, key, reserveSummary = false) {
    const { cwd, group } = task
    // Assign a scope-local cursor and append in the same writer transaction.
    db.exec('BEGIN IMMEDIATE')
    try {
      if (bindSessionGroup && type === 'member_registered') {
        bindSessionGroup.run(group, cwd)
        if (findSessionGroup.get(group).cwd !== cwd) throw Error('This session group already has a different worker directory')
      }
      const seq = latest.get(cwd, group).head + 1
      const event = { seq, at: now(), runId, actorId: actor(task.id), type, ...details }
      const result = insert.run(cwd, group, seq, runId, key ?? `event:${seq}`, event.actorId, type, JSON.stringify(event))
      if (reserveSummary && result.changes) reserveMail.run(cwd,group,runId,details.messageId,reserveSummary)
      db.exec('COMMIT')
      return result.changes === 1
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function evidence(task, type, event, receiptAt, summarize = false) {
    const { id: messageId, from, to, text, sentAt, readAt, replyTo, delivery, providerPhase, deliveredVia } = event
    const includeText = type === 'message_sent' || type === 'message_reply'
    return append(task, type, {
      messageId, from, to, fromActorId: actor(from), toActorId: actor(to),
      source: 'concord', replyTo, delivery, providerPhase, receiptAt, deliveredVia,
      ...(includeText ? { text, sentAt } : {}),
      ...(type === 'message_read' ? { readAt } : {}),
    }, `${type}:${messageId}`, reserveMail && includeText && summarize ? (summarize === 'unavailable' ? summarize : 'pending') : false)
  }

  function approvals({ cwd, group, runId: selectedRun = null }, through = latest.get(cwd, group).head) {
    return approvalEvents.all(cwd, group, through, selectedRun).map(({ data }) => {
      const { seq, runId, actorId, id, turnId, approval } = JSON.parse(data)
      return { ...approval, seq, runId, actorId, id, turnId }
    })
  }

  return {
    worker(task, source, { exitCode, signal, diagnostic } = {}) {
      const { id, worker, state, processState, historyTurn, peer, selection, role, depth, parentId, supervisor, permissions } = task
      const turnId = historyTurn ? `${actor(id)}:${historyTurn}` : null
      const member = {
        id, worker, state, processState, turnId, role, depth, parentId, supervisor: Boolean(supervisor),
        permissions: permissions ?? null, concordReady: Boolean(peer?.enrolled),
        model: selection?.effective?.model ?? null, effort: selection?.effective?.effort ?? null,
      }
      return append(task, source === 'dispatch_accepted' ? 'member_registered' : 'worker_state',
        { ...member, source, exitCode, signal, diagnostic }, source === 'dispatch_accepted' ? `member:${id}` : undefined)
    },
    notify(task, messageId, mode, outcome) {
      return append(task, 'worker_notification', { messageId, mode, outcome }, `notification:${task.id}:${messageId}:${mode}:${outcome}`)
    },
    messageTask(task, messageId, taskId, taskState) {
      return append(task, 'message_task_state', { messageId, taskId, taskState },
        `message-task:${messageId}:${taskId}:${taskState}`)
    },
    operator(task, kind, { source, approval, detail, eventId, diagnostic } = {}) {
      const { id, worker, state, historyTurn } = task
      const turnId = historyTurn ? `${actor(id)}:${historyTurn}` : null
      return append(task, 'operator_event', { kind, id, worker, state, turnId, source, approval, detail, diagnostic },
        approval ? `approval:${approval.requestId}:${approval.status}` : eventId ? `operator:${eventId}` : undefined)
    },
    operatorEvents({ cwd, group }, after) {
      return operatorEvents.all(cwd, group, after).map(({ data }) => JSON.parse(data))
    },
    approvals,
    evidence,
    claimSummary(task,id) { return claimMail ? claimMail.run(task.cwd, task.group, runId, id).changes === 1 : false },
    settleSummary(task,id,state,value,receipt) {
      settleMail?.run(state,value,JSON.stringify(receipt),task.cwd,task.group,runId,id)
    },
    summaryFor(cwd, group, messageId, targetRun = runId) {
      if (!findSummary || !targetRun) return null
      const row = findSummary.get(cwd, group, targetRun, messageId)
      return row ? { summaryStatus: row.status, summary: row.summary ?? null } : null
    },
    recentMail(cwd, group, limit) {
      return recentMail.all(cwd,group,limit).reverse().map(row => {
        const event = JSON.parse(row.original)
        const receipt = row.receipt && JSON.parse(row.receipt)
        let summaryStatus = row.summaryStatus ?? 'unavailable'
        if (runId && row.summaryRun !== runId && summaryStatus === 'sending') summaryStatus = 'uncertain'
        if (runId && row.summaryRun !== runId && summaryStatus === 'pending') summaryStatus = 'not_started'
        return { id:event.messageId, time:new Date(event.sentAt).toISOString(), from:event.from, to:event.to,
          fromActorId:event.fromActorId, toActorId:event.toActorId,
          status:row.replied ? 'replied' : receipt?.delivery ?? event.delivery,
          ...(event.replyTo ? { replyTo:event.replyTo } : {}), summaryStatus, summary:row.summary ?? null,
          ...(row.summaryStatus === 'unavailable' ? { summaryReason:'provider_paused' } : {}) }
      })
    },
    message(task, messageId) {
      const get = type => {
        const row = byKey.get(task.cwd, task.group, runId, `${type}:${messageId}`)
        return row && JSON.parse(row.data)
      }
      const original = get('message_sent') ?? get('message_reply')
      if (!original) return
      const delivery = get('message_delivery')
      const read = get('message_read')
      const phase = read ?? delivery ?? original
      const linked = lastMessageTask.get(task.cwd, task.group, runId, messageId)
      const { taskId, taskState } = linked ? JSON.parse(linked.data) : {}
      return {
        id: messageId, cwd: task.cwd, group: task.group, from: original.from, to: original.to,
        text: original.text, sentAt: original.sentAt, replyTo: original.replyTo,
        source: 'concord', delivery: phase.delivery, providerPhase: phase.providerPhase, readAt: read?.readAt, taskId, taskState,
      }
    },
    avatars,
    sessionGroups: () => listSessionGroups.all(),
    latestMailGroup: () => latestMailGroupQuery.get() ?? listSessionGroups.all()[0],
    sessionGroup: name => findSessionGroup.get(name),
    runs: (cwd, group) => runRows.all(cwd, group),
    head: (cwd, group) => latest.get(cwd, group).head,
    groups(cwd) { return groups.all(cwd).map(row => row.scope) },
    projects: () => projects.all(),
    read({ cwd, group, after = 0, at, limit = 100, since = null, until = null, runId: selectedRun = null }) {
      const run = selectedRun && runRows.all(cwd, group).find(row => row.runId === selectedRun)
      if (selectedRun && !run) throw Error('History run is outside this group')
      const head = run?.head ?? latest.get(cwd, group).head
      const through = at ?? head
      if (through > head || after > through) throw Error('History cursor is outside this group window')
      if (since !== null && until !== null && since > until) throw Error('History time window is reversed')
      const selected = page.all(cwd, group, after, through, since, until, limit + 1, selectedRun)
      const hasMore = selected.length > limit
      const summaryMap = summariesForGroup ? new Map(
        summariesForGroup.all(cwd, group, selectedRun).map(row => [`${row.runId}:${row.messageId}`, row]),
      ) : null
      const events = selected.slice(0, limit).map(row => {
        const parsed = JSON.parse(row.data)
        if (summaryMap && (parsed.type === 'message_sent' || parsed.type === 'message_reply') && parsed.messageId) {
          const hit = summaryMap.get(`${parsed.runId}:${parsed.messageId}`)
          if (hit) {
            parsed.summaryStatus = hit.status
            if (hit.summary) parsed.summary = hit.summary
          }
        }
        return parsed
      })
      const next = hasMore ? events.at(-1).seq : through
      const beginning = first.get(cwd, group)
      const slots = avatars(cwd, group)
      const projection = members.all(cwd, group, through, selectedRun).map(({ data }) => {
        const { seq, at, runId, actorId, id, worker, state, processState, turnId, concordReady, model, effort, source, role, depth, parentId, supervisor, permissions } = JSON.parse(data)
        return { seq, at, runId, actorId, id, worker, state, processState, turnId, concordReady, model, effort, source, role, depth, parentId,
          ...(supervisor !== undefined ? { supervisor } : {}), ...(permissions !== undefined ? { permissions } : {}), ...slots.get(actorId) }
      })
      return {
        cwd, group, activeRunId: runId, head, through, next, hasMore,
        recordingSince: run?.at ?? (beginning ? JSON.parse(beginning.data).at : null), events, members: projection, approvals: approvals({ cwd, group, runId: selectedRun }, through),
      }
    },
    close() { db.close() },
  }
}
