import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalQueue } from './worker-permissions.mjs'

const agy = () => ({ id: 'agy-1', group: 'group-1', worker: 'agy', state: 'running', session: 'native-a', turn: '1', cwd: '/fixture' })
const agyRequest = (overrides = {}) => ({
  worker: 'agy', method: 'session/request_permission', params: {
    sessionId: 'native-a',
    toolCall: { toolCallId: 'call', title: 'untrusted display', kind: 'execute', rawInput: { privateValue: 'must-not-leak' } },
    options: [
      { kind: 'allow_always', optionId: 'always' },
      { kind: 'allow_once', optionId: 'native-once' },
      { kind: 'reject_once', optionId: 'native-refuse' },
    ],
    ...overrides,
  },
})
const selected = optionId => ({ outcome: { outcome: 'selected', optionId } })
const cancelled = { outcome: { outcome: 'cancelled' } }
const coords = (task, requestId) => ({ id: task.id, group: task.group, requestId })

test('ACP holds the original response, returns only the original exact once option and hides raw data', async () => {
  const events = []
  const queue = createApprovalQueue({ onPending: request => events.push(request) })
  const task = agy()
  let settled = false
  const answer = Promise.resolve(queue.request(task, agyRequest())).then(value => { settled = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  const [request] = queue.list(task)
  assert.equal(settled, false)
  assert.equal(events.length, 1)
  assert.equal(request.status, 'pending')
  assert.equal(request.scope, 'unknown')
  assert.doesNotMatch(JSON.stringify(request), /must-not-leak|native-once|native-a|untrusted display/)
  assert.throws(() => queue.decide({ ...coords(task, request.requestId), group: 'other', decision: 'allow_once' }))
  assert.throws(() => queue.decide({ ...coords(task, request.requestId), id: 'other', decision: 'allow_once' }))
  assert.throws(() => queue.decide({ ...coords(task, request.requestId), decision: 'allow_always' }))
  queue.decide({ ...coords(task, request.requestId), decision: 'allow_once' })
  assert.deepEqual(await answer, selected('native-once'))
  assert.equal(queue.list(task)[0].status, 'allowed_once')
  assert.throws(() => queue.decide({ ...coords(task, request.requestId), decision: 'reject' }))
  assert.deepEqual(await queue.request(task, agyRequest()), cancelled)
})

test('reject, native disconnect, expiry and turn change remain distinct and cannot later be approved', async () => {
  let now = 1
  const queue = createApprovalQueue({ now: () => now })
  const task = agy()
  let result = queue.request(task, agyRequest())
  let [request] = queue.list(task)
  queue.decide({ ...coords(task, request.requestId), decision: 'reject' })
  assert.deepEqual(await result, selected('native-refuse'))
  assert.equal(queue.list(task)[0].status, 'rejected')
  task.turn = '2'
  result = queue.request(task, agyRequest())
  request = queue.list(task).at(-1)
  now = request.expiresAt
  assert.throws(() => queue.decide({ ...coords(task, request.requestId), decision: 'allow_once' }), /expired/)
  assert.deepEqual(await result, cancelled)
  assert.equal(queue.list(task).at(-1).status, 'expired')
  task.turn = '3'
  result = queue.request(task, agyRequest())
  request = queue.list(task).at(-1)
  task.turn = '4'
  assert.throws(() => queue.decide({ ...coords(task, request.requestId), decision: 'allow_once' }), /no longer active/)
  assert.deepEqual(await result, cancelled)
  assert.equal(queue.list(task).at(-1).status, 'cancelled')
  result = queue.request(task, agyRequest())
  queue.close(task)
  assert.deepEqual(await result, cancelled)
  assert.equal(queue.list(task).at(-1).status, 'cancelled')
})

test('only the exact observed AGY tool call can receive a later automatic approval', async () => {
  const queue = createApprovalQueue()
  const task = agy()
  assert.deepEqual(await queue.request(task, agyRequest({ sessionId: 'wrong' })), cancelled)
  assert.equal(queue.list(task).length, 0)
  const answer = queue.request(task, agyRequest())
  assert.equal(queue.autoApprove(agy(), 'call'), false)
  assert.equal(queue.autoApprove(task, 'other'), false)
  assert.equal(queue.autoApprove(task, 'call'), true)
  assert.deepEqual(await answer, selected('native-once'))
})

test('Codex native reject/once options are respected; permission escalation payloads are never granted', async () => {
  const queue = createApprovalQueue()
  const task = { ...agy(), worker: 'codex' }
  const params = { threadId: task.session, turnId: task.turn, itemId: 'item-1', cwd: task.cwd, command: 'private' }
  const request = method => queue.request(task, { worker: 'codex', method, params })
  const cmd = request('item/commandExecution/requestApproval')
  let approval = queue.list(task).at(-1)
  assert.equal(approval.scope, 'project_cwd')
  assert.doesNotMatch(JSON.stringify(approval), /private|item-1/)
  queue.decide({ ...coords(task, approval.requestId), decision: 'allow_once' })
  assert.deepEqual(await cmd, { decision: 'accept' })
  const escalated = request('item/permissions/requestApproval')
  approval = queue.list(task).at(-1)
  assert.equal(approval.allowOnce, false)
  assert.throws(() => queue.decide({ ...coords(task, approval.requestId), decision: 'allow_once' }))
  queue.decide({ ...coords(task, approval.requestId), decision: 'reject' })
  assert.deepEqual(await escalated, { permissions: {}, scope: 'turn' })
})


test('verified Concord tools classify only their own actual native approvals', async () => {
  const queue = createApprovalQueue()
  const task = agy()
  const observed = () => agyRequest({ toolCall: { toolCallId: 'call', kind: 'other' } })
  const direct = {
    ...observed(), automaticOption: 'allow_once', automaticConcordTool: 'inspect_work',
  }
  await queue.request(task, direct)
  assert.equal(queue.list(task).at(-1).action, 'concord_inbox')
  assert.equal(queue.list(task).at(-1).scope, 'group_concord')

  task.turn = '2'
  const late = queue.request(task, observed())
  assert.equal(queue.autoApprove(task, 'call', 'concord_reply'), true)
  await late
  assert.equal(queue.list(task).at(-1).action, 'concord_reply')
  assert.equal(queue.list(task).at(-1).scope, 'group_concord')

  task.turn = '3'
  await queue.request(task, { ...agyRequest(), automaticOption: 'allow_once' })
  assert.equal(queue.list(task).at(-1).action, 'execute')
  assert.equal(queue.list(task).at(-1).scope, 'unknown')

  task.turn = '4'
  const unknown = queue.request(task, agyRequest())
  assert.equal(queue.list(task).at(-1).scope, 'unknown')
  queue.close(task)
  await unknown
  assert.equal(queue.list(task).at(-1).scope, 'unknown')
})

test('Codex command approvals decline on expiry when supported while cancel/stop remains abort', async () => {
  let now = 1
  const queue = createApprovalQueue({ timeoutMs: 25, now: () => now })
  const task = { ...agy(), worker: 'codex' }
  const params = extra => ({ threadId: task.session, turnId: task.turn, itemId: 'item-exp', cwd: task.cwd, command: 'ls', ...extra })

  const timedOut = queue.request(task, { worker: 'codex', method: 'item/commandExecution/requestApproval', params: params() })
  let [approval] = queue.list(task)
  now = approval.expiresAt
  assert.throws(() => queue.decide({ ...coords(task, approval.requestId), decision: 'allow_once' }), /expired/)
  assert.deepEqual(await timedOut, { decision: 'decline' })
  assert.equal(queue.list(task).at(-1).status, 'expired')

  task.turn = '2'
  const closeExpired = queue.request(task, { worker: 'codex', method: 'item/commandExecution/requestApproval', params: params() })
  queue.close(task, 'expired')
  assert.deepEqual(await closeExpired, { decision: 'decline' })
  assert.equal(queue.list(task).at(-1).status, 'expired')

  task.turn = '3'
  const onlyCancel = queue.request(task, {
    worker: 'codex', method: 'item/commandExecution/requestApproval',
    params: params({ availableDecisions: ['accept', 'cancel'] }),
  })
  queue.close(task, 'expired')
  assert.deepEqual(await onlyCancel, { decision: 'cancel' })

  task.turn = '4'
  const stopped = queue.request(task, { worker: 'codex', method: 'item/commandExecution/requestApproval', params: params() })
  queue.close(task)
  assert.deepEqual(await stopped, { decision: 'cancel' })
  assert.equal(queue.list(task).at(-1).status, 'cancelled')
})
