import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

test('regular dispatch and board share real tool state, and a second controller stays separate', async t => {
  const home = await mkdtemp(join(tmpdir(), 'via-board-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const work = join(home, 'workspace')
  const runtime = join(home, 'runtime')
  await mkdir(work)
  await cp(dirname(fileURLToPath(import.meta.url)), runtime, { recursive: true })
  for (const name of ['.local/bin/codex', '.local/bin/agy']) {
    const binary = join(home, name)
    await mkdir(dirname(binary), { recursive: true })
    await writeFile(binary, '')
    await chmod(binary, 0o700)
  }
  await writeFile(join(runtime, 'backend.mjs'), `
    import { connect } from './rpc.mjs'
    export async function readCodexModels() { return { models: [] } }
    export async function openWorker(task, command, session, transport, peer, receive, preferences) {
      Object.assign(task, {
        session: 'fixture-' + task.id,
        selection: { effective: { model: preferences.model, effort: preferences.effort }, nativeConfirmed: true },
      })
      const mcp = connect(peer.command, peer.args, { env: peer.env }, { notify() {}, handle() {}, exit() {} })
      const call = async (name, args) => (await mcp.request('tools/call',{name,arguments:args})).structuredContent
      return {
        async prompt(text) {
          Object.assign(task, { state: 'running', turn: 'turn-1', output: text.split('\\n')[0] })
          if (text.startsWith('send work')) {
            await call('update_work', {operation:'prompt',to_agent_id:'gemini',content:'native plan body',idempotency_key:'one'})
          }
          if (task.worker === 'agy') {
            if (text.includes('A new work message')) {
              if (text.includes('native plan body')) throw Error('wake leaked content')
              const inbox = (await call('inspect_work', {agent_id:task.id})).inbox
              task.output = inbox[0].content
              await call('update_work',{operation:'reply',to_agent_id:inbox[0].senderAgentId,reply_to_message_id:inbox[0].messageId,content:'reply'})
            }
            task.state = 'completed'
            task.turn = null
            task.agyTurn = { turn: String(++task.epoch) }
            receive({ turn: task.agyTurn.turn, assistantText: task.output })
          }
        },
        async steer(text) { task.output = text; return { accepted: true } },
        close: mcp.close,
      }
    }
  `)
  function controller() {
    const child = spawn(process.execPath, [join(runtime, 'server.mjs')], {
      env: { ...process.env, HOME: home, VIA_WORKSPACE: work, VIA_CONCORD_ENTRY: process.env.VIA_CONCORD_ENTRY ??
        fileURLToPath(new URL('../node_modules/@concord-ai/concord-mcp/dist/index.js', import.meta.url)) },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const closed = once(child, 'close')
    t.after(async () => { child.stdin.end(); await closed })
    let seq = 0
    const pending = new Map()
    createInterface({ input: child.stdout }).on('line', line => {
      const event = JSON.parse(line)
      pending.get(event.id)?.(event.result)
      pending.delete(event.id)
    })
    return (name, args) => new Promise(resolve => {
      const id = ++seq
      pending.set(id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    })
  }
  const call = controller()
  const other = controller()
  const value = response => JSON.parse(response.content[0].text)
  const request = { requestId: 'same-click', worker: 'codex', group: 'alpha', cwd: work, prompt: 'fixture task', model: 'astra', effort: 'ultra' }
  const [one, retry] = (await Promise.all([call('start', request), call('start', request)])).map(value)
  assert.equal(one.id, retry.id)
  async function until(predicate) {
    for (let i = 0; i < 100; i++) {
      const snapshot = value(await call('board', {group:'alpha'}))
      if (predicate(snapshot)) return snapshot
      await delay(20)
    }
    assert.fail('Controller state did not settle')
  }
  const scoped = await until(board => board.tasks[0]?.state === 'running')
  assert.equal(scoped.tasks.length, 1)
  assert.equal(scoped.tasks[0].prompt, 'fixture task')
  assert.deepEqual(scoped.tasks[0].selection.effective, { model: 'astra', effort: 'ultra' })
  assert.equal((await call('steer', { id: one.id, group: 'wrong', text: 'blocked' })).isError, true)
  assert.equal(value(await call('steer', { id: one.id, group: 'alpha', text: 'direct' })).accepted, true)
  assert.equal(value(await call('board', { group: 'alpha' })).tasks[0].output, 'direct')
  const agy = value(await call('start', { worker: 'agy', group: 'alpha', cwd: work, prompt: 'wait for peer', activation: 'concord' }))
  await until(board => board.tasks.find(task => task.id === agy.id)?.state === 'waiting_inbox')
  await call('start', { worker: 'codex', group: 'alpha', cwd: work, prompt: 'send work' })
  const delivery = await until(board => board.peerEvents.some(message => message.replyTo))
  const receiver = delivery.tasks.find(task => task.id === agy.id)
  assert.equal(receiver.autoWake.mode, 'initial_turn')
  assert.equal(receiver.output, 'native plan body')
  assert.equal(delivery.peerEvents[0].delivery, 'read')
  assert.equal(delivery.peerEvents[0].providerPhase, 'replied')
  assert.equal(delivery.peerEvents.at(-1).delivery, 'queued')
  const unrelated = value(await other('board', { group: 'alpha' }))
  assert.equal(unrelated.tasks.length, 0)
  assert.notEqual(unrelated.controllerId, scoped.controllerId)
})
