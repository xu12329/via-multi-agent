import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from './rpc.mjs'
import { createConcord } from './concord.mjs'

const entry = process.env.VIA_CONCORD_ENTRY
test('native concord endpoints stay isolated and only new work wakes', { skip: !entry }, async () => {
  const messages = new Map()
  const wakes = []
  const controller = await createConcord({ entry, board: { message: event => messages.set(event.id, { ...event }) },
    wake: (task, id, signal) => wakes.push({ task: task.id, id, signal }) })
  const children = []
  try {
    async function client(group, id, worker) {
      const task = { id, group, worker, cwd: process.cwd(), peer: {} }
      const descriptor = await controller.enroll(task)
      const rpc = connect(descriptor.command, descriptor.args, { env: descriptor.env }, {
        notify() {}, handle() {}, exit() {},
      })
      children.push(rpc)
      return async (name, args, raw = false) => {
        const result = await rpc.request('tools/call', { name, arguments: args })
        if (result.isError) throw Error(result.content[0].text)
        return raw ? result : result.structuredContent
      }
    }
    const [a, b, c, d] = await Promise.all([
      client('alpha','codex-1','codex'), client('alpha','agy-2','agy'),
      client('beta','codex-3','codex'), client('beta','agy-4','agy'),
    ])
    assert.deepEqual(new Set((await a('inspect_work', {})).presence.map(x => x.agentId)), new Set(['codex-1','agy-2']))
    assert.deepEqual(new Set((await d('inspect_work', {})).presence.map(x => x.agentId)), new Set(['codex-3','agy-4']))
    const plan = { operation: 'prompt', to_agent_id: 'gemini', content: 'PRIVATE PLAN', idempotency_key: 'key' }
    await assert.rejects(a('update_work', { ...plan, to_agent_id: 'agy-4' }), /Group addresses: agy-2/)
    const sent = await a('update_work', plan)
    const id = sent.message_id
    assert.equal((await a('update_work', plan)).message_id, id)
    const sentOther = await c('update_work', { ...plan, content: 'OTHER' })
    assert.notEqual(sentOther.message_id, id)
    assert.equal(messages.get(id).delivery, 'queued')
    assert.equal(wakes.length, 2)
    assert.ok(wakes.every(w => !w.signal.includes('PRIVATE PLAN')))
    const observer = await a('inspect_work', { agent_id: 'agy-2' }, true)
    const outsider = await d('inspect_work', { agent_id: 'agy-2' }, true)
    assert.equal(observer.structuredContent.inbox, undefined)
    assert.equal(outsider.structuredContent.inbox, undefined)
    assert.doesNotMatch(JSON.stringify([observer, outsider]), /PRIVATE PLAN/)
    assert.equal(messages.get(id).delivery, 'queued')

    const received = await b('inspect_work', { agent_id: 'agy-2' }, true)
    const native = received.structuredContent.inbox[0]
    assert.equal(native.messageId, id)
    assert.equal(native.content, 'PRIVATE PLAN')
    const text = JSON.parse(received.content.at(-1).text).inbox[0]
    assert.deepEqual(text, { messageId: native.messageId, content: native.content,
      senderAgentId: native.senderAgentId, replyToMessageId: native.replyToMessageId })
    assert.equal(messages.get(id).delivery, 'read')
    const reply = await b('update_work', { operation: 'reply', to_agent_id: 'sol', reply_to_message_id: id, content: 'DONE' })
    assert.equal(messages.get(id).providerPhase, 'replied')
    assert.equal(messages.get(reply.message_id).replyTo, id)
    assert.equal(wakes.length, 2)
  } finally {
    for (const rpc of children) rpc.close()
    await controller.close()
  }
})
