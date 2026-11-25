import { claudeSessionDirectory, claudeSessionId } from './claude-session.mjs'
import { createDelegation } from './delegation.mjs'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { uniqueDispatch } from './dispatch.mjs'
import { createBoard } from './board.mjs'
import { listAgyModels } from './agy-selection.mjs'
import { requestedCodexModel } from './codex-selection.mjs'
import { openWorker, readCodexModels } from './backend.mjs'
import { createApprovalQueue } from './worker-permissions.mjs'
import { createOperatorReview } from './operator-review.mjs'
import { coordinatorHost, pushOperatorEvent } from './operator-events.mjs'
import { createConcord } from './concord.mjs'
import { openHistory } from './history.mjs'
import { viaWorkspace, workspaceRoot } from './workspace.mjs'
import { registerBoard } from './preview-http.mjs'
import { mailSummaries } from './mail-summaries.mjs'
import { daemonPath } from './daemon-path.mjs'
import { createSolSupervisor } from './sol-supervisor.mjs'

async function concordEntry() {
  for (const candidate of [
    '../node_modules/@concord-ai/concord-mcp/dist/index.js',
    '../vendor/concord/dist/index.js',
    '../vendor/node_modules/@concord-ai/concord-mcp/dist/index.js',
  ]) {
    const resolved = fileURLToPath(new URL(candidate, import.meta.url))
    if (await access(resolved).then(() => true, () => false)) return resolved
  }
  return fileURLToPath(new URL('../node_modules/@concord-ai/concord-mcp/dist/index.js', import.meta.url))
}

const sessionScoped = process.env.VIA_CLAUDE_SESSION_SCOPE === '1'
const codexScoped = process.env.VIA_CODEX_SESSION_SCOPE === '1'
const scoped = sessionScoped || codexScoped
const daemonMode = process.argv.includes('--daemon')
if (daemonMode && !sessionScoped) throw Error('Via daemon requires Claude session binding')
if (sessionScoped && codexScoped) throw Error('Choose one Via host session source')

async function codexHistoryDirectory(session) {
  const base = process.env.VIA_HISTORY_DIR
  if (!base || !isAbsolute(base)) throw Error('Set an absolute Codex Via history directory')
  await mkdir(base, {recursive:true,mode:0o700})
  let dir = await realpath(base)
  for (const name of ['codex-sessions',session]) {
    dir = join(dir,name)
    await mkdir(dir, { mode:0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    if (!(await lstat(dir)).isDirectory()) throw Error('Via session storage requires a separate local directory')
  }
  const file = await lstat(join(dir,'history.sqlite')).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (file && (!file.isFile() || file.nlink !== 1)) throw Error('Via session storage requires a separate history file')
  return dir
}
const controllers = new Map()
const nativeOwners = new Map()
function claimNative(task, session) {
  if (!session) return
  const key = task.worker + ':' + session.toLowerCase()
  const owner = nativeOwners.get(key)
  if (owner && owner !== task) throw Error('This native session is already attached to another Via task')
  nativeOwners.set(key,task)
  task.nativeClaim = key
}
function releaseNative(task) {
  if (nativeOwners.get(task.nativeClaim) === task) nativeOwners.delete(task.nativeClaim)
  task.nativeClaim = undefined
}
const hostRequests = new Map()
const hostBindings = new Map()
let closing = false
let hostSequence = 0

function unbind(client) {
  if (hostBindings.get(client.session) === client) hostBindings.delete(client.session)
  for (const [requestId, pending] of hostRequests) {
    if (pending.client !== client) continue
    hostRequests.delete(requestId)
    pending.complete({})
  }
}

function controllerFor(session, nativeThread, client) {
  if (!sessionScoped && session !== undefined) throw Error('This Via controller does not accept a Claude Code session')
  if (codexScoped && (typeof nativeThread !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nativeThread))) {
    throw Error('The Codex host did not provide this thread’s native identity')
  }
  const id = codexScoped ? nativeThread.toLowerCase() : sessionScoped ? claudeSessionId(session) : null
  if (client.session !== id) unbind(client)
  client.session = id
  hostBindings.set(id, client)
  if (!controllers.has(id)) {
    controllers.set(id, createController(id).catch(error => {
      controllers.delete(id)
      throw error
    }))
  }
  return controllers.get(id)
}

function elicit(session, message, canAllow, timeout) {
  const client = hostBindings.get(session)
  if (closing || !client?.ready || !client.elicitation) return null
  const id = `via-approval-${++hostSequence}`
  return new Promise(resolve => {
    const timer = setTimeout(() => { hostRequests.delete(id); resolve(null) }, timeout)
    timer.unref()
    hostRequests.set(id, {client, complete:event => {
      clearTimeout(timer)
      if (event.error) return resolve(null)
      const result = event.result
      if (result?.action === 'decline') return resolve('reject')
      if (result?.action === 'accept' && typeof result.content?.allowOnce === 'boolean') {
        return resolve(result.content.allowOnce && canAllow ? 'allow_once' : 'reject')
      }
      resolve(null)
    } })
    client.send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
      mode: 'form', message, requestedSchema: { type: 'object', properties: {
        allowOnce: { type: 'boolean', title: canAllow ? 'Allow once' : 'Request cannot be authorized here', default: false },
      }, required: ['allowOnce'] },
    } })
  })
}

const string = { type: 'string', minLength: 1 }
const cursor = { type: 'integer', minimum: 0 }
const tools = [
  ['start', 'Start a background task as the top-level coordinator for this group. Agree on goal and evidence, send work to verified addresses, and accept the group only after checking the results. First-level workers can optionally delegate to leaves once. For a Codex/Sol plan that Antigravity/Gemini will execute, first start the agy worker with activation: "concord", then use status with its returned ID until state=waiting_inbox. Only then start codex in the same cwd and group, and tell it to send its plan through Concord to that exact agy ID. Concord wakes the recipient, which can fetch, execute and reply. Omit activation for independent tasks that should start immediately. Set model or effort to override Via defaults.', { worker: { enum: ['codex', 'agy'] }, group: string, cwd: string, prompt: string, session: string, model: string, effort: string, requestId: string, permissions: { enum: ['full', 'restricted'], description: 'New and resumed workers default to full access unless restricted is explicitly specified.' }, activation: { enum: ['concord'], description: 'AGY only. Register and wait until a group Concord plan arrives. Omit to start immediately.' } }, ['worker', 'group', 'cwd', 'prompt']],
  ...(scoped ? [['list', 'Read recent messages in the current session’s latest active-mail Via group. Optionally select another group from this session. Returns oldest to newest within the requested recent window.',
    { group:string, limit:{ type:'integer', minimum:1, maximum:100 } }, []]] : []),
  ['models', 'List the native backend model IDs and their supported effort settings without starting a model turn.', { worker: { enum: ['codex', 'agy'] }, cwd: string }, ['worker']],
  ['board', 'Read the current Via controller and task groups. Provide cwd and group for a project group.', { cwd: string, group: string, runId: string, view: { enum: ['desk', 'desk-projects'] } }, []],
  ['history', 'Read recorded events for one project group. Use at to pin a cursor, after to page, or since/until for inclusive UTC epoch milliseconds.', { cwd: string, group: string, runId: string, view: { enum: ['desk'] }, after: cursor, at: cursor, since: cursor, until: cursor, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['cwd', 'group']],
  ['status', 'Read worker state and approvals. For an archived worker supply its history actorId as id with the exact cwd and group.', { id: string, group: string, cwd: string }, []],
  ['steer', 'Send a message to a live turn, without starting a fresh turn.', { id: string, text: string, group: string }, ['id', 'text']],
  ['stop', 'Stop the owned worker process and release the saved native session. Supply expectedTurnId to protect a subsequent turn.', { id: string, group: string, expectedTurnId: string }, ['id']],
  ['followup', 'Start a new turn in the same session, reopening it if stop confirmed release.', { id: string, text: string, group: string }, ['id', 'text']],
  ['review_approval', 'Ask the local operator to decide one pending approval. No decision can be provided by the caller.', { id: string, group: string, requestId: string }, ['id', 'group', 'requestId']],
  ['coordinator_inbox', 'Read the real Concord inbox addressed to the bound coordinator for this project and group. This consumes those messages. A read or child completion is not group acceptance.', { cwd:string, group:string }, ['cwd','group']],
  ['peer_read', 'Inspect queued peer messages for a worker without consuming them.', { worker: string }, ['worker']],
  ['reminders', 'Control whether Via pushes operator reminder notifications to Claude for this session. OFF by default (messages stay in the message box / coordinator_inbox / list without waking Claude). Call action="open" to enable.', { action: { enum: ['open', 'close', 'status'] }, desktop: { type: 'boolean', description: 'When opening reminders, also show macOS desktop notifications (default true).' } }, ['action']],
].map(([name, description, properties, required]) =>
  ({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    ...(['models', 'board', 'history', 'status', 'peer_read', 'list'].includes(name) ? { annotations: { readOnlyHint: true } } : {}),
  }))

async function createController(session) {
  const tasks = new Map()
  const coordinators = new Map()
  const coordinatorKey = (cwd,group) => JSON.stringify([cwd,group])
  let workerSequence = 0
  function ensureCoordinator({ cwd, group }) {
    const key = coordinatorKey(cwd, group)
    if (!coordinators.has(key)) {
      const identity = { id:`coordinator-${coordinators.size+1}`, worker:'coordinator', role:'coordinator',
        parentId:null, depth:0, cwd, group, state:'ready', peer:{} }
      const result = concord.enroll(identity).then(() => {
        identity.peer.enrolled = true
        history?.worker(identity, 'dispatch_accepted')
        return identity
      }).catch(error => {
        coordinators.delete(key)
        throw error
      })
      coordinators.set(key, result)
    }
    return coordinators.get(key)
  }
  const delegate = createDelegation(start, tasks)
  const configuredApprovalTimeout = Number(process.env.VIA_APPROVAL_TIMEOUT_MS)
  const approvals = createApprovalQueue({
    ...(Number.isSafeInteger(configuredApprovalTimeout) && configuredApprovalTimeout >= 25 && configuredApprovalTimeout <= 90_000
      ? { timeoutMs: configuredApprovalTimeout } : {}),
    onState(task, approval) {
      const kind = approval.status === 'pending' ? 'approval_pending' :
        approval.status === 'expired' ? 'approval_timeout' : 'approval_changed'
      reportOperator(task, kind, { approval })
    },
    onPending({ id, group, requestId }) {
      if (!daemonMode && hostClient()?.elicitation) return reviewThroughHost(get(id, group), requestId)
    },
  })
  const working = task => ['starting', 'running', 'peer_action'].includes(task.state)
  const roots = workspaceRoot()
  const workers = { codex:'VIA_CODEX', agy:'VIA_AGY' }
  async function workerExecutable(worker) {
    const configured = process.env[workers[worker]]
    const home = homedir()
    const search = [join(home,'.nvm/versions/node',process.version,'bin'), join(home,'.local/bin'),
      dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']
    const candidates = configured ? [configured] : search.filter(isAbsolute).map(directory => join(directory,worker))
    for (const path of candidates) {
      if (isAbsolute(path) && await access(path, 1).then(() => true, () => false)) return path
    }
    throw Error(`Install the ${worker} CLI or set ${workers[worker]} to its executable`)
  }
  const runId = randomUUID()
  const historyDir = codexScoped ? await codexHistoryDirectory(session)
    : session ? await claudeSessionDirectory(session) : process.env.VIA_HISTORY_DIR
  const project = process.env.VIA_HISTORY_PROJECT ? await viaWorkspace(process.env.VIA_HISTORY_PROJECT) : null
  const previewProject = !sessionScoped && process.env.VIA_DESK_ENABLED === '1'
    ? await viaWorkspace(process.cwd()).catch(() => null)
    : project
  const history = historyDir ? await openHistory(historyDir, runId, Date.now, { sessionScoped:scoped,mail:scoped }) : null
  const reminderChannel = { open: false, desktop: false }
  const supervisors = new Map()
  const supervisorWakeChains = new Map()
  const groupReviews = new Map()
  const board = createBoard(tasks, snapshotForBoard, runId)
  const summaries = scoped && history ? mailSummaries(history, undefined, {
    enabled: process.env.VIA_SUMMARY_ENABLED === '1',
    onSettled(task, messageId, state, summary) {
      board.setSummary(messageId, state, summary)
    },
  }) : null
  const supervisor = daemonMode && process.env.VIA_SOL_SUPERVISION !== 'off'
    ? createSolSupervisor({ stateDir: historyDir, wake: wakeSupervisor }) : null
  const boardRegistrations = new Map()
  function registerProjectBoard(directory) {
    if (!history || !directory || (!sessionScoped && !previewProject && !project)) return
    if (boardRegistrations.has(directory)) return
    const registration = registerBoard(historyDir, directory, runId, group => {
      const { groups, tasks: current, peerEvents, unreadCoordinatorCount } = board.snapshot(group, directory)
      if (!group) return { controllerId: runId, groups, tasks: [], peerEvents: [], unreadCoordinatorCount: 0 }
      const actor = id => `${runId}:${id}`
      const safeTasks = current.map(({ id, group, worker, state, processState, turn, output, activity, selection, peer, autoWake, approvals, supervisor, depth, parentId, role, permissions }) =>
        ({ id, actorId: actor(id), runId, group, worker, state, processState, turn, output: output.slice(-600), activity,
          selection: { effective: selection?.effective }, concordReady: Boolean(peer?.enrolled), autoWake, approvals,
          supervisor, depth, parentId, role, permissions }))
      return { controllerId: runId, groups, tasks: safeTasks, unreadCoordinatorCount,
        peerEvents: peerEvents.map(message => ({ ...message, fromActorId: actor(message.from), toActorId: actor(message.to) })) }
    }, { scoped: true }).catch(() => {
      boardRegistrations.delete(directory)
      return null
    })
    boardRegistrations.set(directory, registration)
  }
  async function stopTask({ id, group, expectedTurnId }, { byCoordinator = true } = {}) {
    const task = get(id, group)
    const prior = task.stopReceipt
    if (expectedTurnId && expectedTurnId !== task.turn) {
      return prior?.turn === expectedTurnId ? { ...prior } : { state:'stale_turn', turn:task.turn }
    }
    if (byCoordinator) task.stoppedByCoordinator = true
    if (task.stopping) return task.stopping
    if (task.processState === 'exited' && prior?.sessionReleased) return { ...prior }
    task.stopRequested = true
    task.wakePaused = true
    task.pendingWake.clear()
    concord.cancelReplyWakes(task)
    task.stopping = (async () => {
      if (task.state === 'starting' && task.processState === 'unconfirmed') {
        const receipt = { state:'submitted', turn:null, sessionReleased:false }
        task.stopReceipt = receipt
        if (task.close) {
          const evidence = await task.close()
          receipt.sessionReleased = Boolean(evidence?.confirmed)
        } else {
          releaseNative(task)
          task.processState = 'exited'
          task.state = 'stopped'
          receipt.sessionReleased = true
        }
        receipt.state = receipt.sessionReleased ? 'stopped' : 'release_unconfirmed'
        return { ...receipt }
      }
      await task.startup?.catch(() => undefined)
      await task.reopening?.catch(() => undefined)
      if (!task.backend) return { state:'no_active_turn',turn:null,sessionReleased:task.processState === 'exited' }
      return task.backend.stop(expectedTurnId)
    })()
    try { return await task.stopping }
    finally { task.stopping = null }
  }
  async function superviseWorker(actor, name, args) {
    if (!actor?.supervisor) throw Error('Supervisor tools are restricted to the Sol supervisor')
    const scopeGroup = actor.group
    const scopeCwd = actor.cwd
    if (name === 'group_status') {
      const members = [...tasks.values()]
        .filter(task => task.cwd === scopeCwd && task.group === scopeGroup && (!args.id || task.id === args.id))
        .map(task => ({
          id: task.id, worker: task.worker, role: task.role, supervisor: Boolean(task.supervisor),
          depth: task.depth, parentId: task.parentId, state: task.state, processState: task.processState,
          turn: task.turn, stoppedByCoordinator: Boolean(task.stoppedByCoordinator),
          permissions: task.permissions ?? null, diagnostic: task.diagnostic ?? null, failure: task.failure ?? null,
          selection: task.selection?.effective ?? null, activity: task.activity ?? null,
          lastActivityAt: task.lastActivityAt ?? null, output: task.output?.slice(-2000) ?? '',
        }))
      if (args.id && !members.length) throw Error('Unknown task ID in this group')
      return { group: scopeGroup, cwd: scopeCwd, tasks: members }
    }
    if (name === 'group_history') {
      if (!history) return { cwd: scopeCwd, group: scopeGroup, events: [], members: [], approvals: [] }
      return history.read({ cwd: scopeCwd, group: scopeGroup, after: args.after ?? 0, limit: Math.min(args.limit ?? 50, 100) })
    }
    if (name === 'group_list') {
      if (!history) return { group: scopeGroup, messages: [] }
      return { group: scopeGroup, messages: history.recentMail(scopeCwd, scopeGroup, Math.min(args.limit ?? 20, 50)) }
    }
    const target = get(args.id, scopeGroup)
    if (target.cwd !== scopeCwd || target.supervisor || target.depth < 1) {
      throw Error('Supervisor may only control non-supervisor workers in this group')
    }
    if (name === 'steer_worker') {
      const result = await (target.backend?.steer(args.text) ?? { accepted: false, reason: 'worker_starting' })
      history?.operator(target, 'supervisor_action', { source: actor.id, detail: 'steer_worker' })
      return result
    }
    if (name === 'followup_worker') {
      if (target.stoppedByCoordinator) {
        throw Error('Worker was explicitly stopped by the coordinator; report to coordinator instead of restarting.')
      }
      const result = actions.followup({ id: target.id, group: scopeGroup, text: args.text })
      history?.operator(target, 'supervisor_action', { source: actor.id, detail: 'followup_worker' })
      return result
    }
    if (name === 'stop_worker') {
      const result = await stopTask({ id: target.id, group: scopeGroup, expectedTurnId: args.expectedTurnId }, { byCoordinator: false })
      history?.operator(target, 'supervisor_action', { source: actor.id, detail: 'stop_worker' })
      return result
    }
    throw Error('Unknown supervisor tool')
  }
  const concord = await createConcord({
    entry: process.env.VIA_CONCORD_ENTRY ?? await concordEntry(),
    board,
    history,
    delegate,
    supervise: superviseWorker,
    summaries,
    milestone: scoped ? reportMilestone : null,
    observeRead(task, event, providerTurn) {
      const link = task.messageTurn
      if (!link || link.messageId !== event.id || task.state !== 'running' ||
          !providerTurn || providerTurn !== task.turn || task.agyTurn?.steerSent) return
      const taskId = `${runId}:${task.id}:${task.historyTurn}`
      if (concord.linkTask(task, event.id, taskId, 'running')) Object.assign(link, { taskId, providerTurn })
    },
    wake(task, messageId, text, reason) {
      if (task.depth === 0) {
        reportOperator(task, 'coordinator_mail', { source:'concord', eventId: `${task.id}:mail:${messageId}` })
        return
      }
      if (task.wakePaused || task.state === 'failed' || task.state === 'cancelled' || task.state === 'stopped' || task.processState === 'exited') return
      history?.notify(task, messageId, 'inbox', 'queued')
      task.pendingWake.set(messageId, text)
      scheduleWake(task)
    },
  }).catch(error => {
    history?.close()
    throw error
  })
  if (!sessionScoped) registerProjectBoard(previewProject)

  const operatorCursors = new Map()
  const hostClient = () => {
    const client = hostBindings.get(session)
    return client?.ready ? client : null
  }
  const reviewThroughHost = createOperatorReview({ approvals, elicit:(...args) => elicit(session, ...args) })
  const reviewLocally = createOperatorReview({ approvals })

  function observeSupervision(task, kind, { eventId, diagnostic } = {}) {
    if (!supervisor || task.supervisor || task.depth !== 1 || closing) return
    const scope = { sessionId: session, cwd: task.cwd, group: task.group, runId }
    try {
      supervisor.observe(scope, { kind, workerId: task.id,
        turnId: task.historyTurn ? `${task.id}:${task.historyTurn}` : null,
        state: task.state, eventId, diagnostic: diagnostic?.code ?? diagnostic })
    } catch {
      history?.operator(task, 'worker_blocked', { source: 'supervision_storage',
        eventId: `${task.id}:${task.historyTurn}:supervision`, detail: '监管事件未写入' })
    }
  }

  function isSupervisorUsable(task) {
    return Boolean(task && task.backend && task.processState !== 'exited' &&
      !['failed', 'stopped', 'cancelled'].includes(task.state) && !(task.stopRequested && task.ephemeral))
  }

  async function spawnFreshSupervisor(key, scope, prompt) {
    const pending = start({
      worker: 'codex', group: scope.group, cwd: scope.cwd, prompt,
      model: process.env.VIA_SUPERVISOR_MODEL || undefined,
      effort: process.env.VIA_SOL_SUPERVISOR_EFFORT || 'medium',
      permissions: process.env.VIA_SOL_SUPERVISOR_PERMISSIONS === 'restricted' ? 'restricted' : 'full',
    }, null, true).then(result => tasks.get(result.id))
    supervisors.set(key, pending)
    pending.catch(() => { if (supervisors.get(key) === pending) supervisors.delete(key) })
    const task = await pending
    const confirmed = await confirmsSupervisorTurn(task, 0)
    if (!confirmed) {
      if (supervisors.get(key) === pending) supervisors.delete(key)
      return false
    }
    return true
  }

  function wakeSupervisor({ scope, event }) {
    const key = coordinatorKey(scope.cwd, scope.group)
    const previous = supervisorWakeChains.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => runSupervisorWake(key, scope, event))
    supervisorWakeChains.set(key, next)
    return next
  }

  async function runSupervisorWake(key, scope, event) {
    if (closing || scope.sessionId !== session || scope.runId !== runId) return { accepted: false }
    const original = tasks.get(event.workerId)
    if (!original || original.cwd !== scope.cwd || original.group !== scope.group || original.supervisor || original.stopRequested) {
      return { accepted: false }
    }
    const reason = event.kind === 'review_ready'
      ? 'The workers in this group have completed their current turns. Verify the deliverables against the instructions and actual evidence before declaring acceptance.'
      : `${event.workerId} reported ${event.kind}${event.diagnostic ? ` (${event.diagnostic})` : ''}.`
    const prompt = `You are the Via Sol supervisor assisting Claude (Claude holds highest authority) for group "${scope.group}". ${reason} ` +
      'Use your monitoring and maintenance tools (group_status, group_history, group_list, steer_worker, followup_worker, stop_worker) and Concord (inspect_work, update_work, report_stage). ' +
      'Verify actual checkpoints and external state first — a failed/interrupted model turn does not prove background work stopped. ' +
      'NEVER duplicate a live external job, NEVER change permissions/approvals, NEVER restart a worker explicitly stopped by Claude (stoppedByCoordinator), and NEVER spawn new workers. ' +
      'Intervene (steer_worker / followup_worker / stop_worker) only when needed to recover or stop a broken/stalled worker safely. ' +
      'Send concise final results or blockers needing Claude/operator attention to the coordinator-* agent via update_work (these appear in the coordinator message box without waking Claude unless Claude enabled reminders).'

    const pending = supervisors.get(key)
    if (!pending) {
      return { accepted: await spawnFreshSupervisor(key, scope, prompt) }
    }
    let task = await pending.catch(() => null)
    if (!isSupervisorUsable(task)) {
      if (supervisors.get(key) === pending) supervisors.delete(key)
      return { accepted: await spawnFreshSupervisor(key, scope, prompt) }
    }
    if (task.state === 'starting') {
      const ok = await confirmsSupervisorTurn(task, 0)
      if (!ok || !isSupervisorUsable(task)) {
        if (supervisors.get(key) === pending) supervisors.delete(key)
        return { accepted: await spawnFreshSupervisor(key, scope, prompt) }
      }
    }
    if (task.state === 'running') {
      for (let i = 0; i < 20 && !task.turn && task.state === 'running' && !closing; i++) {
        await delay(100, undefined, { ref: false })
      }
      if (task.state === 'running' && task.turn) {
        const receipt = await task.backend.steer(prompt).catch(() => null)
        return { accepted: receipt?.accepted === true }
      }
      if (!isSupervisorUsable(task)) {
        if (supervisors.get(key) === pending) supervisors.delete(key)
        return { accepted: await spawnFreshSupervisor(key, scope, prompt) }
      }
    }
    const turn = task.startedTurn ?? 0
    try {
      actions.followup({ id: task.id, group: task.group, text: prompt })
    } catch {
      if (supervisors.get(key) === pending) supervisors.delete(key)
      return { accepted: await spawnFreshSupervisor(key, scope, prompt) }
    }
    if (await confirmsSupervisorTurn(task, turn)) return { accepted: true }
    if (supervisors.get(key) === pending) supervisors.delete(key)
    return { accepted: await spawnFreshSupervisor(key, scope, prompt) }
  }

  async function confirmsSupervisorTurn(task, previous) {
    for (let attempt = 0; attempt < 120 && !closing; attempt += 1) {
      if ((task.startedTurn ?? 0) > previous) return true
      if (task.processState === 'exited' || task.state === 'failed' || task.state === 'stopped') return false
      await delay(250, undefined, { ref: false })
    }
    return false
  }

  function reviewWhenComplete(task) {
    if (!supervisor || task.supervisor || (task.depth !== 1 && task.depth !== 2) || closing) return
    const key = coordinatorKey(task.cwd, task.group)
    clearTimeout(groupReviews.get(key))
    const timer = setTimeout(() => {
      groupReviews.delete(key)
      const peers = [...tasks.values()].filter(peer => !peer.supervisor && peer.depth === 1 && peer.cwd === task.cwd && peer.group === task.group)
      const activeLeaves = [...tasks.values()].some(peer => !peer.supervisor && peer.depth === 2 && peer.cwd === task.cwd && peer.group === task.group && ['starting', 'running', 'waiting_inbox', 'peer_action'].includes(peer.state) && !peer.stopRequested)
      if (!peers.length || activeLeaves || peers.some(peer => ['starting', 'running', 'waiting_inbox', 'peer_action'].includes(peer.state) && !peer.stopRequested)) return
      const completed = peers.filter(peer => peer.state === 'completed' && !peer.stopRequested)
      if (!completed.length) return
      const evidence = completed.map(peer => `${peer.id}:${peer.historyTurn}`).join(',')
      const digest = createHash('sha256').update(evidence).digest('hex').slice(0, 24)
      observeSupervision(completed[0], 'review_ready', { eventId: `group-final-${digest}` })
    }, 1200)
    timer.unref()
    groupReviews.set(key, timer)
  }

  const parsedWatchdogMs = Number(process.env.VIA_SUPERVISOR_WATCHDOG_MS)
  const watchdogMs = Number.isSafeInteger(parsedWatchdogMs) && parsedWatchdogMs >= 20 && parsedWatchdogMs <= 300_000 ? parsedWatchdogMs : 30_000
  const parsedStallMs = Number(process.env.VIA_SUPERVISOR_STALL_MS)
  const stallMs = Number.isSafeInteger(parsedStallMs) && parsedStallMs >= 50 && parsedStallMs <= 3_600_000 ? parsedStallMs : 600_000
  const watchdogTimer = supervisor ? setInterval(() => {
    if (closing) return
    const now = Date.now()
    for (const task of tasks.values()) {
      if (task.supervisor || task.depth !== 1 || !['starting', 'running'].includes(task.state)) continue
      const activityCount = (task.activity?.messages ?? 0) + (task.activity?.toolUpdates ?? 0)
      if (activityCount !== (task._watchdogActivityCount ?? 0)) {
        task._watchdogActivityCount = activityCount
        task.lastActivityAt = now
      }
      if (task.processState === 'ready') {
        observeSupervision(task, 'heartbeat', { eventId: `hb-${task.id}-${Math.floor(now / watchdogMs)}` })
      }
      if (task.historyTurn && (now - (task.lastActivityAt ?? now)) >= stallMs) {
        const scope = { sessionId: session, cwd: task.cwd, group: task.group, runId }
        const turnId = `${task.id}:${task.historyTurn}`
        const bucket = Math.floor(now / stallMs)
        try {
          supervisor.checkStalled(scope, {
            workerId: task.id, turnId, leaseId: `stall-${task.id}-${task.historyTurn}-${bucket}`,
            deadline: (task.lastActivityAt ?? now) + stallMs,
          })
        } catch {}
      }
    }
  }, watchdogMs) : null
  watchdogTimer?.unref?.()

  function reportOperator(task, kind, details = {}) {
    const occurrence = details.eventId ?? `${task.id}:${task.historyTurn ?? 0}:${kind}`
    const recorded = history?.operator(task, kind, { ...details, eventId: occurrence })
    if (recorded === false) return
    if (!reminderChannel.open && history && task.cwd && task.group) {
      operatorCursors.set(JSON.stringify({ cwd: task.cwd, group: task.group }), history.head(task.cwd, task.group))
    }
    const client = hostClient()
    if (!closing && reminderChannel.open && (client || daemonMode)) {
      pushOperatorEvent({ send: client ? client.send : (() => {}), host: client?.name ?? 'Claude Code',
        event: { kind, id: task.id, group: task.group, detail: details.detail, diagnostic: details.diagnostic },
        desktop: reminderChannel.desktop && process.env.VIA_OPERATOR_NOTIFICATIONS !== 'off' })
    }
    const supervisionKind = { worker_started: 'started', worker_saved: 'checkpoint',
      worker_blocked: 'worker_error' }[kind] ?? kind
    if (['worker_started', 'worker_saved', 'worker_blocked', 'worker_error', 'completed', 'approval_pending', 'approval_timeout'].includes(kind)) {
      observeSupervision(task, supervisionKind, { eventId: details.approval?.requestId ?? occurrence, diagnostic: details.diagnostic })
    }
  }

  function reportMilestone(task, {id,state,detail}) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(id ?? '') ||
        !['saved','blocked'].includes(state) || typeof detail !== 'string' || !detail.trim() || detail.length > 180) {
      throw Error('Report a saved or blocked stage with a stable ID and brief detail')
    }
    task.lastActivityAt = Date.now()
    task.reportedStages ??= new Set()
    if (task.reportedStages.has(id)) return { accepted:true, duplicate:true }
    if (task.reportedStages.size >= 100) throw Error('Worker stage limit reached')
    task.reportedStages.add(id)
    const event = {kind:state === 'saved' ? 'worker_saved' : 'worker_blocked', id,
      detail:detail.replace(/[\x00-\x1f\x7f]/g,' ').trim()}
    if (state === 'blocked') {
      flushStage(task)
      if (task.lastBlockedStage === event.detail) return { accepted:true,duplicate:true }
      task.lastBlockedStage = event.detail
      reportOperator(task,event.kind,{ source:'worker_checkpoint',detail:event.detail, eventId: `${task.id}:stage:${id}` })
    } else {
      task.pendingStage = event
      if (!task.stageTimer) {
        task.stageTimer = setTimeout(() => {
          task.stageTimer = undefined
          flushStage(task)
        },1000)
        task.stageTimer.unref()
      }
    }
    return { accepted:true }
  }

  function flushStage(task) {
    const stage = task.pendingStage
    task.pendingStage = undefined
    if (stage) reportOperator(task,stage.kind,{ source:'worker_checkpoint',detail:stage.detail, eventId: `${task.id}:stage:${stage.id}` })
  }

  async function operatorBacklog(name, args, result) {
    if (!reminderChannel.open || name === 'reminders' || !history || !hostClient()) return []
    if (name === 'board' && (args.view === 'desk' || args.view === 'desk-projects' || args.runId || (args.cwd && (result?.runs?.length ?? 0) > 1))) return []
    const task = ['start', 'status', 'steer', 'stop', 'followup', 'review_approval'].includes(name)
      ? tasks.get(args.id ?? result?.id) : undefined
    const cwd = task?.cwd ?? (name === 'board' ? args.cwd ?? project : null)
    const group = task?.group ?? (name === 'board' ? args.group : null)
    if (!cwd || !group) return []
    const scope = { cwd: task ? cwd : await scopeWorkspace(cwd), group }
    const key = JSON.stringify(scope)
    const events = history.operatorEvents(scope, operatorCursors.get(key) ?? 0)
    if (events.length) operatorCursors.set(key, events.at(-1).seq)
    return events.map(({ seq, runId, kind, id, state, approval, detail, diagnostic }) => ({
      id: `${runId}:${seq}`, kind, worker: id, state, ...(detail ? {detail} : {}), ...(diagnostic ? {diagnostic} : {}),
      ...(approval ? { requestId: approval.requestId, action: approval.action, status: approval.status } : {}),
    }))
  }

  function promptWorker(task, text, wakeSource) {
    task.lastActivityAt = Date.now()
    task.historyTurn = (task.historyTurn ?? 0) + 1
    task.messageTurn = wakeSource ? { messageId: wakeSource } : undefined
    return task.backend.prompt(text)
  }

  function observeWorker(task, source, details) {
    task.lastActivityAt = Date.now()
    if (source === 'turn_started') {
      task.startedTurn = task.historyTurn
      if (task.pendingWake.size) queueMicrotask(() => scheduleWake(task))
    }
    if (source === 'turn_started' || (task.worker === 'agy' && source === 'turn_requested')) observeSupervision(task, 'started')
    if (source === 'process_exit' && details?.confirmed) observeSupervision(task, 'process_exit', details)
    if (details?.diagnostic?.code === 'response_stream_lost') observeSupervision(task, 'stream_lost', details)
    if (source === 'turn_finished' && task.state === 'interrupted' && !task.stopRequested) {
      observeSupervision(task, 'worker_error', {
        eventId: `${task.id}:${task.historyTurn ?? 0}:interrupted`,
        diagnostic: 'unexpected_interruption',
      })
    }
    if (source === 'process_exit' && details?.confirmed) {
      concord.unenroll(task)
      releaseNative(task)
      if (task.peer) task.peer.backendReady = false
    }
    history?.worker(task, source, details)
    if (source === 'turn_finished') queueMicrotask(() => scheduleWake(task))
    const kind = source === 'turn_finished' && task.state === 'completed' ? 'completed' :
      source === 'operation_failed' || source === 'process_error' ||
      (source === 'process_exit' && task.state === 'failed') ||
      (source === 'turn_finished' && !['completed', 'cancelled', 'interrupted', 'stopped'].includes(task.state)) ? 'worker_error' : null
    const transition = `${task.historyTurn ?? 0}:${kind}`
    if (kind && task.lastOperatorTransition !== transition) {
      if (scoped) flushStage(task)
      reportOperator(task, kind, { source, diagnostic: details?.diagnostic ?? task.failure,
        ...(details?.diagnostic?.code === 'response_stream_lost' ? { detail: '模型响应流中断' } : {}) })
      task.lastOperatorTransition = transition
      if (kind === 'completed') reviewWhenComplete(task)
    }
    const link = task.messageTurn
    if (!link?.taskId || link.providerTurn !== details?.providerTurn) return
    if (source === 'turn_finished' || source === 'process_exit') {
      concord.linkTask(task, link.messageId, link.taskId, details.taskState ?? task.state)
      task.messageTurn = undefined
    }
  }

  function scheduleWake(task) {
    if (closing || task.wakePaused || task.wakeRunning || !task.pendingWake.size || !task.backend ||
        task.processState === 'exited' || !['running', 'completed', 'waiting_inbox'].includes(task.state)) return
    const [id, signal] = task.pendingWake.entries().next().value
    task.pendingWake.delete(id)
    task.wakeRunning = true
    void (async () => {
      try {
        if (task.state === 'running') {
          const receipt = await task.backend.steer(signal)
          if (!receipt?.submitted && !receipt?.accepted) {
            task.pendingWake.set(id, signal)
            return
          }
          task.autoWake = { id, mode: 'active_signal', at: Date.now() }
          history?.notify(task, id, 'active_signal', receipt.accepted ? 'accepted' : 'submitted')
        } else {
          const waiting = task.state === 'waiting_inbox'
          task.autoWake = { id, mode: waiting ? 'initial_turn' : 'same_session_next_turn', at: Date.now() }
          const input = waiting ? `${task.initialPrompt}\n\n${signal}` : signal
          task.initialPrompt = undefined
          history?.notify(task, id, task.autoWake.mode, 'requested')
          await promptWorker(task, input, id)
        }
      } catch {
        task.diagnostic = 'concord_wake_failed'
        history?.notify(task, id, task.autoWake?.id === id ? task.autoWake.mode : 'active_signal', 'failed')
        reportOperator(task, 'worker_error', { source: 'concord_wake_failed' })
      } finally {
        task.wakeRunning = false
        if (task.state === 'completed') scheduleWake(task)
      }
    })()
  }
  const snapshot = ({ id, group, worker, state, session, turn, output, steering, diagnostic, failure, supervisor, permissions, stoppedByCoordinator, activity, permissionRequests, permissionSummary, permissionMode, agyTurn, selection, peer, autoWake, processState, stopReceipt, parentId, depth, role, concordDiagnostic }) =>
    ({ id, group, worker, state, session, turn, output, steering, diagnostic, failure, supervisor, permissions, stoppedByCoordinator: Boolean(stoppedByCoordinator), activity, permissionRequests, permissionSummary, permissionMode, agyTurn, selection, peer, autoWake, stopReceipt,
      processState, parentId, depth, role, concordDiagnostic, peerReceipts: concord.inbox(id),
    })
  function snapshotForBoard(task) {
    const { peerReceipts, ...result } = snapshot(task)
    return { ...result, approvals: approvals.list(task).map(request => ({ ...request,
      ...(request.status === 'pending' ? { interaction: 'native_prompt' } : {}),
    })) }
  }
  const snapshotWithApprovals = task => ({ ...snapshot(task), approvals: approvals.list(task) })
  function get(id, group) {
    const task = tasks.get(id)
    if (!task || (group && task.group !== group)) throw Error('Unknown task ID in this group')
    return task
  }

  function run(task, operation) {
    void operation().catch(() => {
      if (task.stopRequested && (task.stopping || task.stopReceipt?.sessionReleased)) return
      task.turn = null
      task.state = 'failed'
      task.diagnostic ??= 'worker_start_or_execution_failed'
      observeWorker(task, 'operation_failed')
    })
  }


  async function scopeWorkspace(cwd) {
    const directory = await viaWorkspace(cwd)
    if (project && directory !== project) throw Error('The worker directory is outside this Via project')
    return directory
  }

  async function start({ worker, group, cwd, prompt, session, model, effort, activation, permissions }, parent, supervisor = false) {
    if (!Object.hasOwn(workers, worker)) throw Error('Unknown worker')
    if (permissions && !['full', 'restricted'].includes(permissions)) throw Error('Unknown worker permissions profile')
    if (activation && (worker !== 'agy' || activation !== 'concord')) throw Error('Concord activation requires an Antigravity worker')
    cwd = await scopeWorkspace(cwd)
    const executable = await workerExecutable(worker)
    const id = `${supervisor ? 'supervisor' : worker}-${++workerSequence}`
    const task = { id, worker, cwd, group, prompt, supervisor, state: 'starting', processState: 'unconfirmed', epoch: 0, turn: null, session: null, output: '', lastActivityAt: Date.now(), _watchdogActivityCount: 0 }
    const effectivePermissions = permissions ?? 'full'
    Object.assign(task, { depth: parent ? 2 : 1, parentId: parent?.id ?? null, role: supervisor ? 'supervisor' : parent ? 'leaf' : 'worker', permissions: effectivePermissions })
    const ephemeralCodex = scoped && worker === 'codex' && !session && process.env.VIA_CODEX_PERSIST_THREADS !== '1'
    const preferences = {
      model, effort,
      permissions: effectivePermissions,
      nativePermissions: true,
      ...(ephemeralCodex ? { ephemeral: true } : {}),
      onApproval: approvals.request,
      onConcordCall: approvals.autoApprove,
      onExit: approvals.close,
      onState: observeWorker,
    }
    const candidateRoot = fileURLToPath(new URL('../../', import.meta.url))
    if (process.env.VIA_AGY_TEST_GEMINI_DIR || process.env.VIA_AGY_TEST_SETTINGS) {
      if (!cwd.startsWith(candidateRoot)) throw Error('Fixture settings require a workspace inside the candidate task')
      for (const [variable, target] of [['VIA_AGY_TEST_GEMINI_DIR', 'geminiDir'], ['VIA_AGY_TEST_SETTINGS', 'agySettings']]) {
        if (!process.env[variable]) continue
        const path = await realpath(process.env[variable])
        if (!path.startsWith(candidateRoot)) throw Error('Fixture settings path is outside the candidate task')
        preferences[target] = path
      }
      if (process.env.VIA_AGY_TEST_READ) {
        const path = await realpath(process.env.VIA_AGY_TEST_READ)
        if (!path.startsWith(cwd + '/') || !(await stat(path)).isFile()) throw Error('Fixture read must be a file inside the worker workspace')
        preferences.fixtureRead = path
      }
      preferences.ephemeral = true
    }
    task.ephemeral = Boolean(preferences.ephemeral && !session)
    task.selection = worker === 'codex'
      ? requestedCodexModel(preferences)
      : { requested: { model: model ?? null, effort: effort ?? null }, effective: null, providerConfirmed: null }
    task.pendingWake = new Map()
    task.peer = { enrolled: false, backendReady: false, transport: 'concord' }
    claimNative(task, session)
    try { history?.worker(task, 'dispatch_accepted') }
    catch (error) { releaseNative(task); throw error }
    tasks.set(id, task)
    registerProjectBoard(cwd)
    const stageBrief = scoped ? 'Use Concord report_stage after a real checkpoint is saved or when blocked. Keep it brief and use a stable ID. ' : ''
    const destinationBrief = parent
      ? `Report results and blockers ONLY to your direct parent ${parent.id} via update_work. Do NOT send messages to coordinator or other peers directly.`
      : supervisor
        ? 'Notify coordinator-* with final verified conclusions or unresolved blockers needing Claude/operator decisions.'
        : 'Send intermediate messages only to their actual worker recipients. Notify the coordinator only with final results and evidence, an unresolved blocker, or a direction decision.'
    const concordBrief = `Your Concord agent ID is ${id}. Use the concord MCP tools. To discover peers, call inspect_work with no arguments. For your own inbox use inspect_work with agent_id "${id}". To send, call update_work with operation "prompt", to_agent_id, content, and an idempotency_key. To reply to the original sender, use operation "reply", reply_to_message_id, to_agent_id and content. Set wake_on_reply=true only for a worker request you need to continue your work after the linked reply. Do not reply to replies. ${stageBrief}${destinationBrief} The MCP response contains its data directly. Use the advertised tool arguments and do not open MCP help or instructions files.`
    async function attach(nativeSession, peer, reopening = false) {
      if (task.stopRequested) return
      claimNative(task, nativeSession)
      task.close = undefined
      task.processState = 'unconfirmed'
      try {
        task.backend = await openWorker(task, executable, nativeSession, undefined, peer, () => scheduleWake(task), preferences)
        claimNative(task, task.session)
        if (task.stopRequested) return
        if (reopening) task.stopReceipt = undefined
        task.peer.backendReady = Boolean(task.session)
        task.processState = 'ready'
        history?.worker(task, 'backend_ready')
        if (scoped && !reopening) reportOperator(task,'worker_started',{source:'backend_ready'})
      } catch (error) {
        if (task.processState !== 'exited') await task.close?.()
        if (!task.close || task.processState === 'exited') releaseNative(task)
        throw error
      }
    }
    task.startup = (async () => {
      const coordinator = await ensureCoordinator(task)
      let currentPeer = await concord.enroll(task)
      task.peer.enrolled = true
      history?.worker(task, 'concord_registered')
      task.reopen = async () => {
        if (!task.peer.enrolled) {
          currentPeer = await concord.enroll(task)
          task.peer.enrolled = true
          history?.worker(task, 'concord_registered')
        }
        return attach(task.session, currentPeer, true)
      }
      await attach(session, currentPeer)
      const hierarchyBrief = parent
        ? ` Your direct parent is ${parent.id}. You MUST report only to ${parent.id}. You cannot delegate via spawn_worker, native subagents, swarm agents, or child CLIs.`
        : supervisor
          ? ' You cannot delegate or spawn new workers.'
          : ' You may use Via spawn_worker and child_status for one bounded delegation layer when useful. Any child subagent MUST be spawned through Via spawn_worker (do NOT use native Codex/AGY subagents, swarm agents, or child CLIs) so every subagent is registered and tracked in Via.'
      return `${concordBrief} The verified top-level Via coordinator is ${coordinator.id}.${hierarchyBrief}`
    })().catch(error => {
      if (!task.close || task.processState === 'exited') releaseNative(task)
      throw error
    })
    run(task, async () => {
      const brief = await task.startup
      if (closing || task.stopRequested) return
      if (activation === 'concord') {
        task.initialPrompt = `${prompt}\n\n${brief}`
        task.state = 'waiting_inbox'
        history?.worker(task, 'waiting_for_inbox')
        scheduleWake(task)
        return
      }
      const pending = task.pendingWake.size
      if (pending) {
        const [messageId, signal] = task.pendingWake.entries().next().value
        task.autoWake = { id: messageId, mode: 'initial_turn', at: Date.now() }
        task.pendingWake.clear()
        history?.notify(task, messageId, 'initial_turn', 'requested')
        await promptWorker(task, `${prompt}\n\n${brief}\n\n${signal}`)
      } else {
        await promptWorker(task, `${prompt}\n\n${brief}`)
      }
      scheduleWake(task)
    })
    return snapshot(task)
  }

  const actions = {
    start: uniqueDispatch(start),
    list({group,limit=20}) {
      const selected = group ? history.sessionGroup(group) : (history.latestMailGroup?.() ?? history.sessionGroups()[0])
      if (group && !selected) throw Error('That Via group is outside this session')
      return { group:group ?? selected?.name ?? null, messages:selected ? history.recentMail(selected.cwd,group ?? selected.name,limit) : [] }
    },
    async models({ worker, cwd = project ?? roots }) {
      if (!Object.hasOwn(workers, worker)) throw Error('Unknown worker')
      const directory = await scopeWorkspace(cwd)
      const executable = await workerExecutable(worker)
      if (worker === 'codex') return readCodexModels(executable, directory)
      const models = await listAgyModels(executable, directory)
      return { worker: 'agy', source: 'native_catalog', models }
    },
    async board({ cwd, group, runId: selectedRun, view }) {
      if (view === 'desk' && !cwd) throw Error('Select the current Code project')
      if (selectedRun && (!cwd || !group)) throw Error('Select a project and group for this run')
      if (view === 'desk-projects') {
        if (cwd || group || selectedRun) throw Error('Desk project discovery uses this controller only')
        const known = new Map()
        for (const task of tasks.values()) {
          const item = known.get(task.cwd) ?? { cwd: task.cwd, activeCount: 0 }
          if (working(task) || task.state === 'waiting_inbox') item.activeCount++
          known.set(task.cwd, item)
        }
        return { deskProjects: [...known.values()] }
      }
      if (!cwd && !project) return board.snapshot(group)
      const directory = await scopeWorkspace(cwd ?? project)
      if (view === 'desk' && directory !== (project ?? await realpath(process.cwd()))) throw Error('The desk is limited to the current Code project')
      const runs = group ? history?.runs(directory, group) ?? [] : []
      if (selectedRun && !runs.some(run => run.runId === selectedRun)) throw Error('History run is outside this group')
      const scoped = board.snapshot(group, directory)
      const ambiguous = cwd && group && runs.length > 1 && !selectedRun
      const showLive = !ambiguous && (!selectedRun || selectedRun === runId)
      const slots = group ? history?.avatars(directory, group) : null
      const actor = id => `${runId}:${id}`
      const avatar = id => slots?.get(actor(id)) ?? {}
      return {
        ...scoped,
        tasks: showLive ? scoped.tasks.map(task => ({ ...task, actorId: actor(task.id), runId, ...avatar(task.id) })) : [],
        peerEvents: showLive ? scoped.peerEvents.map(event => ({
          ...event,
          ...(event.summary === undefined ? history?.summaryFor?.(directory, event.group ?? group, event.id) : null),
          fromActorId: actor(event.from), toActorId: actor(event.to),
          fromAvatarUrl: avatar(event.from).avatarUrl, toAvatarUrl: avatar(event.to).avatarUrl,
        })) : [],
        liveAvailable: showLive && scoped.tasks.length > 0,
        historyGroups: history?.groups(directory) ?? [],
        runs,
        ...(group && history && !ambiguous ? { archivedApprovals: history.approvals({ cwd: directory, group, runId: selectedRun }) } : {}),
      }
    },
    async history({ cwd, view, ...scope }) {
      if (!history) throw Error('Via history recording is disabled')
      const directory = await scopeWorkspace(cwd)
      if (view === 'desk' && directory !== (project ?? await realpath(process.cwd()))) throw Error('The desk is limited to the current Code project')
      if (view === 'desk' && !scope.runId) {
        const runs = history.runs(directory, scope.group)
        if (runs.length > 1) throw Error('Select a Via run')
        scope.runId = runs[0]?.runId
      }
      return history.read({ ...scope, cwd: directory })
    },
    async status({ id, group, cwd }) {
      const directory = cwd ? await scopeWorkspace(cwd) : null
      if (!id) return [...tasks.values()].filter(task => (!group || group === task.group) && (!directory || task.cwd === directory)).map(snapshotWithApprovals)
      if (!tasks.has(id) && history && directory && group) {
        const past = history.read({ cwd: directory, group, limit: 1 })
        const member = past.members.find(item => item.actorId === id)
        if (member) return { ...member, group, archived: true, approvals: past.approvals.filter(item => item.actorId === id) }
      }
      const task = get(id, group)
      if (directory && task.cwd !== directory) throw Error('Unknown task ID in this project')
      return snapshotWithApprovals(task)
    },
    steer: ({ id, text, group }) => get(id, group).backend?.steer(text) ?? { accepted: false, reason: 'worker_starting' },
    stop: args => stopTask(args, { byCoordinator: true }),
    followup({ id, text, group }) {
      const task = get(id, group)
      if (task.stopping || working(task) || !task.backend) throw Error('Worker is unavailable for a follow-up')
      const released = task.processState === 'exited' && task.stopReceipt?.sessionReleased
      if (released && task.ephemeral) {
        throw Error('Ephemeral Codex worker sessions are not persisted to Codex history and cannot be reopened after stop; start a new worker instead.')
      }
      if (!released && (task.stopRequested || task.processState !== 'ready')) throw Error('The native session release has not been confirmed')
      if (released) claimNative(task, task.session)
      task.stoppedByCoordinator = false
      task.stopRequested = false
      if (released) {
        task.state = 'starting'
        task.reopening = task.reopen()
        const current = task.reopening
        run(task, async () => {
          try {
            await current
            if (!task.stopRequested && !closing) {
              task.wakePaused = false
              await promptWorker(task,text)
            }
          } finally { if (task.reopening === current) task.reopening = null }
        })
      } else {
        task.wakePaused = false
        run(task, () => promptWorker(task,text))
      }
      return snapshot(task)
    },
    review_approval: ({ id, group, requestId }) => (hostClient()?.elicitation ? reviewThroughHost : reviewLocally)(get(id, group), requestId),
    async coordinator_inbox({ cwd, group }) {
      const directory = await scopeWorkspace(cwd)
      const identity = await coordinators.get(coordinatorKey(directory,group))
      if (!identity) throw Error('No coordinator is enrolled for this project and group in this controller')
      const result = await concord.readCoordinator(identity)
      if (result.isError) throw Error('Coordinator inbox could not be read')
      const inbox = (result.structuredContent?.inbox ?? []).map(item => {
        const sum = history?.summaryFor?.(directory, group, item.messageId)
        return sum ? { ...item, ...sum } : item
      })
      return { coordinatorId:identity.id, inbox }
    },
    peer_read: ({ worker }) => concord.inbox(get(worker).id),
    reminders({ action, desktop }) {
      if (!['open', 'close', 'status'].includes(action)) throw Error('Invalid reminders action')
      if (action === 'open') {
        if (!reminderChannel.open && history) {
          const scopes = new Set([...tasks.values()].map(task => JSON.stringify({ cwd: task.cwd, group: task.group })))
          if (sessionScoped) {
            for (const entry of history.sessionGroups()) scopes.add(JSON.stringify({ cwd: entry.cwd, group: entry.name }))
          }
          for (const key of scopes) {
            const { cwd, group } = JSON.parse(key)
            operatorCursors.set(key, history.head(cwd, group))
          }
        }
        reminderChannel.open = true
        reminderChannel.desktop = desktop !== false
      } else if (action === 'close') {
        reminderChannel.open = false
        reminderChannel.desktop = false
      }
      return { open: reminderChannel.open, desktop: reminderChannel.desktop }
    },
  }

  return {
    async call(name, args) {
      const output = await actions[name](args)
      const result = { content: [{ type: 'text', text: JSON.stringify(output) }] }
      const recent = await operatorBacklog(name, args, output)
      if (recent.length) result.content.push({ type: 'text', text: JSON.stringify({ viaOperatorEvents: recent }) })
      return result
    },
    async close() {
      if (watchdogTimer) clearInterval(watchdogTimer)
      summaries?.close()
      for (const timer of groupReviews.values()) clearTimeout(timer)
      await supervisor?.close()
      for (const task of tasks.values()) clearTimeout(task.stageTimer)
      const stopping = [...tasks.values()].map(task => {
        approvals.close(task)
        return task.close?.()
      })
      await concord.close()
      await Promise.race([Promise.allSettled(stopping), delay(1500, undefined, { ref: false })])
      await Promise.all([...boardRegistrations.values()].map(async pending => (await pending)?.()))
      history?.close()
    },
  }
}

function attachHost(channel, output) {
  const client = { ready: false, send(message) {
    if (!output.destroyed && output.writable) output.write(JSON.stringify(message) + '\n')
  } }
  const send = client.send
  const input = createInterface({ input: channel })
  input.on('close', () => {
    client.ready = false
    unbind(client)
    if (!daemonMode) void close()
  })
  channel.on('error', () => input.close())
  input.on('line', async line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const { id, method, params } = message
    if (id === undefined) {
      if (method === 'notifications/initialized') client.ready = true
      return
    }
    if (!method && hostRequests.get(id)?.client === client) {
      const pending = hostRequests.get(id)
      hostRequests.delete(id)
      pending.complete(message)
      return
    }
    try {
      let result
      if (method === 'initialize') {
        client.elicitation = Boolean(params.capabilities?.elicitation)
        client.name = codexScoped ? 'Codex' : coordinatorHost(params.clientInfo?.name)
        result = { protocolVersion: params.protocolVersion, capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'via-local', version: '0.14.21' } }
      } else if (method === 'logging/setLevel') {
        result = {}
      } else if (method === 'tools/list') {
        result = { tools }
      } else if (method === 'ping') {
        result = {}
      } else if (method === 'tools/call') {
        const tool = tools.find(item => item.name === params.name)
        const input = params.arguments ?? {}
        if (typeof input !== 'object' || Array.isArray(input)) throw Error('Unknown tool or invalid arguments')
        const { _viaClaudeSession, ...args } = input
        if (!tool ||
            !tool.inputSchema.required.every(key => Object.hasOwn(args, key)) ||
            Object.entries(args).some(([key, value]) => {
              if (!Object.hasOwn(tool.inputSchema.properties, key)) return true
              const { type, minimum, maximum = Infinity } = tool.inputSchema.properties[key]
              return type === 'integer' ? !Number.isSafeInteger(value) || value < minimum || value > maximum
                : type === 'boolean' ? typeof value !== 'boolean'
                : typeof value !== 'string' || !value.trim()
            })) {
          throw Error('Unknown tool or invalid arguments')
        }
        if (closing) throw Error('Via controller is closing')
        const controller = await controllerFor(_viaClaudeSession, params._meta?.threadId, client)
        if (closing) throw Error('Via controller is closing')
        result = await controller.call(tool.name, args)
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
        return
      }
      send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      const text = method === 'tools/call' && params?.name === 'steer'
        ? 'The worker did not confirm steering. Check its state before following up.'
        : error.message
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } })
    }
  })

}

async function close() {
  if (closing) return
  closing = true
  for (const pending of hostRequests.values()) pending.complete({})
  hostRequests.clear()
  await Promise.allSettled([...controllers.values()].map(async pending => (await pending).close()))
  process.exit(0)
}
process.once('SIGTERM', close)
if (daemonMode) {
  const { socket } = await daemonPath()
  const existing = await lstat(socket).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (existing && !existing.isSocket()) throw Error('Unrecognized Via controller socket')
  if (existing) await unlink(socket)
  const listener = createServer(channel => attachHost(channel, channel))
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(socket, resolve)
  })
} else {
  attachHost(process.stdin, process.stdout)
}
