import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalQueue } from './worker-permissions.mjs'
import { createOperatorReview } from './operator-review.mjs'

test('only an operator response can release an exact pending ACP request', async () => {
  const approvals = createApprovalQueue()
  const task = { id: 'agy-1', group: 'alpha', worker: 'agy', state: 'running', session: 'native-1', turn: '1' }
  const request = toolCallId => approvals.request(task, { worker:'agy', method:'session/request_permission', params: {
    sessionId: 'native-1', toolCall: { toolCallId, kind: 'read' },
    options: [{ kind: 'allow_once', optionId: 'native-once' }, { kind: 'reject_once', optionId: 'native-deny' }],
  } })
  let release
  let called = 0
  const review = createOperatorReview({ approvals, elicit(message, canAllow) {
    called++
    assert.match(message, /alpha requests read/)
    assert.equal(canAllow, true)
    return new Promise(resolve => { release = resolve })
  } })
  const waiting = request('one')
  const id = approvals.list(task)[0].requestId
  const reviewed = review(task, id)
  await assert.rejects(review(task, id), /already/)
  await assert.rejects(review({ ...task, group: 'beta' }, id), /unavailable/)
  assert.equal(called, 1)
  assert.equal(approvals.list(task)[0].status, 'pending')
  release('allow_once')
  assert.equal((await reviewed).status, 'allowed_once')
  assert.deepEqual(await waiting, { outcome: { outcome: 'selected', optionId: 'native-once' } })

  const denied = request('two')
  const id2 = approvals.list(task)[1].requestId
  const deniedReview = review(task, id2)
  release('reject')
  assert.equal((await deniedReview).status, 'rejected')
  assert.deepEqual(await denied, { outcome: { outcome: 'selected', optionId: 'native-deny' } })
})
