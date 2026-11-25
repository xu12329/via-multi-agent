import assert from 'node:assert/strict'
import test from 'node:test'
import { initializePanel, messageStatus, modelOptions, modelRequest, panelApi, registerPanel, unwrapPanelReply } from '../hooks/panel.ts'

const flush = () => new Promise(resolve => setImmediate(resolve))
const envelope = data => ({ result: { content: [{ type: 'text', text: JSON.stringify(data) }] } })

test('native picker preserves Codex and AGY catalog choices independently', () => {
  const codex = modelOptions('codex', {
    models: [
      { id: 'sol', efforts: ['low', 'xhigh'], defaultEffort: 'low' },
      { id: 'astra', efforts: ['high', 'ultra'], defaultEffort: 'high' },
      { id: 'dynamic', efforts: ['provider-new'] },
    ],
  })
  assert.deepEqual(codex.map(model => [model.value, model.efforts.map(choice => choice.value)]), [
    ['sol', ['low', 'xhigh']], ['astra', ['high', 'ultra']], ['dynamic', ['provider-new']],
  ])
  const agy = modelOptions('agy', {
    models: [
      { id: 'gemini-carbon-low', name: 'Gemini Carbon (Low)' },
      { id: 'gemini-carbon-high', name: 'Gemini Carbon (High)' },
      { id: 'gemini-neon-xhigh' },
      { id: 'gemini-orchestrator' },
      { id: 'gemini-orchestrator-neon' },
      { id: 'gpt-oss-120b-medium' },
    ],
  })
  assert.deepEqual(agy.map(model => [model.value, model.efforts.map(choice => choice.value)]), [
    ['gemini-carbon', ['low', 'high']], ['gemini-neon', ['xhigh']],
    ['gemini-orchestrator', ['native']], ['gemini-orchestrator-neon', ['native']], ['gpt-oss-120b', ['medium']],
  ])
  assert.deepEqual(modelRequest('agy', agy.at(-1), 'medium'), { model: 'gpt-oss-120b-medium' })
  assert.deepEqual(modelRequest('agy', agy.at(2), 'native'), { model: 'gemini-orchestrator' })
  assert.equal(modelRequest('agy', agy.at(-1), 'high'), null)
  assert.deepEqual(modelRequest('codex', codex.at(1), 'ultra'), { model: 'astra', effort: 'ultra' })
})

test('tool result parsing rejects MCP errors', () => {
  assert.deepEqual(unwrapPanelReply(envelope({ groups: [] })), { groups: [] })
  assert.throws(() => unwrapPanelReply({ deny: 'unavailable' }), /控制器/)
  assert.throws(() => unwrapPanelReply({ result: { isError: true, content: [{ type: 'text', text: 'rejected' }] } }), /rejected/)
})

test('native command, group scoping, dispatch, steering and follow-up use one existing tool surface', async () => {
  const hooks = new Map()
  const calls = []
  let timer
  let command
  let openPane
  let release
  let releaseBoard
  let releaseReview
  let deferBoard = false
  let invalidations = 0
  let task = { id: 'agy-1', worker: 'agy', group: 'active', state: 'running', turn: '1', prompt: '写一份结果', output: 'worker output',
    selection: { effective: { model: 'gemini-carbon-high', effort: 'high' } } }
  const other = { ...task, id: 'other-2', group: 'other', prompt: '未选定组', output: 'other output' }
  const messages = [{
    id: 'm1', group: 'active', from: 'Codex', to: 'AGY', text: 'worker feedback',
    source: 'worker', sentAt: 100, delivery: 'queued', readAt: 110,
  }, {
    id: 'm2', group: 'other', from: 'Codex', to: 'AGY', text: 'other private feedback',
    source: 'worker', sentAt: 120, delivery: 'queued',
  }]
  const dollars = {
    command: { register(spec) { command = spec } },
    clock: { every(ms, fn) { timer = fn } },
    session: { async id() { return 'local-session' }, async cwd() { return '/workspace' } },
    ui: {
      open(spec) { openPane = spec },
      async panes() { return openPane ? [openPane] : [] },
      invalidate() { invalidations++ },
      resolve() { return Object.fromEntries(['Box', 'Text', 'Button', 'Select', 'Input'].map(type => [type, props => ({ type, ...props })])) },
    },
    tool: {
      async call(input) {
        const { tool, tool_use_id, ...args } = input
        assert.match(tool, /^mcp__plugin_via_workers__/)
        const method = tool.split('__').at(-1)
        calls.push({ method, args })
        if (method === 'board') {
          const report = () => envelope({ groups: ['other', 'active'], tasks: [task, other], peerEvents: messages })
          if (deferBoard) return new Promise(resolve => { releaseBoard = () => resolve(report()) })
          return report()
        }
        if (method === 'models' && args.worker === 'codex') {
          return envelope({ defaults: { model: 'sol', effort: 'xhigh' }, models: [{ id: 'sol', efforts: ['high', 'xhigh'] }, { id: 'astra', efforts: ['high', 'ultra'] }] })
        }
        if (method === 'models') return envelope({ models: [{ id: 'gemini-carbon-low' }, { id: 'gemini-carbon-high' }, { id: 'gemini-neon-xhigh' }] })
        if (method === 'start') return new Promise(resolve => { release = () => resolve(envelope(task)) })
        if (method === 'status') return envelope(task)
        if (method === 'steer') return envelope({ submitted: true })
        if (method === 'followup') return envelope(task)
        if (method === 'review_approval') return new Promise(resolve => { releaseReview = () => resolve(envelope({ status: 'rejected' })) })
        throw Error('Unexpected operation')
      },
    },
  }
  registerPanel((name, match, fn) => hooks.set(name, fn ?? match))
  const next = () => undefined
  await initializePanel(panelApi(dollars))
  assert.equal(command.immediate, true)
  assert.equal(command.name, 'via-panel')
  await hooks.get('command.run')(dollars)
  await flush()
  assert.equal(openPane.title, 'Via 任务组')

  const flatten = node => [node, ...(Array.isArray(node.children) ? node.children.filter(child => typeof child === 'object').flatMap(flatten) : [])]
  const render = async () => hooks.get('ui.render')(dollars, { requestId: 'via-panel', props: { bodyColumns: 66 } }, next)
  const draw = async () => flatten(await render())
  const element = async key => (await draw()).find(entry => entry.key === key)
  const text = async () => (await draw()).filter(entry => entry.type === 'Text').flatMap(entry => entry.children).join('\n')
  assert.ok((await draw()).some(node => node.type === 'Box' && node.flexDirection === 'row'))
  assert.match(await text(), /worker feedback/)
  assert.match(await text(), /已取信/)
  assert.doesNotMatch(await text(), /other private/)
  assert.equal(await element('other-2'), undefined)

  deferBoard = true
  const background = timer()
  await flush()
  ;(await element('dispatch')).onPress()
  await flush()
  assert.equal((await element('model')).value, 'sol')
  const beforeLateBoard = invalidations
  releaseBoard()
  await background
  assert.equal(invalidations, beforeLateBoard, 'an in-flight timer must not redraw the open form')
  deferBoard = false
  ;(await element('task')).onInput('正在输入')
  const previousBoard = calls.filter(call => call.method === 'board').length
  const beforeEditingTick = invalidations
  await timer()
  assert.equal(invalidations, beforeEditingTick)
  assert.equal((await element('task')).value, '正在输入')
  assert.equal(calls.filter(call => call.method === 'board').length, previousBoard, 'no board poll while the form is open')
  task = { ...task, output: 'updated after editing' }
  ;(await element('dispatch')).onPress()
  await flush()
  assert.equal(calls.filter(call => call.method === 'board').length, previousBoard + 1, 'returning to the board refreshes immediately')
  ;(await element('agy-1')).onPress()
  await flush()
  assert.match(await text(), /updated after editing/)
  task = { ...task, output: 'worker output' }
  ;(await element('dispatch')).onPress()
  await flush()
  assert.equal((await element('effort')).value, 'xhigh')
  ;(await element('worker')).onSelect('agy')
  await flush()
  ;(await element('effort')).onSelect('high')
  ;(await element('model')).onSelect('gemini-neon')
  assert.equal((await element('effort')).value, 'xhigh')
  ;(await element('task')).onSubmit('执行新任务')
  assert.equal(calls.filter(call => call.method === 'start').length, 0)
  const start = (await element('start')).onPress
  const pending = start()
  await start()
  await flush()
  const starts = calls.filter(call => call.method === 'start')
  assert.equal(starts.length, 1)
  assert.ok(starts[0].args.requestId)
  assert.deepEqual({ ...starts[0].args, requestId: undefined }, {
    worker: 'agy', group: 'active', cwd: '/workspace', prompt: '执行新任务',
    model: 'gemini-neon-xhigh', requestId: undefined,
  })
  release()
  await pending
  await flush()
  assert.match(await text(), /worker output/)
  ;(await element('instruction')).onInput('原回合纠偏')
  await (await element('send')).onPress()
  assert.deepEqual(calls.find(call => call.method === 'steer').args, { id: 'agy-1', group: 'active', text: '原回合纠偏' })
  assert.match(await text(), /插话已提交/)

  task = { ...task, state: 'completed', turn: null }
  await timer()
  assert.equal((await element('send')).label, '开始续聊')
  ;(await element('instruction')).onInput('继续任务')
  await (await element('send')).onPress()
  assert.deepEqual(calls.find(call => call.method === 'followup').args, { id: 'agy-1', group: 'active', text: '继续任务' })

  task = { ...task, state: 'running', turn: '2', approvals: [{
    requestId: 'bound-request', action: 'execute', scope: 'project_cwd', status: 'pending', interaction: 'native_prompt',
  }, {
    requestId: 'native-inspect-replayed', action: 'concord_inbox', scope: 'group_concord', status: 'allowed_once',
  }, {
    requestId: 'native-update-replayed', action: 'concord_reply', scope: 'group_concord', status: 'allowed_once',
  }] }
  await timer()
  assert.match(await text(), /执行终端命令 · 等待审批/)
  assert.match(await text(), /Concord 取信 · 已允许一次/)
  assert.match(await text(), /Concord 回复 · 已允许一次/)
  assert.match(await text(), /仅限当前组的 Concord 工具/)
  assert.equal(await element('send'), undefined, 'do not show a steer action over a pending approval')
  const pressReview = (await element('review-bound-request')).onPress
  const pendingReview = pressReview()
  await pressReview()
  await flush()
  assert.deepEqual(calls.filter(call => call.method === 'review_approval'), [{
    method: 'review_approval', args: { id: 'agy-1', group: 'active', requestId: 'bound-request' },
  }])
  task.approvals[0].status = 'rejected'
  releaseReview()
  await pendingReview
  assert.equal(await element('review-bound-request'), undefined)
  assert.match(await text(), /执行终端命令 · 已拒绝/)

  openPane = undefined
  const begins = calls.length
  await timer()
  assert.equal(calls.length, begins)
  await hooks.get('command.run')(dollars)
  await flush()
  assert.ok(openPane)
  assert.ok(await element('agy-1'))
})


test('Concord reply receipt and delivery state never imply the other worker read it', () => {
  assert.equal(messageStatus({ delivery: 'read', readAt: 1 }), '已取信')
  assert.equal(messageStatus({ delivery: 'replied', readAt: 1 }), '已取信 · 收到关联回信')
  assert.equal(messageStatus({ delivery: 'sent', replyTo: 'first-message' }), '关联回信 · 已入库，等待投递 · 接收会话尚未取信')
  assert.equal(messageStatus({ delivery: 'read', replyTo: 'first-message', readAt: 2 }), '关联回信 · 已取信')
  assert.equal(messageStatus({ delivery: 'sent' }), '已入库，等待投递')
  assert.equal(messageStatus({ delivery: 'unknown-value' }), '状态未确认')
})

test('panel renders unreadCoordinatorCount notice, coordinator markers, and distinct AI summaries', async () => {
  const hooks = new Map()
  const messages = [{
    id: 'm-coord-unread',
    group: 'active',
    from: 'codex-1',
    to: 'coordinator-1',
    text: 'Full detailed completion report for Claude',
    summary: '简洁汇报：任务已完成并验证通过',
    summaryStatus: 'ready',
    forCoordinator: true,
    source: 'concord',
    sentAt: 1000,
    delivery: 'queued',
  }, {
    id: 'm-coord-read',
    group: 'active',
    from: 'agy-2',
    to: 'coordinator-1',
    text: 'Exact short message',
    summary: 'Exact short message',
    summaryStatus: 'ready',
    source: 'concord',
    sentAt: 2000,
    delivery: 'read',
    readAt: 2100,
  }]
  const dollars = {
    command: { register() {} },
    clock: { every() {} },
    session: { async id() { return 'coord-session' }, async cwd() { return '/workspace' } },
    ui: {
      open() {},
      async panes() { return [{ id: 'via-panel' }] },
      invalidate() {},
      resolve() { return Object.fromEntries(['Box', 'Text', 'Button', 'Select', 'Input'].map(type => [type, props => ({ type, ...props })])) },
    },
    tool: {
      async call(input) {
        if (input.tool.endsWith('__board')) {
          return envelope({ groups: ['active'], tasks: [], peerEvents: messages, unreadCoordinatorCount: 1 })
        }
        throw Error('Unexpected tool ' + input.tool)
      },
    },
  }
  registerPanel((name, match, fn) => hooks.set(name, fn ?? match))
  await initializePanel(panelApi(dollars))
  await hooks.get('command.run')(dollars)
  await flush()

  const flatten = node => [node, ...(Array.isArray(node.children) ? node.children.filter(child => typeof child === 'object').flatMap(flatten) : [])]
  const tree = await hooks.get('ui.render')(dollars, { requestId: 'via-panel', props: { bodyColumns: 66 } }, () => undefined)
  const renderedText = flatten(tree).filter(entry => entry.type === 'Text').flatMap(entry => entry.children).join('\n')

  assert.match(renderedText, /待 Claude 查看汇报：1 条（使用 coordinator_inbox 或 list 读取）/)
  assert.match(renderedText, /\[待Claude查看\]/)
  assert.match(renderedText, /摘要：简洁汇报：任务已完成并验证通过/)
  assert.match(renderedText, /Full detailed completion report for Claude/)
  assert.match(renderedText, /\[给Claude\]/)
  assert.doesNotMatch(renderedText, /摘要：Exact short message/)
})

test('panel renders [监管] and [叶代理] role badges for supervisor and depth-2 leaves', async () => {
  const hooks = new Map()
  const tasks = [{
    id: 'codex-1', worker: 'codex', group: 'active', state: 'running', turn: '1', role: 'worker', depth: 1,
    prompt: '主任务', selection: { effective: { model: 'gpt-6.3-sol', effort: 'high' } }, peer: { enrolled: true, backendReady: true },
  }, {
    id: 'codex-2', worker: 'codex', group: 'active', state: 'completed', turn: null, role: 'leaf', depth: 2, parentId: 'codex-1',
    prompt: '子代理任务', selection: { effective: { model: 'gpt-6.3-sol', effort: 'medium' } }, peer: { enrolled: true, backendReady: true },
  }, {
    id: 'supervisor-3', worker: 'codex', group: 'active', state: 'running', turn: '1', role: 'supervisor', supervisor: true, depth: 1,
    prompt: '监管监控', selection: { effective: { model: 'gpt-6.3-sol', effort: 'medium' } }, peer: { enrolled: true, backendReady: true },
  }]
  const dollars = {
    command: { register() {} },
    clock: { every() {} },
    session: { async id() { return 'role-session' }, async cwd() { return '/workspace' } },
    ui: {
      open() {},
      async panes() { return [{ id: 'via-panel' }] },
      invalidate() {},
      resolve() { return Object.fromEntries(['Box', 'Text', 'Button', 'Select', 'Input'].map(type => [type, props => ({ type, ...props })])) },
    },
    tool: {
      async call(input) {
        if (input.tool.endsWith('__board')) return envelope({ groups: ['active'], tasks, peerEvents: [] })
        if (input.tool.endsWith('__status')) return envelope(tasks[0])
        throw Error('Unexpected tool ' + input.tool)
      },
    },
  }
  registerPanel((name, match, fn) => hooks.set(name, fn ?? match))
  await initializePanel(panelApi(dollars))
  await hooks.get('command.run')(dollars)
  await flush()

  const flatten = node => [node, ...(Array.isArray(node.children) ? node.children.filter(child => typeof child === 'object').flatMap(flatten) : [])]
  const tree = await hooks.get('ui.render')(dollars, { requestId: 'via-panel', props: { bodyColumns: 66 } }, () => undefined)
  const buttons = flatten(tree).filter(entry => entry.type === 'Button')
  const supButton = buttons.find(btn => btn.key === 'supervisor-3')
  const leafButton = buttons.find(btn => btn.key === 'codex-2')
  const workerButton = buttons.find(btn => btn.key === 'codex-1')
  assert.match(supButton?.label ?? '', /supervisor-3 · \[监管\]/)
  assert.match(leafButton?.label ?? '', /codex-2 · \[叶代理 ← codex-1\]/)
  assert.doesNotMatch(workerButton?.label ?? '', /\[监管\]|\[叶代理/)
})
