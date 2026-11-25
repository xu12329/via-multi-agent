import { nativeFailure } from './native-failure.mjs'
import { concordFailure } from './concord-diagnostic.mjs'
import { permissionSummary, silentCompletion } from './worker-permissions.mjs'
import { selectAgy } from './agy-selection.mjs'
import { agyLaunch } from './agy-environment.mjs'
import { confirmedCodexPolicy, savedCodexPolicy } from './codex-permissions.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { codexModelOptions, requestedCodexModel, validateCodexSelection } from './codex-selection.mjs'
import { connect } from './rpc.mjs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export function workerEnv(env, home, command) {
  const clean = { HOME: home, PATH: [dirname(command), join(home, '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':') }
  for (const key of ['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']) {
    if (env[key]) clean[key] = env[key]
  }
  const proxy = env.VIA_PROXY
  if (proxy) {
    return { ...clean, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: env.VIA_NO_PROXY || 'localhost,127.0.0.1,::1' }
  }
  return clean
}

export async function readCodexModels(command, cwd, transport = connect) {
  const rpc = transport(command, ['app-server'], { cwd, env: workerEnv(process.env, homedir(), command) }, {
    notify() {},
    handle() { throw Error('Model catalog does not handle worker requests') },
    exit() {},
  })
  try {
    await rpc.request('initialize', { clientInfo: { name: 'via-local', version: '0.1.0' } })
    rpc.notify('initialized', {})
    return await codexModelOptions(rpc, cwd)
  } finally {
    rpc.close()
  }
}

export async function openWorker(task, command, startingSession, transport = connect, peer = null, onAgyComplete = () => {}, preferences = {}) {
  const home = homedir()
  task.activity = { messages: 0, toolUpdates: 0 }
  const codex = task.worker === 'codex'
  const profile = preferences.permissions ?? (startingSession ? 'inherit' : 'restricted')
  const fullAccess = profile === 'full'
  let stopInProgress
  let transportExited = false
  let closingForStop = false
  let finishStoppedTurn
  const tools = new Map()
  const trustedConcordCalls = new Map()
  const concordNames = new Map([
    ['mcp_concord_inspect_work', 'inspect_work'], ['concord/inspect_work', 'inspect_work'],
    ['mcp_concord_update_work', 'update_work'], ['concord/update_work', 'update_work'],
  ])
  function fixtureRead(call) {
    if (!preferences.fixtureRead || call?.kind !== 'read' || typeof call.toolCallId !== 'string' ||
        !Array.isArray(call.locations) || call.locations.length !== 1) return false
    let path = call.locations[0]?.path
    if (typeof path !== 'string') return false
    if (path.startsWith('file:')) {
      try { path = fileURLToPath(path) } catch { return false }
    }
    return path === preferences.fixtureRead
  }
  function exactConcord(call) {
    if (peer?.name !== 'concord' || call?.kind !== 'other' || typeof call?.toolCallId !== 'string') return
    for (const name of [call.title, call.toolName, call.name, call._meta?.toolName, call._meta?.tool_name]) {
      if (concordNames.has(name)) return concordNames.get(name)
    }
  }
  let denied = 0
  function stopSilent() {
    if (task.state !== 'completed') return
    const outcome = silentCompletion(task.output, denied, tools)
    if (outcome) Object.assign(task, outcome)
  }
  function settleStop(turn, nativeState) {
    const receipt = task.stopReceipt
    if (receipt?.turn !== turn || receipt?.state !== 'submitted') return
    receipt.state = ['interrupted', 'cancelled', 'canceled'].includes(nativeState) ? 'stopped' : 'finished'
    receipt.nativeState = nativeState
    finishStoppedTurn?.()
  }
  function notify(method, params) {
    if (transportExited) return
    if (method === 'turn/started' && params.threadId === task.session) {
      task.turn = params.turn.id
      preferences.onState?.(task, 'turn_started')
    }
    if (method === 'model/rerouted' && codex && params.threadId === task.session && params.turnId === task.turn) {
      task.selection.routing = { fromModel: params.fromModel, toModel: params.toModel }
    }
    if (method === 'turn/completed' && params.threadId === task.session && params.turn.id === task.turn) {
      task.state = params.turn.status
      task.failure = task.state === 'failed' ? nativeFailure(params.turn.error) : undefined
      settleStop(task.turn, task.state)
      stopSilent()
      preferences.onExit?.(task)
      task.turn = null
      preferences.onState?.(task, 'turn_finished', { providerTurn: params.turn.id, diagnostic: task.failure })
    }
    if (method === 'item/agentMessage/delta' && params.threadId === task.session && params.turnId === task.turn) {
      task.activity.messages += 1
      task.output += params.delta
    }
    if (codex && method === 'item/completed' && params.threadId === task.session && params.turnId === task.turn) {
      const item = params.item
      if (item?.type === 'mcpToolCall' && item.server === 'concord' && (item.status === 'failed' || item.error)) {
        concordFailure(task,item.tool,item.error ?? item.result)
      }
      if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item?.type)
          && ['completed', 'failed'].includes(item.status)) tools.set(item.id, item.status)
    }
    const update = params?.update
    if (method === 'session/update' && params.sessionId === task.session) {
      if (update?.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
        task.permissionMode = { ...task.permissionMode, effective: update.currentModeId }
      }
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
        task.activity.messages += 1
        task.output += update.content.text
        if (task.agyTurn) {
          const section = task.agyTurn.original ? 'messageChunksAfterOriginal' : 'messageChunksBeforeOriginal'
          task.agyTurn[section] = (task.agyTurn[section] ?? 0) + 1
        }
      }
      if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
        task.activity.toolUpdates += 1
        const concordTool = exactConcord(update)
        if ((concordTool || fixtureRead(update)) && task.state === 'running') {
          trustedConcordCalls.set(update.toolCallId, concordTool)
          if (!preferences.nativePermissions) preferences.onConcordCall?.(task, update.toolCallId, concordTool)
        }
        if (update.toolCallId && ['completed', 'failed'].includes(update.status)) {
          tools.set(update.toolCallId, update.status)
        }
      }
    }
  }

  function diagnose(text) {
    if (/(?:already (?:locked|open|in use)|lock is held|failed to lock|unable to acquire.{0,40} lock)/i.test(text)) task.diagnostic = 'native_session_in_use'
    else if (/(?:\b403\b|\bforbidden\b)/i.test(text)) task.diagnostic = 'access_denied'
    else if (/(?:unauthenticated|authentication failed|token.*(?:failed|expired))/i.test(text)) task.diagnostic ??= 'authentication'
  }

  const agyArgs = [
    ...(preferences.agySettings ? ['--settings', preferences.agySettings] : []),
    'acp', ...(profile === 'inherit' ? [] : [fullAccess ? '--dangerously-skip-permissions' : '--sandbox']),
    ...(preferences.geminiDir ? ['--gemini-dir', preferences.geminiDir] : []),
  ]
  const launch = codex
    ? { command, args: ['app-server'], env: workerEnv(process.env, home, command) }
    : agyLaunch(command, agyArgs)
  const rpc = transport(launch.command, launch.args, { cwd: task.cwd, env: launch.env }, {
    notify,
    diagnose,
    handle(method, params) {
      if (method === 'session/request_permission') {
        task.permissionRequests = (task.permissionRequests || 0) + 1
        task.permissionSummary = permissionSummary(params, task.session)
        if (task.state === 'running' && task.permissionSummary.currentSession && !fullAccess && preferences.onApproval) {
          const call = params.toolCall
          const automaticConcordTool = exactConcord(call) ?? trustedConcordCalls.get(call?.toolCallId)
          const automaticOption = !preferences.nativePermissions && (automaticConcordTool || fixtureRead(call) || trustedConcordCalls.has(call?.toolCallId)) ? 'allow_once' : undefined
          const pending = preferences.onApproval(task, { worker: 'agy', method, params, automaticOption, automaticConcordTool })
          if (pending) return Promise.resolve(pending).then(result => {
            if (result.outcome?.outcome !== 'selected') denied++
            return result
          })
        }
        if (task.state === 'running' && task.permissionSummary.currentSession) denied++
        return { outcome: { outcome: 'cancelled' } }
      }
      if (method.endsWith('/requestApproval')) {
        if (task.state === 'running' && params?.threadId === task.session) {
          const pending = !fullAccess && preferences.onApproval?.(task, { worker: 'codex', method, params })
          if (pending) return Promise.resolve(pending).then(result => {
            if (result.decision === 'decline') denied++
            return result
          })
          denied++
        }
        return { decision: 'decline' }
      }
      if (codex && method === 'mcpServer/elicitation/request') {
        return { action: 'decline' }
      }
      throw Error('Unsupported worker request')
    },
    exit(evidence) {
      transportExited = true
      preferences.onExit?.(task)
      const receipt = task.stopReceipt
      if (receipt && (closingForStop || task.stopRequested) && evidence?.confirmed) {
        receipt.sessionReleased = true
        if (receipt.state === 'submitted' || receipt.state === 'release_unconfirmed') receipt.state = 'stopped'
        if (['starting','running','waiting_inbox'].includes(task.state)) task.state = 'stopped'
        finishStoppedTurn?.()
      } else if (['starting','running'].includes(task.state)) {
        task.state = 'failed'
        task.failure = { code: evidence?.confirmed ? 'worker_process_exited' : 'worker_exit_unconfirmed' }
      }
      task.processState = evidence?.confirmed ? 'exited' : 'unconfirmed'
      const providerTurn = task.turn
      task.turn = null
      preferences.onState?.(task, evidence?.confirmed ? 'process_exit' : 'process_error', { ...evidence, providerTurn, diagnostic: task.failure })
    },
  })
  const closeOwnedWorker = async () => {
    rpc.close({ graceful:true })
    return Promise.race([rpc.whenClosed, delay(preferences.closeGraceMs ?? 2500, null, { ref:false })])
  }
  task.close = closeOwnedWorker
  function finishAgy(phase, stopReason) {
    if (transportExited) return
    const attempt = task.agyTurn
    attempt[phase] = { stopReason, receivedAt: Date.now() }
    if (!attempt.original || (attempt.steerSent && !attempt.steer)) return
    const finalReason = (attempt.steer?.stopReason === 'rejected' ? null : attempt.steer?.stopReason) ?? attempt.original.stopReason
    task.state = finalReason === 'end_turn' ? 'completed' : finalReason || 'failed'
    const interrupted = [attempt.original.stopReason, attempt.steer?.stopReason]
      .find(reason => ['cancelled', 'canceled'].includes(reason))
    if (task.stopReceipt?.turn === attempt.turn && interrupted) task.state = interrupted
    settleStop(attempt.turn, task.state)
    stopSilent()
    preferences.onExit?.(task)
    task.turn = null
    const originalReason = attempt.original.stopReason
    preferences.onState?.(task, 'turn_finished', {
      providerTurn: attempt.turn,
      ...(attempt.steer ? { taskState: originalReason === 'end_turn' ? 'completed' : originalReason || 'failed' } : {}),
    })
    if (task.state === 'completed') onAgyComplete({ turn: attempt.turn, assistantText: task.output })
  }

  const content = text => [{ type: 'text', text }]
  const managed = { cwd:task.cwd }
  if (codex) task.selection ??= requestedCodexModel(preferences)
  const mcpServers = peer ? [{
    type: 'stdio',
    name: peer.name ?? 'via_peer',
    command: peer.command,
    args: peer.args,
    env: Object.entries(peer.env).map(([name, value]) => ({ name, value })),
  }] : []
  try {
    if (codex) {
      await rpc.request('initialize', { clientInfo: { name: 'via-local', version: '0.1.0' } })
      rpc.notify('initialized', {})
      const unavailable = await validateCodexSelection(rpc, task.selection, task.cwd)
      if (unavailable) {
        task.diagnostic = unavailable
        throw Error('Unsupported Codex selection')
      }
      const { model, effort } = task.selection.selected
      const saved = startingSession && !fullAccess ? await savedCodexPolicy(rpc, startingSession) : null
      const inherited = profile === 'inherit' ? (saved ?? task.codexPolicy) : null
      const permission = inherited ?? (profile === 'inherit' ? {} : {
        approvalPolicy:fullAccess ? 'never' : 'on-request', approvalsReviewer:'user',
        sandbox:fullAccess ? 'danger-full-access' : saved?.sandbox === 'read-only' ? 'read-only' : 'workspace-write',
        ...(!fullAccess && saved?.sandbox !== 'read-only' ? {
          config:{ sandbox_workspace_write:{ writable_roots:[], network_access:false, exclude_tmpdir_env_var:false, exclude_slash_tmp:false } },
        } : {}),
      })
      Object.assign(managed, permission)
      managed.model = model
      if (preferences.ephemeral && !startingSession) managed.ephemeral = true
      managed.config = { ...permission.config, model_reasoning_effort:effort }
      managed.config.features = { ...(managed.config.features ?? {}), multi_agent: false, multi_agent_v2: false }
      managed.config.agents = { ...(managed.config.agents ?? {}), enabled: false }
      if (peer) managed.config.mcp_servers = { [peer.name ?? 'via_peer']: {
        command: peer.command, args: peer.args, env: peer.env,
        enabled_tools: peer.toolNames ?? (peer.name === 'concord' ? ['inspect_work', 'update_work'] : ['send', 'read', 'peers']),
        ...(!preferences.nativePermissions ? { tools: Object.fromEntries((peer.name === 'concord' ? ['inspect_work', 'update_work'] : ['send', 'read', 'peers'])
          .map(name => [name, { approval_mode: 'approve' }])) } : {}),
      } }
      const session = startingSession
        ? await rpc.request('thread/resume', { ...managed, threadId: startingSession })
        : await rpc.request('thread/start', managed)
      task.session = session.thread.id
      if ((inherited || (preferences.nativePermissions && session.sandbox)) && !confirmedCodexPolicy(permission, session)) {
        task.diagnostic = 'permission_profile_mismatch'
        throw Error('Codex did not restore the saved permission settings')
      }
      if (session.model !== model || session.reasoningEffort !== effort) {
        task.diagnostic = 'selection_mismatch'
        throw Error('Codex did not apply the requested model and effort')
      }
      task.selection.effective = { model: session.model, effort: session.reasoningEffort }
      task.selection.nativeConfirmed = true
      if (inherited) task.codexPolicy = inherited
      if (preferences.nativePermissions) {
        task.permissionMode = {
          requested:profile, effective:session.sandbox?.type ?? null,
          approvalPolicy: session.approvalPolicy ?? null,
        }
      }
    } else {
      await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const session = startingSession
        ? await rpc.request('session/resume', { sessionId: startingSession, cwd: task.cwd, mcpServers })
        : await rpc.request('session/new', { cwd: task.cwd, mcpServers })
      task.session = session.sessionId ?? startingSession
      if (!task.session) throw Error('Worker session identity mismatch')
      const modes = session.modes
      if (preferences.nativePermissions) task.permissionMode = {
        requested:profile, effective:modes?.currentModeId ?? null,
        nativePermissionFlag: fullAccess ? 'dangerously-skip-permissions' : profile === 'restricted' ? 'sandbox' : null,
      }
      if (profile === 'restricted' && modes?.currentModeId === 'default' && modes.availableModes?.some(mode => mode.id === 'accept-edits')) {
        // Native permission rules still apply. Only workspace edits change from the default review mode.
        task.permissionMode = { ...task.permissionMode, requested: task.permissionMode?.requested ?? 'accept-edits', effective: modes.currentModeId }
        const changed = await rpc.request('session/set_mode', { sessionId: task.session, modeId: 'accept-edits' })
        if (changed?.currentModeId === 'accept-edits') task.permissionMode.effective = changed.currentModeId
      }
      try {
        task.selection = await selectAgy(rpc, task.session, session, preferences)
      } catch (error) {
        task.diagnostic = 'agy_selection_unavailable'
        throw error
      }
    }
    if (!task.session || (startingSession && task.session !== startingSession)) throw Error('Worker session identity mismatch')
  } catch (error) {
    await closeOwnedWorker()
    throw error
  }

  return {
    async prompt(text) {
      task.output = ''
      tools.clear()
      trustedConcordCalls.clear()
      denied = 0
      if (['approval_not_granted', 'tool_failed_without_assistant_text', 'tool_completed_without_assistant_text', 'no_assistant_output_or_tool_result'].includes(task.diagnostic)) task.diagnostic = undefined
      task.activity = { messages: 0, toolUpdates: 0 }
      task.state = 'running'
      preferences.onState?.(task, 'turn_requested')
      task.steering = undefined
      if (codex) {
        task.selection.routing = undefined
        const { model, effort } = task.selection.effective
        const result = await rpc.request('turn/start', { threadId: task.session, input: content(text), model, effort })
        if (task.state === 'running') task.turn = result.turn.id
      } else {
        task.turn = String(++task.epoch)
        task.agyTurn = { sentAt: Date.now(), turn: task.turn }
        try {
          const result = await rpc.request('session/prompt', { sessionId: task.session, prompt: content(text) })
          finishAgy('original', result.stopReason)
        } catch {
          finishAgy('original', 'failed')
        }
      }
    },
    async stop(expectedTurnId) {
      const turn = task.turn
      const old = task.stopReceipt
      if (expectedTurnId && expectedTurnId !== turn) {
        if (old?.turn === expectedTurnId) return stopInProgress ?? { ...old }
        return { state:'stale_turn', turn }
      }
      if (stopInProgress) return stopInProgress
      if ((!turn || old?.turn === turn) && old?.sessionReleased) return { ...old }
      const receipt = closingForStop && old ? old : { state:'submitted', turn, sessionReleased:false }
      receipt.state = 'submitted'
      task.stopReceipt = receipt
      closingForStop = true
      task.wakePaused = true
      preferences.onExit?.(task)
      stopInProgress = (async () => {
        if (turn && task.state === 'running') {
          const terminal = new Promise(resolve => { finishStoppedTurn = resolve })
          const cancel = async () => {
            if (codex) await rpc.request('turn/interrupt', { threadId:task.session, turnId:turn })
            else rpc.notify('session/cancel', { sessionId:task.session })
            await terminal
          }
          await Promise.race([cancel().catch(() => null), delay(preferences.stopGraceMs ?? 1000, null, { ref:false })])
        }
        const evidence = await closeOwnedWorker()
        receipt.sessionReleased = Boolean(evidence?.confirmed)
        if (!receipt.sessionReleased) receipt.state = 'release_unconfirmed'
        else if (receipt.state === 'submitted') receipt.state = 'stopped'
        return { ...receipt }
      })()
      try { return await stopInProgress }
      finally { stopInProgress = null; finishStoppedTurn = null }
    },
    async steer(text) {
      if (transportExited || closingForStop || task.state !== 'running' || !task.turn || task.stopReceipt?.state === 'submitted') return { accepted: false, reason: 'no_active_turn' }
      const active = task.turn
      if (codex) {
        const result = await rpc.request('turn/steer', {
          threadId: task.session, expectedTurnId: active, input: content(text),
        })
        return { accepted: result.turnId === active, turn: result.turnId }
      }
      // Antigravity ACP steers through a second prompt on the same live session.
      if (task.agyTurn.original) return { accepted: false, reason: 'original_prompt_ended' }
      if (task.steering?.state === 'submitted') return { accepted: false, reason: 'steering_in_flight' }
      const receipt = { method: 'session/prompt', overlappingTurn: active, session: task.session, state: 'submitted', sameTurnVerified: false }
      task.steering = receipt
      task.agyTurn.steer = undefined
      task.agyTurn.steerSent = Date.now()
      void rpc.request('session/prompt', { sessionId: task.session, prompt: content(text) }).then(result => {
        receipt.state = result.stopReason
        receipt.originalStillOutstandingAtResponse = !task.agyTurn.original
        finishAgy('steer', result.stopReason)
      }, () => {
        receipt.state = 'rejected'
        finishAgy('steer', 'rejected')
      })
      return { submitted: true, turn: active, method: receipt.method, sameTurnVerified: false }
    },
    close: rpc.close,
  }
}
