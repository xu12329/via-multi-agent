import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'
import { test } from 'node:test'
import { startPeerSocket } from './peer.mjs'

function sendRaw(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      socket.end(payload)
    })
    socket.setEncoding('utf8')
    let response = ''
    socket.on('data', chunk => { response += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response))
      } catch (error) {
        reject(error)
      }
    })
  })
}

test('peer socket uses 0700 dir, dispatches valid JSON, surfaces errors, rejects invalid JSON, and accepts >32KB UTF-8 payloads', async t => {
  const seen = []
  const socket = await startPeerSocket({
    async request(payload) {
      seen.push(payload)
      if (payload.action === 'fail') throw new Error('boom')
      return {
        action: payload.action,
        chars: typeof payload.text === 'string' ? payload.text.length : 0,
        bytes: typeof payload.text === 'string' ? Buffer.byteLength(payload.text, 'utf8') : 0,
      }
    },
  })
  t.after(() => socket.close())

  assert.equal((await stat(dirname(socket.path))).mode & 0o777, 0o700)

  const okReply = await sendRaw(socket.path, JSON.stringify({
    token: 'tok-1',
    action: 'call',
    name: 'inspect_work',
    args: { agent_id: 'codex-1' },
  }))
  assert.deepEqual(okReply, { ok: true, result: { action: 'call', chars: 0, bytes: 0 } })
  assert.deepEqual(seen[0], { token: 'tok-1', action: 'call', name: 'inspect_work', args: { agent_id: 'codex-1' } })

  const errorReply = await sendRaw(socket.path, JSON.stringify({ token: 'tok-1', action: 'fail' }))
  assert.deepEqual(errorReply, { ok: false, error: 'boom' })

  const invalidJsonReply = await sendRaw(socket.path, '{broken json')
  assert.equal(invalidJsonReply.ok, false)
  assert.equal(typeof invalidJsonReply.error, 'string')
  assert.ok(invalidJsonReply.error.length > 0)

  const largeChineseText = '中文测试内容载荷'.repeat(2200)
  const rawLarge = JSON.stringify({ token: 'tok-1', action: 'large', text: largeChineseText })
  assert.ok(Buffer.byteLength(rawLarge, 'utf8') > 32 * 1024)
  assert.ok(Buffer.byteLength(rawLarge, 'utf8') < 128 * 1024)

  const largeReply = await sendRaw(socket.path, rawLarge)
  assert.deepEqual(largeReply, {
    ok: true,
    result: {
      action: 'large',
      chars: largeChineseText.length,
      bytes: Buffer.byteLength(largeChineseText, 'utf8'),
    },
  })
})
