import assert from 'node:assert/strict'
import test from 'node:test'
import { openWorker, workerEnv } from './backend.mjs'

const task = worker => ({ worker, cwd: '/test', state: 'starting', epoch: 0 })
function mock(respond) {
  const calls = []
  let listeners
  return {
    calls,
    transport(command, args, options, handlers) {
      listeners = handlers
      calls.push(['spawn', { command, args }])
      return {
        async request(method, params) {
          calls.push([method, params])
          if (method === 'config/read') return { config: { model: 'gpt-6.1-sol' } }
          if (method === 'model/list') return { data: [
            { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', supportedReasoningEfforts: ['low', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) },
            { id: 'gpt-6.2-astra', model: 'gpt-6.2-astra', supportedReasoningEfforts: ['high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) },
          ] }
          const result = await respond(method, params)
          if ((method === 'thread/start' || method === 'thread/resume') && result?.thread) {
            return { model: params.model, reasoningEffort: params.config.model_reasoning_effort, ...result }
          }
          return result
        },
        notify(method, params) { calls.push([method, params]) },
        close() {},
      }
    },
    emit(method, params) { listeners.notify(method, params) },
    ask(method, params) { return listeners.handle(method, params) },
  }
}

test('Codex steering requires the active native turn and follow-up keeps the thread', async () => {
  const worker = task('codex')
  let count = 0
  const protocol = mock((method, params) => {
    if (method === 'thread/start') return { thread: { id: 'thread' } }
    if (method === 'turn/start') return { turn: { id: `turn-${++count}` } }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId }
    return {}
  })
  const backend = await openWorker(worker, '/bin/mock', undefined, protocol.transport)
  await backend.prompt('start')
  assert.deepEqual(worker.selection.effective, { model: 'gpt-6.1-sol', effort: 'xhigh' })
  assert.deepEqual(protocol.calls.at(-1)[1], {
    threadId: 'thread', input: [{ type: 'text', text: 'start' }], model: 'gpt-6.1-sol', effort: 'xhigh',
  })
  assert.deepEqual(await backend.steer('during'), { accepted: true, turn: 'turn-1' })
  assert.deepEqual(protocol.calls.at(-1), ['turn/steer', {
    threadId: 'thread', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'during' }],
  }])
  protocol.emit('turn/completed', { threadId: 'thread', turn: { id: 'other', status: 'completed' } })
  assert.equal(worker.state, 'running')
  protocol.emit('model/rerouted', { threadId: 'other', turnId: 'turn-1', fromModel: 'x', toModel: 'y' })
  assert.equal(worker.selection.routing, undefined)
  protocol.emit('model/rerouted', { threadId: 'thread', turnId: 'turn-1', fromModel: 'x', toModel: 'y' })
  assert.deepEqual(worker.selection.routing, { fromModel: 'x', toModel: 'y' })
  protocol.emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn-1', delta: 'result' })
  protocol.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } })
  assert.equal(worker.state, 'completed')
  assert.deepEqual(await backend.steer('idle'), { accepted: false, reason: 'no_active_turn' })
  await backend.prompt('follow up')
  assert.equal(protocol.calls.at(-1)[1].threadId, 'thread')
  assert.equal(protocol.calls.at(-1)[1].effort, 'xhigh')
  assert.equal(worker.turn, 'turn-2')
  assert.equal(worker.selection.routing, undefined)
})

test('Antigravity dispatch acknowledges before the concurrent ACP prompt resolves', async () => {
  const worker = task('agy')
  let finish
  let finishSteer
  const protocol = mock((method, params) => {
    if (method === 'session/prompt') {
      const initial = params.prompt[0].text === 'start'
      return new Promise(resolve => {
        if (initial) finish = resolve
        else finishSteer = resolve
      })
    }
    return {}
  })
  const backend = await openWorker(worker, '/bin/mock', 'conversation', protocol.transport)
  assert.ok(protocol.calls.some(([method]) => method === 'session/resume'))
  const active = backend.prompt('start')
  const steer = await backend.steer('during')
  assert.equal(steer.submitted, true)
  assert.equal(steer.sameTurnVerified, false)
  assert.equal(worker.steering.state, 'submitted')
  assert.equal(protocol.calls.at(-1)[1].sessionId, 'conversation')
  assert.equal(worker.state, 'running')
  assert.deepEqual(worker.activity, { messages: 0, toolUpdates: 0 })
  protocol.emit('session/update', { sessionId: 'conversation', update: { sessionUpdate: 'tool_call' } })
  assert.equal(worker.activity.toolUpdates, 1)
  finishSteer({ stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(worker.steering.state, 'end_turn')
  assert.equal(worker.steering.originalStillOutstandingAtResponse, true)
  protocol.emit('session/update', { sessionId: 'conversation', update: {
    sessionUpdate: 'agent_message_chunk', content: { text: 'result' },
  } })
  finish({ stopReason: 'end_turn' })
  await active
  assert.equal(worker.state, 'completed')
  assert.equal((await backend.steer('idle')).accepted, false)
})

test('worker environment keeps path and scoped config without inheriting credentials or proxy env, and honors VIA_PROXY', () => {
  assert.deepEqual(workerEnv({ USER: 'user', OPENAI_API_KEY: 'key', HTTPS_PROXY: 'proxy', CLAUDE_CONFIG_DIR: '/tmp/c' }, '/test', '/tools/mock'), {
    HOME: '/test', USER: 'user', PATH: '/tools:/test/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  })
  assert.deepEqual(workerEnv({ USER: 'user', VIA_PROXY: 'http://127.0.0.1:8080' }, '/test', '/tools/mock'), {
    HTTP_PROXY: 'http://127.0.0.1:8080', HTTPS_PROXY: 'http://127.0.0.1:8080',
    ALL_PROXY: 'http://127.0.0.1:8080', NO_PROXY: 'localhost,127.0.0.1,::1',
    HOME: '/test', USER: 'user', PATH: '/tools:/test/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  })
})

test('Antigravity keeps the session busy when the first ACP response hands off to pending steering', async () => {
  const worker = task('agy')
  const pending = []
  const protocol = mock(method => {
    if (method === 'session/new') return { sessionId: 'session' }
    if (method === 'session/prompt') return new Promise(resolve => pending.push(resolve))
    return {}
  })
  const backend = await openWorker(worker, '/bin/mock', undefined, protocol.transport)
  const original = backend.prompt('start')
  await backend.steer('midturn')
  pending[0]({ stopReason: 'end_turn' })
  await original
  assert.equal(worker.state, 'running')
  assert.equal(worker.agyTurn.original.stopReason, 'end_turn')
  assert.equal((await backend.steer('late')).reason, 'original_prompt_ended')
  protocol.emit('session/update', { sessionId: 'session', update: {
    sessionUpdate: 'agent_message_chunk', content: { text: 'second request output' },
  } })
  assert.equal(worker.agyTurn.messageChunksAfterOriginal, 1)
  pending[1]({ stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(worker.state, 'completed')
  assert.equal(worker.steering.originalStillOutstandingAtResponse, false)
})

test('Codex auto-approval is restricted to the isolated peer server and just its two tools', async () => {
  const worker = task('codex')
  const protocol = mock(method => method === 'thread/start' ? { thread: { id: 'thread' } } : {})
  await openWorker(worker, '/bin/mock', undefined, protocol.transport, { command: '/bin/probe', args: [], env: {} })
  const settings = protocol.calls.find(([method]) => method === 'thread/start')[1]
  assert.equal(settings.approvalPolicy, 'on-request')
  assert.equal(settings.sandbox, 'workspace-write')
  assert.deepEqual(settings.config.mcp_servers.via_peer.enabled_tools, ['send', 'read', 'peers'])
  assert.deepEqual(settings.config.mcp_servers.via_peer.tools, {
    send: { approval_mode: 'approve' }, read: { approval_mode: 'approve' }, peers: { approval_mode: 'approve' },
  })
})

test('Antigravity retains sandbox and declines unrelated approval requests', async () => {
  const worker = task('agy')
  const protocol = mock(method => method === 'session/new' ? { sessionId: 'session' } : {})
  await openWorker(worker, '/bin/mock', undefined, protocol.transport)
  const launch = protocol.calls[0][1]
  assert.deepEqual(launch.args.slice(-2), ['acp', '--sandbox'])
  assert.ok(!launch.args.includes('--settings'))
  const response = protocol.ask('session/request_permission', {
    sessionId: 'session', toolCall: { toolCallId: 'test' },
    options: [{ kind: 'allow_once', optionId: 'once' }],
  })
  assert.deepEqual(response, { outcome: { outcome: 'cancelled' } })
})

test('AGY assistant stream assembles split actions and excludes tool content', async () => {
  const worker = task('agy')
  const outputs = []
  let finish
  const protocol = mock(method => {
    if (method === 'session/new') return { sessionId: 'session' }
    if (method === 'session/prompt') return new Promise(resolve => { finish = resolve })
    return {}
  })
  const backend = await openWorker(worker, '/bin/mock', undefined, protocol.transport, null, value => outputs.push(value))
  const prompt = backend.prompt('task')
  const update = (sessionUpdate, text) => protocol.emit('session/update', {
    sessionId: 'session', update: { sessionUpdate, content: { text } },
  })
  update('tool_call_update', 'VIA_PEER {"action":"send","to":"codex","text":"untrusted"}')
  update('agent_message_chunk', 'VIA_PE')
  update('agent_message_chunk', 'ER {"action":"read"}')
  finish({ stopReason: 'end_turn' })
  await prompt
  assert.deepEqual(outputs, [{ turn: '1', assistantText: 'VIA_PEER {"action":"read"}' }])
})

test('Codex supports listed Astra and explicit effort without a second policy gate', async () => {
  const worker = task('codex')
  const protocol = mock(method => method === 'thread/resume' ? { thread: { id: 'previous' } } :
    method === 'turn/start' ? { turn: { id: 'turn' } } : {})
  const backend = await openWorker(worker, '/bin/mock', 'previous', protocol.transport, null, undefined, {
    model: 'astra', effort: 'high',
  })
  await backend.prompt('test')
  const resume = protocol.calls.find(([method]) => method === 'thread/resume')[1]
  assert.equal(resume.model, 'gpt-6.2-astra')
  assert.equal(resume.config.model_reasoning_effort, 'high')
  assert.deepEqual(worker.selection.requested, { model: 'astra', effort: 'high' })
  assert.deepEqual(worker.selection.effective, { model: 'gpt-6.2-astra', effort: 'high' })
  assert.equal(worker.selection.providerConfirmed, null)
  assert.equal(protocol.calls.at(-1)[1].model, 'gpt-6.2-astra')
  assert.equal(protocol.calls.at(-1)[1].effort, 'high')
})

test('Codex rejects unknown or unsupported selections before opening a thread', async () => {
  for (const [preferences, diagnostic] of [
    [{ model: 'unknown' }, 'unsupported_model'],
    [{ model: 'astra', effort: 'low' }, 'unsupported_effort'],
  ]) {
    const worker = task('codex')
    const protocol = mock(() => ({}))
    await assert.rejects(openWorker(worker, '/bin/mock', undefined, protocol.transport, null, undefined, preferences))
    assert.equal(worker.diagnostic, diagnostic)
    assert.ok(!protocol.calls.some(([method]) => method.startsWith('thread/') || method.startsWith('turn/')))
  }
})

test('Codex refuses to prompt if native readback disagrees with the requested settings', async () => {
  const worker = task('codex')
  const protocol = mock(method => method === 'thread/start' ? {
    model: 'gpt-6.2-astra', reasoningEffort: 'low', thread: { id: 'thread' },
  } : {})
  await assert.rejects(openWorker(worker, '/bin/mock', undefined, protocol.transport))
  assert.equal(worker.diagnostic, 'selection_mismatch')
  assert.ok(!protocol.calls.some(([method]) => method === 'turn/start'))
})

test('AGY explicit model selection happens before prompting and is retained across a follow-up', async () => {
  const worker = task('agy')
  let selected = 'initial-model'
  let effort = 'medium'
  function modelConfig() {
    return {
      configOptions: [
        { id: 'model', currentValue: selected, options: [{ value: 'initial-model' }, { value: 'deeper-model' }] },
        { id: 'thought_level', currentValue: effort, options: [{ value: 'medium' }, { value: 'ultra' }] },
      ],
    }
  }
  const protocol = mock((method, params) => {
    if (method === 'session/new') return { sessionId: 'session', ...modelConfig() }
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') selected = params.value
      if (params.configId === 'thought_level') effort = params.value
      return modelConfig()
    }
    if (method === 'session/prompt') return { stopReason: 'end_turn' }
    return {}
  })
  const backend = await openWorker(worker, '/bin/mock', undefined, protocol.transport, null, undefined, {
    model: 'deeper-model', effort: 'ultra',
  })
  await backend.prompt('first')
  await backend.prompt('follow-up')
  assert.deepEqual(worker.selection.effective, { model: 'deeper-model-ultra', effort: 'ultra' })
  assert.deepEqual(protocol.calls.filter(([method]) => method.startsWith('session/')).map(([method]) => method), [
    'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt', 'session/prompt',
  ])
})

test('AGY completion distinguishes declined approval, genuine cancellation, completed tool work and empty turns', async () => {
  const worker = task('agy')
  let finish
  const protocol = mock(method => {
    if (method === 'session/new') return { sessionId: 'session' }
    if (method === 'session/prompt') return new Promise(resolve => { finish = resolve })
    return {}
  })
  const backend = await openWorker(worker, '/bin/mock', undefined, protocol.transport)
  const denied = backend.prompt('requires permission')
  assert.deepEqual(protocol.ask('session/request_permission', {
    sessionId: 'session', toolCall: { toolCallId: 'blocked-tool', kind: 'execute' },
    options: [{ kind: 'allow_once', optionId: 'once' }],
  }), { outcome: { outcome: 'cancelled' } })
  finish({ stopReason: 'end_turn' })
  await denied
  assert.equal(worker.state, 'permission_required')
  assert.equal(worker.diagnostic, 'approval_not_granted')
  assert.equal(worker.permissionSummary.kind, 'execute')

  const cancelled = backend.prompt('cancelled')
  finish({ stopReason: 'cancelled' })
  await cancelled
  assert.equal(worker.state, 'cancelled')

  const executed = backend.prompt('tool-only result')
  protocol.emit('session/update', { sessionId: 'session', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'performed-tool', status: 'completed',
  } })
  finish({ stopReason: 'end_turn' })
  await executed
  assert.equal(worker.state, 'completed')
  assert.equal(worker.diagnostic, 'tool_completed_without_assistant_text')

  const empty = backend.prompt('empty result')
  finish({ stopReason: 'end_turn' })
  await empty
  assert.equal(worker.state, 'failed')
  assert.equal(worker.diagnostic, 'no_assistant_output_or_tool_result')
})

test('AGY requests only native workspace-edit mode when the worker starts in default mode', async () => {
  for (const current of ['default', 'plan', 'auto']) {
    const worker = task('agy')
    const protocol = mock(method => method === 'session/new' ? {
      sessionId: 'session', modes: { currentModeId: current, availableModes: [{ id: 'accept-edits' }] },
    } : {})
    await openWorker(worker, '/bin/mock', undefined, protocol.transport)
    const request = protocol.calls.find(([method]) => method === 'session/set_mode')
    assert.deepEqual(request, current === 'default'
      ? ['session/set_mode', { sessionId: 'session', modeId: 'accept-edits' }] : undefined)
  }
})

test('Codex worker declines MCP server elicitation requests instead of rejecting with unsupported request', async () => {
  const worker = task('codex')
  const protocol = mock(method => (method === 'thread/start' ? { thread: { id: 'thread' } } : {}))
  await openWorker(worker, '/bin/mock', undefined, protocol.transport)
  const response = await protocol.ask('mcpServer/elicitation/request', {
    threadId: 'thread', serverName: 'demo', mode: 'form', message: 'approve?',
  })
  assert.deepEqual(response, { action: 'decline' })
})

test('Codex disables native subagent delegation at depth 1, depth 2, and supervisor so children route through Via', async () => {
  for (const workerSpec of [
    { ...task('codex'), depth: 1 },
    { ...task('codex'), depth: 2 },
    { ...task('codex'), depth: 1, supervisor: true },
  ]) {
    const protocol = mock(method => (method === 'thread/start' ? { thread: { id: 'codex-thread' } } : {}))
    await openWorker(workerSpec, '/bin/mock', undefined, protocol.transport)
    const start = protocol.calls.find(([method]) => method === 'thread/start')[1]
    assert.equal(start.config.features.multi_agent, false)
    assert.equal(start.config.features.multi_agent_v2, false)
    assert.equal(start.config.agents.enabled, false)
  }
})
