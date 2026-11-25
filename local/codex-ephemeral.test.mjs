import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const LOCAL_DIR = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = join(LOCAL_DIR, 'server.mjs')
const CONCORD_ENTRY = process.env.VIA_CONCORD_ENTRY ??
  fileURLToPath(new URL('../node_modules/@concord-ai/concord-mcp/dist/index.js', import.meta.url))

async function writeFakeCodex(binPath, logPath) {
  const script = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const LOG_PATH = ${JSON.stringify(logPath)}
let turnSeq = 0
let concordConfig = null

function record(entry) {
  appendFileSync(LOG_PATH, JSON.stringify(entry) + '\\n')
}
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n')
}

async function delegateCodexLeaf(cfg) {
  const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map()
  let seq = 0
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const call = (method, params) => new Promise(resolve => {
    const id = ++seq
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n')
  })
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake-codex', version: '0.1.0' } })
  const spawned = await call('tools/call', {
    name: 'spawn_worker',
    arguments: { worker: 'codex', prompt: 'leaf codex work', requestId: 'leaf-req-1' },
  })
  const childId = spawned.result?.structuredContent?.id
  for (let i = 0; i < 80; i++) {
    const status = await call('tools/call', { name: 'child_status', arguments: { id: childId } })
    if (status.result?.structuredContent?.state === 'completed') break
    await new Promise(r => setTimeout(r, 20))
  }
  child.stdin.end()
  await new Promise(r => child.on('close', r))
}

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (method) record({ method, params: params ?? null })
  if (id === undefined) return
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else if (method === 'config/read') {
    send({ jsonrpc: '2.0', id, result: { config: { model: 'gpt-6.1-sol' } } })
  } else if (method === 'model/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        data: [
          {
            id: 'gpt-6.1-sol',
            model: 'gpt-6.1-sol',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }],
          },
        ],
      },
    })
  } else if (method === 'thread/read') {
    send({ jsonrpc: '2.0', id, result: { thread: null } })
  } else if (method === 'thread/start') {
    concordConfig = params?.config?.mcp_servers?.concord ?? null
    const threadId = 'thr-' + randomUUID()
    send({
      jsonrpc: '2.0',
      id,
      result: {
        thread: { id: threadId },
        model: params.model,
        reasoningEffort: params.config?.model_reasoning_effort ?? 'xhigh',
      },
    })
  } else if (method === 'thread/resume') {
    concordConfig = params?.config?.mcp_servers?.concord ?? null
    send({
      jsonrpc: '2.0',
      id,
      result: {
        thread: { id: params.threadId },
        model: params.model,
        reasoningEffort: params.config?.model_reasoning_effort ?? 'xhigh',
      },
    })
  } else if (method === 'turn/start') {
    const turnId = 'turn-' + (++turnSeq)
    const promptText = params?.input?.[0]?.text ?? ''
    send({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } })
    setTimeout(async () => {
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } })
      if (promptText.includes('delegate-codex-leaf') && concordConfig) {
        await delegateCodexLeaf(concordConfig)
      }
      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, delta: 'fake-ok:' + turnId } })
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } })
    }, 15)
  } else if (method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else {
    send({ jsonrpc: '2.0', id, result: {} })
  }
})
rl.on('close', () => process.exit(0))
`
  await writeFile(binPath, script)
  await chmod(binPath, 0o700)
}

async function readRpcLog(logPath) {
  const raw = await readFile(logPath, 'utf8').catch(err => (err.code === 'ENOENT' ? '' : Promise.reject(err)))
  return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function startClaudeServerHarness(t, { persistThreads = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'via-claude-ephemeral-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const work = join(root, 'workspace')
  const fakeCodex = join(root, 'fake-codex')
  const logPath = join(root, 'codex-rpc.jsonl')
  await mkdir(work, { recursive: true })
  await writeFakeCodex(fakeCodex, logPath)

  const env = {
    ...process.env,
    HOME: root,
    VIA_WORKSPACE: work,
    VIA_CODEX: fakeCodex,
    VIA_CLAUDE_SESSION_SCOPE: '1',
    VIA_CONCORD_ENTRY: CONCORD_ENTRY,
    VIA_OPERATOR_NOTIFICATIONS: 'off',
    VIA_SOL_SUPERVISION: 'off',
    VIA_SUMMARY_ENABLED: 'off',
  }
  if (persistThreads) env.VIA_CODEX_PERSIST_THREADS = '1'
  else delete env.VIA_CODEX_PERSIST_THREADS

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: work,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  const closed = once(child, 'close')
  t.after(async () => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
    await closed
  })

  let seq = 0
  const pending = new Map()
  createInterface({ input: child.stdout }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(Error(`MCP timeout for ${method}: ${stderr}`))
    }, 10_000)
    pending.set(id, msg => {
      clearTimeout(timer)
      resolve(msg)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'Claude Code', version: '0.1.0' },
  })
  assert.ok(init.result)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const claudeSession = randomUUID()
  const callTool = async (name, args) => {
    const msg = await rpc('tools/call', { name, arguments: { ...args, _viaClaudeSession: claudeSession } })
    assert.ok(msg.result, `Unexpected RPC error: ${JSON.stringify(msg)}`)
    return msg.result
  }
  const value = packet => JSON.parse(packet.content[0].text)

  async function waitForStatus(id, group, predicate) {
    for (let i = 0; i < 100; i++) {
      const snap = value(await callTool('status', { id, group }))
      if (predicate(snap)) return snap
      await delay(20)
    }
    assert.fail(`Worker ${id} did not reach expected state`)
  }

  return { work, logPath, callTool, value, waitForStatus }
}

test('Claude-scoped server marks Codex workers ephemeral, supports live followup, blocks post-stop reopen, and preserves explicit resume', async t => {
  const { work, logPath, callTool, value, waitForStatus } = await startClaudeServerHarness(t)

  const started = value(await callTool('start', { worker: 'codex', group: 'g1', cwd: work, prompt: 'hi' }))
  const done1 = await waitForStatus(started.id, 'g1', snap => snap.state === 'completed' && snap.turn === null)
  assert.ok(done1.session)
  assert.equal(done1.output, 'fake-ok:turn-1')

  let log = await readRpcLog(logPath)
  const firstStart = log.find(entry => entry.method === 'thread/start')
  assert.ok(firstStart)
  assert.equal(firstStart.params.ephemeral, true)
  assert.equal(log.some(entry => entry.method === 'thread/resume'), false)

  const liveFollow = value(await callTool('followup', { id: started.id, group: 'g1', text: 'second turn' }))
  assert.equal(liveFollow.id, started.id)
  const done2 = await waitForStatus(started.id, 'g1', snap => snap.state === 'completed' && snap.output === 'fake-ok:turn-2')
  assert.equal(done2.session, done1.session)

  log = await readRpcLog(logPath)
  const turns = log.filter(entry => entry.method === 'turn/start')
  assert.equal(turns.length, 2)
  assert.equal(turns[1].params.threadId, done1.session)
  assert.equal(log.some(entry => entry.method === 'thread/resume'), false)

  const stopped = value(await callTool('stop', { id: started.id, group: 'g1' }))
  assert.equal(stopped.sessionReleased, true)

  const afterStop = await callTool('followup', { id: started.id, group: 'g1', text: 'reopen after stop' })
  assert.equal(afterStop.isError, true)
  assert.match(afterStop.content[0].text, /Ephemeral Codex worker sessions are not persisted/)

  log = await readRpcLog(logPath)
  assert.equal(log.some(entry => entry.method === 'thread/resume'), false)

  const resumed = value(await callTool('start', {
    worker: 'codex',
    group: 'g1',
    cwd: work,
    prompt: 'resume',
    session: 'prev-session-id',
  }))
  const doneResumed = await waitForStatus(resumed.id, 'g1', snap => snap.state === 'completed' && snap.turn === null)
  assert.equal(doneResumed.session, 'prev-session-id')

  log = await readRpcLog(logPath)
  const resumeCall = log.find(entry => entry.method === 'thread/resume')
  assert.ok(resumeCall)
  assert.equal(resumeCall.params.threadId, 'prev-session-id')
  assert.equal(Object.hasOwn(resumeCall.params, 'ephemeral'), false)

  const parent = value(await callTool('start', {
    worker: 'codex',
    group: 'g-del',
    cwd: work,
    prompt: 'delegate-codex-leaf',
  }))
  await waitForStatus(parent.id, 'g-del', snap => snap.state === 'completed' && snap.turn === null)
  const board = value(await callTool('board', { cwd: work, group: 'g-del' }))
  assert.equal(board.tasks.length, 2)
  assert.equal(board.tasks.find(item => item.depth === 2)?.worker, 'codex')

  log = await readRpcLog(logPath)
  const starts = log.filter(entry => entry.method === 'thread/start')
  assert.equal(starts.length, 3)
  assert.ok(starts.every(entry => entry.params.ephemeral === true))
})

test('Claude-scoped server omits ephemeral and permits reopen when VIA_CODEX_PERSIST_THREADS=1', async t => {
  const { work, logPath, callTool, value, waitForStatus } = await startClaudeServerHarness(t, { persistThreads: true })

  const started = value(await callTool('start', { worker: 'codex', group: 'g2', cwd: work, prompt: 'persist me' }))
  const done1 = await waitForStatus(started.id, 'g2', snap => snap.state === 'completed' && snap.turn === null)

  let log = await readRpcLog(logPath)
  const startCall = log.find(entry => entry.method === 'thread/start')
  assert.ok(startCall)
  assert.equal(Object.hasOwn(startCall.params, 'ephemeral'), false)

  const stopped = value(await callTool('stop', { id: started.id, group: 'g2' }))
  assert.equal(stopped.sessionReleased, true)

  const reopened = await callTool('followup', { id: started.id, group: 'g2', text: 'continue persisted' })
  assert.notEqual(reopened.isError, true)
  await waitForStatus(started.id, 'g2', snap => snap.state === 'completed' && snap.turn === null && snap.output === 'fake-ok:turn-1')

  log = await readRpcLog(logPath)
  const resumeCall = log.find(entry => entry.method === 'thread/resume')
  assert.ok(resumeCall)
  assert.equal(resumeCall.params.threadId, done1.session)
  assert.equal(Object.hasOwn(resumeCall.params, 'ephemeral'), false)
})
