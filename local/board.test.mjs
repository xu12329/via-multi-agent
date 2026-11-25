import assert from 'node:assert/strict'
import test from 'node:test'
import { createBoard } from './board.mjs'
import { uniqueDispatch } from './dispatch.mjs'

test('boards isolate controllers, groups, and cwds while tracking coordinator unread counts and receipts', () => {
  const tasks = new Map([
    ['codex-1', { id: 'codex-1', cwd: '/proj-a', group: 'one', prompt: 'real task', output: 'its output' }],
    ['agy-2', { id: 'agy-2', cwd: '/proj-a', group: 'one', output: 'its own reply' }],
    ['agy-3', { id: 'agy-3', cwd: '/proj-a', group: 'two' }],
    ['codex-4', { id: 'codex-4', cwd: '/proj-b', group: 'one', output: 'other cwd' }],
  ])
  const board = createBoard(tasks, task => ({ id: task.id, group: task.group }))
  const other = createBoard(new Map(), task => task)

  board.message({ id: 'm1', cwd: '/proj-a', group: 'one', from: 'codex-1', to: 'agy-2', text: 'peer msg', sentAt: 10, source: 'concord' }, 'queued')
  board.message({ id: 'm2', cwd: '/proj-a', group: 'one', from: 'agy-2', to: 'coordinator-1', text: 'final report', sentAt: 20, source: 'concord' }, 'queued')
  board.message({ id: 'm3', cwd: '/proj-a', group: 'two', from: 'agy-3', to: 'coordinator-2', text: 'group two', sentAt: 30, source: 'concord' }, 'queued')

  const before = board.snapshot('one', '/proj-a')
  assert.deepEqual(before.groups, ['one', 'two'])
  assert.equal(before.tasks.length, 2)
  assert.equal(before.tasks[0].prompt, 'real task')
  assert.equal(before.tasks[0].output, 'its output')
  assert.equal(before.unreadCoordinatorCount, 1)
  assert.deepEqual(before.peerEvents.map(event => [event.id, event.forCoordinator, event.delivery, event.readAt]), [
    ['m1', false, 'queued', undefined],
    ['m2', true, 'queued', undefined],
  ])

  board.receipt({ kind: 'worker_delivery', worker: 'agy-2', status: 'delivered', messages: ['m1'] }, 100)
  board.receipt({ kind: 'worker_read', worker: 'wrong-worker', messages: ['m2'] }, 111)
  assert.equal(board.snapshot('one', '/proj-a').unreadCoordinatorCount, 1)

  board.receipt({ kind: 'worker_read', worker: 'coordinator-1', messages: ['m2'] }, 123)
  const after = board.snapshot('one', '/proj-a')
  assert.equal(after.unreadCoordinatorCount, 0)
  assert.equal(after.peerEvents[0].delivery, 'delivered')
  assert.equal(after.peerEvents[1].readAt, 123)
  assert.equal(before.controllerId, after.controllerId)
  assert.notEqual(before.controllerId, other.snapshot().controllerId)
  assert.equal(other.snapshot().tasks.length, 0)
  assert.equal(board.snapshot('two', '/proj-a').unreadCoordinatorCount, 1)
  assert.equal(board.snapshot('one', '/proj-b').peerEvents.length, 0)
})

test('board.setSummary sets ready summaries, clears failed summaries, and survives message updates', () => {
  const tasks = new Map([['codex-1', { id: 'codex-1', group: 'one' }]])
  const board = createBoard(tasks, ({ id, group }) => ({ id, group }))

  assert.equal(board.setSummary('missing', 'ready', 'none'), false)

  board.message({ id: 'm1', group: 'one', from: 'codex-1', to: 'coordinator-1', text: 'full details', sentAt: 10, source: 'concord' }, 'queued')
  assert.equal(board.setSummary('m1', 'ready', '简洁摘要'), true)

  // Re-recording delivery without summary preserves existing summary fields.
  board.message({ id: 'm1', group: 'one', from: 'codex-1', to: 'coordinator-1', text: 'full details', sentAt: 10, source: 'concord' }, 'read')
  let [entry] = board.snapshot('one').peerEvents
  assert.equal(entry.delivery, 'read')
  assert.equal(entry.summaryStatus, 'ready')
  assert.equal(entry.summary, '简洁摘要')

  assert.equal(board.setSummary('m1', 'failed', 'ignored'), true)
  ;[entry] = board.snapshot('one').peerEvents
  assert.equal(entry.summaryStatus, 'failed')
  assert.equal(entry.summary, null)
})

test('board bounds event history and task output without exposing other groups', () => {
  const tasks = new Map([['agy-1', { id: 'agy-1', group: 'one', prompt: 'p'.repeat(3000), output: 'x'.repeat(7000) }]])
  const board = createBoard(tasks, ({ id }) => ({ id }))
  for (let index = 0; index <= 200; index++) {
    board.message({ id: String(index), group: 'one', text: 'bounded' }, 'queued')
  }
  const snapshot = board.snapshot('one')
  assert.equal(snapshot.tasks[0].prompt.length, 2400)
  assert.equal(snapshot.tasks[0].output.length, 6000)
  assert.equal(snapshot.peerEvents.length, 200)
  assert.equal(snapshot.peerEvents[0].id, '1')
  assert.deepEqual(board.snapshot('other').peerEvents, [])
})

test('same explicit dispatch request is idempotent across simultaneous calls', async () => {
  let starts = 0
  const start = uniqueDispatch(async ({ prompt }) => ({ id: ++starts, prompt }))
  const input = { requestId: 'same', worker: 'codex', prompt: 'hello' }
  assert.deepEqual(await Promise.all([start(input), start({ ...input })]), [
    { id: 1, prompt: 'hello' }, { id: 1, prompt: 'hello' },
  ])
  assert.throws(() => start({ ...input, prompt: 'changed' }), /different input/)
  assert.deepEqual(await start({ worker: 'codex', prompt: 'hello' }), { id: 2, prompt: 'hello' })
})
