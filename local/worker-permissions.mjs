import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'

const kinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])

export function permissionSummary(params, session) {
  const call = params?.toolCall
  return {
    currentSession: params?.sessionId === session,
    callIdPresent: typeof call?.toolCallId === 'string',
    allowOncePresent: Array.isArray(params?.options) && params.options.some(option => option?.kind === 'allow_once'),
    kind: kinds.has(call?.kind) ? call.kind : 'unknown',
  }
}

export function silentCompletion(output, denied, tools) {
  if (output?.trim()) return null
  if (denied) return { state: 'permission_required', diagnostic: 'approval_not_granted' }
  const statuses = [...tools.values()]
  if (statuses.includes('failed')) return { state: 'failed', diagnostic: 'tool_failed_without_assistant_text' }
  if (statuses.includes('completed')) return { state: 'completed', diagnostic: 'tool_completed_without_assistant_text' }
  return { state: 'failed', diagnostic: 'no_assistant_output_or_tool_result' }
}

const concordActions = new Map([
  ['inspect_work', 'concord_inbox'],
  ['update_work', 'concord_messaging'],
  ['concord_send', 'concord_send'],
  ['concord_reply', 'concord_reply'],
])

const codexActions = new Map([
  ['item/commandExecution/requestApproval', 'execute'],
  ['item/fileChange/requestApproval', 'edit'],
  ['item/permissions/requestApproval', 'permissions'],
])

const commandNames = new Set('awk bash cat chmod cp curl echo env ffmpeg find git grep head jq kill ls make mkdir mv node npm npx perl pnpm printf ps python python3 rg rm sed sh sleep sort sqlite3 tail tar tee touch tr uv wc which xargs yarn zsh'.split(' '))
const gitActions = new Set('add branch checkout diff fetch log merge rebase remote show status switch'.split(' '))
const safeFlags = new Map([
  ['git status', new Set(['-s', '-b', '--short', '--long', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--branch', '--show-stash'])],
  ['git diff', new Set(['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary', '--cached', '--staged', '--check'])],
  ['git log', new Set(['--oneline', '--graph', '--decorate', '--no-decorate', '--all', '--stat'])],
  ['node', new Set(['--test', '--check', '--version'])],
  ['python', new Set(['--version'])],
  ['python3', new Set(['--version'])],
])

function safeTestTarget(target, cwd) {
  if (!cwd || typeof target !== 'string' || target.length > 100 ||
      target.startsWith('-') || /(?:^|[\/_.-])(?:token|secret|password|passwd|credential|authorization|id_rsa)(?:$|[\/_.-])/i.test(target) ||
      !/^(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.test\.(?:[cm]?js|ts)$/i.test(target) ||
      target.split('/').includes('..')) return false
  try {
    const root = realpathSync(cwd)
    const file = realpathSync(resolve(cwd, target))
    return file.startsWith(root + sep) && statSync(file).isFile()
  } catch { return false }
}

function commandEvidence(command, cwd) {
  let executable, args, partial = false
  if (Array.isArray(command) && command.length <= 1000 && command.every(value => typeof value === 'string')) {
    [executable, ...args] = command
  } else if (typeof command === 'string' && command.length <= 16000) {
    const match = /^\s*((?:[A-Za-z_]\w*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]+)\s+)*)([\w./+-]+)(?:\s+|$)/.exec(command)
    if (match) {
      executable = match[2]
      const tail = command.slice(match[0].length).trim()
      const compound = /[\r\n;|&<>`$]/.test(command)
      args = !compound && tail ? tail.split(/[ \t]+/) : []
      partial = Boolean(match[1]) || compound
    }
  }
  const name = executable && basename(executable)
  if (!commandNames.has(name)) return { actionDetail: 'unavailable' }
  const words = [name]
  if (name === 'git' && gitActions.has(args[0])) words.push(args.shift())
  const flags = safeFlags.get(words.join(' '))
  while (flags?.has(args[0]) && words.length < 8) words.push(args.shift())
  if (name === 'node' && words.includes('--test') && safeTestTarget(args[0], cwd)) words.push(args.shift())
  // Stop at the first unknown token rather than guessing whether it consumes later arguments.
  partial ||= executable !== name || args.length > 0
  return { actionText: words.join(' ') + (partial ? ' …' : ''), actionDetail: partial ? 'partial' : 'observed' }
}

function requestShape(task, worker, method, params) {
  if (task.worker !== worker || !task.id || !task.group || !task.session || !['running', 'peer_action'].includes(task.state)) return null
  if (worker === 'agy' && method === 'session/request_permission' && params?.sessionId === task.session) {
    const call = params.toolCall
    if (!task.turn || typeof call?.toolCallId !== 'string' || !call.toolCallId) return null
    const options = Array.isArray(params.options) ? params.options : []
    const find = kind => options.filter(option => option?.kind === kind && typeof option.optionId === 'string' && option.optionId)
    const select = option => ({ outcome: { outcome: 'selected', optionId: option.optionId } })
    const once = find('allow_once')
    const reject = find('reject_once')
    return {
      nativeId: call.toolCallId,
      action: kinds.has(call.kind) ? call.kind : 'unknown',
      ...(call.kind === 'execute' ? commandEvidence(call.rawInput?.command) : {}),
      scope: 'unknown',
      once: once?.length === 1 ? select(once[0]) : null,
      reject: reject?.length === 1 ? select(reject[0]) : null,
      expire: { outcome: { outcome: 'cancelled' } },
      abort: { outcome: { outcome: 'cancelled' } },
    }
  }
  if (worker === 'codex' && codexActions.has(method) && params?.threadId === task.session &&
      task.turn && params.turnId === task.turn && typeof params.itemId === 'string' && params.itemId) {
    const action = codexActions.get(method)
    const cwd = typeof params.cwd === 'string' && resolve(params.cwd) === resolve(task.cwd) ? 'project_cwd' : 'unknown'
    if (action === 'permissions') {
      return {
        nativeId: params.itemId,
        action,
        scope: 'unknown',
        once: null,
        reject: { permissions: {}, scope: 'turn' },
        expire: { permissions: {}, scope: 'turn' },
        abort: { permissions: {}, scope: 'turn' },
      }
    }
    const options = params.availableDecisions
    const supports = value => Array.isArray(options) ? options.includes(value) : options == null
    return {
      nativeId: params.approvalId ?? params.itemId,
      action,
      scope: cwd,
      ...(action === 'execute' ? commandEvidence(params.command, cwd === 'project_cwd' ? task.cwd : undefined) : {}),
      once: supports('accept') ? { decision: 'accept' } : null,
      reject: supports('decline') ? { decision: 'decline' } : null,
      expire: { decision: supports('decline') ? 'decline' : supports('cancel') ? 'cancel' : 'decline' },
      abort: { decision: supports('cancel') ? 'cancel' : 'decline' },
    }
  }
  return null
}

export function createApprovalQueue({ timeoutMs = 90_000, now = Date.now, onPending = () => {}, onState = () => {} } = {}) {
  const histories = new WeakMap()
  const pending = new Map()

  function finish(entry, status, native) {
    if (!pending.delete(entry.snapshot.requestId)) return
    clearTimeout(entry.timer)
    entry.snapshot.status = status
    entry.snapshot.resolvedAt = now()
    entry.resolve(native)
    onState(entry.task, { ...entry.snapshot })
  }

  function apply(entry, decision, concordTool) {
    const { task, snapshot, shape } = entry
    if (snapshot.expiresAt <= now()) {
      finish(entry, 'expired', shape.expire ?? shape.abort)
      throw Error('Approval request expired')
    }
    if (entry.id !== task.id || entry.group !== task.group || entry.session !== task.session || entry.turn !== task.turn ||
        !['running', 'peer_action'].includes(task.state)) {
      finish(entry, 'cancelled', shape.abort)
      throw Error('Approval request is no longer active')
    }
    if (decision === 'allow_once' && shape.once) {
      const action = entry.method === 'session/request_permission' && shape.action === 'other'
        ? concordActions.get(concordTool) : undefined
      if (action) {
        snapshot.action = action
        snapshot.scope = 'group_concord'
      }
      return finish(entry, 'allowed_once', shape.once)
    }
    if (decision === 'reject') return finish(entry, shape.reject ? 'rejected' : 'cancelled', shape.reject ?? shape.abort)
    throw Error('Native approval option unavailable')
  }

  function request(task, { worker, method, params, automaticOption, automaticConcordTool }) {
    const shape = requestShape(task, worker, method, params)
    if (!shape) {
      if (worker === 'agy' && method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
      if (worker === 'codex' && method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
      if (worker === 'codex' && method.endsWith('/requestApproval')) return { decision: 'decline' }
      return undefined
    }
    let history = histories.get(task)
    if (!history) histories.set(task, history = [])
    const duplicate = history.find(entry => entry.session === task.session &&
      entry.turn === task.turn && entry.method === method && entry.shape.nativeId === shape.nativeId)
    if (duplicate) return shape.abort
    const snapshot = {
      requestId: randomUUID(), worker, action: shape.action, scope: shape.scope, status: 'pending',
      createdAt: now(), allowOnce: Boolean(shape.once), expiresAt: now() + timeoutMs,
      ...(shape.actionText ? { actionText: shape.actionText } : {}),
      ...(shape.actionDetail ? { actionDetail: shape.actionDetail } : {}),
    }
    let settle
    const response = new Promise(resolveRequest => { settle = resolveRequest })
    const entry = { task, id: task.id, group: task.group, session: task.session, turn: task.turn, method, shape, snapshot, resolve: settle }
    history.push(entry)
    pending.set(snapshot.requestId, entry)
    entry.timer = setTimeout(() => finish(entry, 'expired', shape.expire ?? shape.abort), timeoutMs)
    entry.timer.unref?.()
    if (automaticOption === 'allow_once' && shape.once) apply(entry, 'allow_once', automaticConcordTool)
    else Promise.resolve().then(() => {
      if (pending.has(snapshot.requestId)) {
        onState(task, { ...snapshot })
        return onPending({ ...snapshot, id: entry.id, group: entry.group })
      }
    }).catch(() => {})
    return response
  }

  function decide({ id, group, requestId, decision }) {
    const entry = pending.get(requestId)
    if (!entry || entry.id !== id || entry.group !== group) throw Error('Approval request is unavailable for this task group')
    apply(entry, decision)
    return { ...entry.snapshot }
  }

  function autoApprove(task, callId, concordTool) {
    for (const entry of pending.values()) {
      if (entry.task !== task || entry.shape.nativeId !== callId || entry.method !== 'session/request_permission' || !entry.shape.once) continue
      try { apply(entry, 'allow_once', concordTool); return true } catch { return false }
    }
    return false
  }

  function close(task, reason = 'cancelled') {
    for (const entry of pending.values()) {
      if (entry.task === task) finish(entry, reason === 'expired' ? 'expired' : 'cancelled', reason === 'expired' ? (entry.shape.expire ?? entry.shape.abort) : entry.shape.abort)
    }
  }

  function list(task) {
    return (histories.get(task) ?? []).slice(-40).map(({ snapshot }) => ({ ...snapshot }))
  }

  return { request, decide, autoApprove, close, list }
}
