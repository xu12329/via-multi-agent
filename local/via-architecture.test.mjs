import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createBoard } from './board.mjs'
import { daemonPath } from './daemon-path.mjs'
import { openHistory } from './history.mjs'
import { mailSummaries } from './mail-summaries.mjs'
import { createConcord } from './concord.mjs'

const LOCAL_DIR = dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = join(LOCAL_DIR, 'server.mjs')
const CONCORD_ENTRY = process.env.VIA_CONCORD_ENTRY ??
  fileURLToPath(new URL('../node_modules/@concord-ai/concord-mcp/dist/index.js', import.meta.url))

async function writeFakeBinaries(root, rpcLogPath, inboxLogPath, crashFlagPath, supervisorActionLogPath) {
  const fakeCodex = join(root, 'fake-codex')
  const fakeAgy = join(root, 'fake-agy')

  const codexScript = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const RPC_LOG = ${JSON.stringify(rpcLogPath)}
const INBOX_LOG = ${JSON.stringify(inboxLogPath)}
const CRASH_FLAG = ${JSON.stringify(crashFlagPath)}
const SUP_LOG = ${JSON.stringify(supervisorActionLogPath)}
let turnSeq = 0
let concordConfig = null
let threadId = null
let knownAgentId = ''

function record(path, entry) {
  appendFileSync(path, JSON.stringify(entry) + '\\n')
}
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n')
}

async function withConcord(cfg, fn) {
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
  try {
    return await fn(call)
  } finally {
    child.stdin.end()
    await new Promise(r => child.on('close', r))
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (method) record(RPC_LOG, { method, params: params ?? null })
  if (id === undefined) return
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else if (method === 'config/read') {
    send({ jsonrpc: '2.0', id, result: { config: { model: 'gpt-6.3-sol' } } })
  } else if (method === 'model/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        data: [
          {
            id: 'gpt-6.3-sol',
            model: 'gpt-6.3-sol',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }],
          },
        ],
      },
    })
  } else if (method === 'thread/read') {
    send({ jsonrpc: '2.0', id, result: { thread: null } })
  } else if (method === 'thread/start') {
    concordConfig = params?.config?.mcp_servers?.concord ?? null
    threadId = 'thr-' + randomUUID()
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
    threadId = params.threadId
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
      const myAgentMatch = promptText.match(/Your Concord agent ID is ([^.\\s]+)/)
      if (myAgentMatch?.[1]) knownAgentId = myAgentMatch[1]
      const myAgentId = knownAgentId
      let terminalStatus = 'completed'

      if (promptText.includes('You are the Via Sol supervisor') && existsSync(CRASH_FLAG)) {
        rmSync(CRASH_FLAG)
        process.exit(1)
      }

      if (promptText.includes('script:codex-stall')) {
        return
      }

      if (promptText.includes('script:codex-fail-unexpected')) {
        terminalStatus = 'interrupted'
      } else if (promptText.includes('You are the Via Sol supervisor') && concordConfig) {
        await withConcord(concordConfig, async call => {
          const listRes = await call('tools/list', {})
          const toolNames = (listRes.result?.tools ?? []).map(t => t.name)
          const spawnAttempt = await call('tools/call', {
            name: 'spawn_worker',
            arguments: { worker: 'codex', prompt: 'forbidden', requestId: 'sup-bad' },
          })
          const statusRes = await call('tools/call', { name: 'group_status', arguments: {} })
          const historyRes = await call('tools/call', { name: 'group_history', arguments: {} })
          const listMailRes = await call('tools/call', { name: 'group_list', arguments: {} })

          let stoppedFollowupError = null
          const stoppedWorker = (statusRes.result?.structuredContent?.tasks ?? []).find(t => t.stoppedByCoordinator)
          if (stoppedWorker) {
            const fu = await call('tools/call', {
              name: 'followup_worker',
              arguments: { id: stoppedWorker.id, text: 'try restart' },
            })
            stoppedFollowupError = fu.result?.isError ? fu.result.content?.[0]?.text : null
          }

          let recoveredWorker = null
          const interruptedWorker = (statusRes.result?.structuredContent?.tasks ?? []).find(t => t.state === 'interrupted' && !t.stoppedByCoordinator)
          if (interruptedWorker) {
            const fu = await call('tools/call', {
              name: 'followup_worker',
              arguments: { id: interruptedWorker.id, text: 'script:recovered-ok' },
            })
            recoveredWorker = fu.result?.isError ? null : interruptedWorker.id
          }

          record(SUP_LOG, {
            agentId: myAgentId,
            toolNames,
            spawnDenied: Boolean(spawnAttempt.result?.isError),
            statusTasks: (statusRes.result?.structuredContent?.tasks ?? []).length,
            historyEvents: (historyRes.result?.structuredContent?.events ?? []).length,
            hasGroupList: Array.isArray(listMailRes.result?.structuredContent?.messages),
            stoppedFollowupError,
            recoveredWorker,
          })

          await call('tools/call', {
            name: 'update_work',
            arguments: {
              operation: 'prompt',
              to_agent_id: 'coordinator',
              content: 'Supervisor check complete for group',
              expects_reply: false,
              idempotency_key: 'sup-' + randomUUID(),
            },
          })
        })
      } else if (promptText.includes('script:codex-worker-to-claude') && concordConfig) {
        await withConcord(concordConfig, async call => {
          await call('tools/call', {
            name: 'update_work',
            arguments: {
              operation: 'prompt',
              to_agent_id: 'coordinator',
              content: 'Worker finished report for Claude',
              expects_reply: false,
              idempotency_key: 'w2c-' + randomUUID(),
            },
          })
        })
      } else if (promptText.includes('script:codex-send-large-to:') && concordConfig) {
        const target = promptText.match(/script:codex-send-large-to:([a-z0-9-]+)/i)?.[1]
        await withConcord(concordConfig, async call => {
          const res = await call('tools/call', {
            name: 'update_work',
            arguments: {
              operation: 'prompt',
              to_agent_id: target,
              content: '大'.repeat(5800),
              expects_reply: false,
              idempotency_key: 'large-' + randomUUID(),
            },
          })
          if (res.result?.isError) throw Error('Large message failed: ' + JSON.stringify(res))
        })
      } else if (promptText.includes('script:codex-delegate-leaf') && concordConfig) {
        await withConcord(concordConfig, async call => {
          const spawned = await call('tools/call', {
            name: 'spawn_worker',
            arguments: { worker: 'codex', prompt: 'script:leaf-test', requestId: 'leaf-req' },
          })
          const childId = spawned.result?.structuredContent?.id
          for (let i = 0; i < 100; i++) {
            const st = await call('tools/call', { name: 'child_status', arguments: { id: childId } })
            if (st.result?.structuredContent?.state === 'completed') break
            await new Promise(r => setTimeout(r, 25))
          }
          const inbox = await call('tools/call', { name: 'inspect_work', arguments: { agent_id: myAgentId } })
          record(INBOX_LOG, { who: myAgentId, parentReceived: inbox.result?.structuredContent?.inbox ?? [] })
        })
      } else if (promptText.includes('script:leaf-test') && concordConfig) {
        const parentMatch = promptText.match(/Your direct parent is ([^.\\s]+)/)
        const parentId = parentMatch?.[1]
        await withConcord(concordConfig, async call => {
          const toolsRes = await call('tools/list', {})
          const toolNames = (toolsRes.result?.tools ?? []).map(t => t.name)
          const peersRes = await call('tools/call', { name: 'inspect_work', arguments: {} })
          let peers = []
          try { peers = JSON.parse(peersRes.result?.content?.at(-1)?.text ?? '{}').peers ?? [] } catch {}
          const coordAttempt = await call('tools/call', {
            name: 'update_work',
            arguments: { operation: 'prompt', to_agent_id: 'coordinator', content: 'illegal direct', idempotency_key: 'bad-coord' },
          })
          const parentAttempt = await call('tools/call', {
            name: 'update_work',
            arguments: { operation: 'prompt', to_agent_id: parentId, content: 'leaf result to parent', idempotency_key: 'ok-parent-' + randomUUID() },
          })
          record(INBOX_LOG, {
            who: 'leaf',
            toolNames,
            peers,
            coordDeniedError: coordAttempt.result?.isError ? coordAttempt.result.content?.[0]?.text : null,
            parentAccepted: !parentAttempt.result?.isError,
          })
        })
      } else if (promptText.includes('A new work message is available') && concordConfig) {
        await withConcord(concordConfig, async call => {
          const inbox = await call('tools/call', { name: 'inspect_work', arguments: { agent_id: myAgentId } })
          record(INBOX_LOG, { who: myAgentId, wakeInbox: inbox.result?.structuredContent?.inbox ?? [] })
        })
      }

      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId, delta: 'ok:' + turnId } })
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: terminalStatus } } })
    }, 15)
  } else if (method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else {
    send({ jsonrpc: '2.0', id, result: {} })
  }
})
rl.on('close', () => process.exit(0))
`

  const agyScript = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const RPC_LOG = ${JSON.stringify(rpcLogPath)}
appendFileSync(RPC_LOG, JSON.stringify({ method: 'agy/spawn', argv: process.argv.slice(2) }) + '\\n')

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n')
}
const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  appendFileSync(RPC_LOG, JSON.stringify({ method: 'agy/' + method, params: params ?? null }) + '\\n')
  if (id === undefined) return
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, capabilities: {} } })
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'agy-new-1' } })
  } else if (method === 'session/resume') {
    send({ jsonrpc: '2.0', id, result: { sessionId: params.sessionId } })
  } else if (method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'agy-ok' } },
    } })
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
  } else {
    send({ jsonrpc: '2.0', id, result: {} })
  }
})
rl.on('close', () => process.exit(0))
`

  await writeFile(fakeCodex, codexScript)
  await chmod(fakeCodex, 0o700)
  await writeFile(fakeAgy, agyScript)
  await chmod(fakeAgy, 0o700)
  return { fakeCodex, fakeAgy }
}

async function readJsonLines(path) {
  const raw = await readFile(path, 'utf8').catch(err => (err.code === 'ENOENT' ? '' : Promise.reject(err)))
  return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function startDaemonClient(t, envOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'via-arch-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const work = join(root, 'workspace')
  await mkdir(work, { recursive: true })
  const rpcLogPath = join(root, 'rpc.jsonl')
  const inboxLogPath = join(root, 'inbox.jsonl')
  const crashFlagPath = join(root, 'crash-once.flag')
  const supLogPath = join(root, 'supervisor.jsonl')
  const { fakeCodex, fakeAgy } = await writeFakeBinaries(root, rpcLogPath, inboxLogPath, crashFlagPath, supLogPath)

  const env = {
    ...process.env,
    HOME: root,
    VIA_WORKSPACE: work,
    VIA_CODEX: fakeCodex,
    VIA_AGY: fakeAgy,
    VIA_CLAUDE_SESSION_SCOPE: '1',
    VIA_CONCORD_ENTRY: CONCORD_ENTRY,
    VIA_OPERATOR_NOTIFICATIONS: 'off',
    VIA_SUMMARY_ENABLED: 'off',
    VIA_SOL_SUPERVISOR_EFFORT: 'medium',
    ...envOverrides,
  }

  const daemon = spawn(process.execPath, [SERVER_PATH, '--daemon'], {
    cwd: work,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let daemonStderr = ''
  daemon.stderr.on('data', chunk => { daemonStderr += chunk.toString('utf8') })
  const daemonClosed = once(daemon, 'close')
  t.after(async () => {
    daemon.kill('SIGTERM')
    await Promise.race([daemonClosed, delay(2000)])
    if (!daemon.killed) daemon.kill('SIGKILL')
  })

  const { socket: socketPath } = await (async () => {
    const prev = process.env.VIA_WORKSPACE
    process.env.VIA_WORKSPACE = work
    try { return await daemonPath() }
    finally { if (prev === undefined) delete process.env.VIA_WORKSPACE; else process.env.VIA_WORKSPACE = prev }
  })()

  let channel
  for (let i = 0; i < 60 && !channel; i++) {
    channel = await new Promise((resolve, reject) => {
      const s = connect(socketPath)
      s.once('error', err => {
        if (['ENOENT', 'ECONNREFUSED'].includes(err.code)) resolve(null)
        else reject(err)
      })
      s.once('connect', () => resolve(s))
    })
    if (!channel) await delay(30)
  }
  assert.ok(channel, `Daemon socket failed to come up: ${daemonStderr}`)
  t.after(() => channel.destroy())

  let seq = 0
  const pending = new Map()
  const notifications = []
  createInterface({ input: channel }).on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method && msg.id === undefined) {
      notifications.push(msg)
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(Error(`RPC timeout for ${method}: ${daemonStderr}`))
    }, 10_000)
    pending.set(id, msg => {
      clearTimeout(timer)
      resolve(msg)
    })
    channel.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'Claude Code', version: '0.1.0' },
  })
  assert.ok(init.result)
  channel.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')

  const claudeSession = randomUUID()
  const callTool = async (name, args = {}) => {
    const msg = await rpc('tools/call', { name, arguments: { ...args, _viaClaudeSession: claudeSession } })
    assert.ok(msg.result, `Unexpected RPC error: ${JSON.stringify(msg)}`)
    return msg.result
  }
  const value = packet => JSON.parse(packet.content[0].text)
  const backlog = packet => {
    if (packet.content.length < 2) return []
    return JSON.parse(packet.content[1].text).viaOperatorEvents ?? []
  }

  async function until(predicate, timeoutMs = 6000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return
      await delay(30)
    }
    assert.fail(`Condition did not settle within ${timeoutMs}ms`)
  }

  return { work, root, rpcLogPath, inboxLogPath, crashFlagPath, supLogPath, callTool, value, backlog, notifications, until }
}

test('daemon mode enforces quiet-by-default reporting and delivers reminders only after Claude opens the channel', async t => {
  const ctx = await startDaemonClient(t, { VIA_SOL_SUPERVISION: 'off' })

  assert.deepEqual(ctx.value(await ctx.callTool('reminders', { action: 'status' })), { open: false, desktop: false })

  const w1 = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'quiet-g', cwd: ctx.work, prompt: 'script:codex-worker-to-claude',
  }))

  let boardSnap
  await ctx.until(async () => {
    const res = await ctx.callTool('board', { cwd: ctx.work, group: 'quiet-g' })
    assert.deepEqual(ctx.backlog(res), [])
    boardSnap = ctx.value(res)
    return boardSnap.tasks.find(x => x.id === w1.id)?.state === 'completed' && boardSnap.peerEvents.length === 1
  })

  assert.equal(ctx.notifications.length, 0)
  assert.equal(boardSnap.unreadCoordinatorCount, 1)
  assert.equal(boardSnap.peerEvents[0].forCoordinator, true)

  const opened = ctx.value(await ctx.callTool('reminders', { action: 'open', desktop: false }))
  assert.deepEqual(opened, { open: true, desktop: false })

  // Pre-open closed-window events must NOT replay immediately on next tool call
  assert.deepEqual(ctx.backlog(await ctx.callTool('status', { id: w1.id, group: 'quiet-g' })), [])

  // Post-open completion pushes notifications/message AND viaOperatorEvents in daemon mode
  const w2 = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'quiet-g', cwd: ctx.work, prompt: 'script:codex-worker-to-claude',
  }))
  await ctx.until(async () => {
    const s = ctx.value(await ctx.callTool('status', { id: w2.id, group: 'quiet-g' }))
    return s.state === 'completed'
  })

  await ctx.until(() => ctx.notifications.some(n => n.method === 'notifications/message' && n.params?.data?.worker === w2.id))
  const eventsPacket = await ctx.callTool('board', { cwd: ctx.work, group: 'quiet-g' })
  assert.ok(eventsPacket.content.length >= 1)

  const afterOpen = await ctx.callTool('status', { id: w1.id, group: 'quiet-g' })
  const seenNotifications = ctx.notifications.filter(n => n.params?.data?.worker === w2.id)
  assert.ok(seenNotifications.length >= 1)
  assert.ok(afterOpen)

  // Verify direct piggyback backlog captures events after open
  const w3 = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'quiet-g', cwd: ctx.work, prompt: 'script:codex-worker-to-claude',
  }))
  let gotBacklog = false
  await ctx.until(async () => {
    const pkt = await ctx.callTool('status', { id: w3.id, group: 'quiet-g' })
    const b = ctx.backlog(pkt)
    if (b.some(ev => ev.worker === w3.id && ev.kind === 'completed')) gotBacklog = true
    return gotBacklog
  })
  assert.equal(gotBacklog, true)

  assert.deepEqual(ctx.value(await ctx.callTool('reminders', { action: 'close' })), { open: false, desktop: false })
  const beforeCloseCount = ctx.notifications.length
  const w4 = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'quiet-g', cwd: ctx.work, prompt: 'script:codex-worker-to-claude',
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: w4.id, group: 'quiet-g' })).state === 'completed')
  assert.equal(ctx.notifications.length, beforeCloseCount)
})

test('Sol supervisor monitors, recovers from crashes/failures, enforces Claude authority, and blocks delegation', async t => {
  const ctx = await startDaemonClient(t, {
    VIA_SUPERVISOR_WATCHDOG_MS: '40',
    VIA_SUPERVISOR_STALL_MS: '120',
  })

  // Force supervisor to crash once on first wake to prove supervisors.get(key) does NOT wedge
  await writeFile(ctx.crashFlagPath, 'crash')

  // Worker 1 is stopped explicitly by Claude -> supervisor MUST NOT restart it
  const stoppedWorker = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'sup-g', cwd: ctx.work, prompt: 'script:codex-stall',
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: stoppedWorker.id, group: 'sup-g' })).state === 'running')
  await ctx.callTool('stop', { id: stoppedWorker.id, group: 'sup-g' })

  // Worker 2 hits unexpected interruption -> wakes Sol supervisor, which crashes once cleanly
  const w2 = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'sup-g', cwd: ctx.work, prompt: 'script:codex-fail-unexpected',
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: w2.id, group: 'sup-g' })).state === 'interrupted')

  // Wait briefly so first crashed supervisor exited
  await delay(150)

  // Worker 3 completes -> triggers review_ready even though w1 stopped and crashed supervisor previously failed!
  const w3 = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'sup-g', cwd: ctx.work, prompt: 'script:codex-worker-to-claude',
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: w3.id, group: 'sup-g' })).state === 'completed')

  // Fresh supervisor should spawn, recover w2 (not stopped by Claude), refuse followup on stoppedWorker, and report
  let supLogs = []
  await ctx.until(async () => {
    supLogs = await readJsonLines(ctx.supLogPath)
    return supLogs.length >= 1
  })
  const sup = supLogs[0]
  assert.match(sup.agentId, /^supervisor-\d+$/)
  assert.ok(sup.toolNames.includes('group_status'))
  assert.ok(sup.toolNames.includes('group_history'))
  assert.ok(sup.toolNames.includes('group_list'))
  assert.ok(sup.toolNames.includes('steer_worker'))
  assert.ok(sup.toolNames.includes('followup_worker'))
  assert.ok(sup.toolNames.includes('stop_worker'))
  assert.equal(sup.toolNames.includes('spawn_worker'), false)
  assert.equal(sup.toolNames.includes('child_status'), false)
  assert.equal(sup.spawnDenied, true)
  assert.ok(sup.statusTasks >= 3)
  assert.ok(sup.historyEvents >= 1)
  assert.equal(sup.hasGroupList, true)
  assert.match(sup.stoppedFollowupError ?? '', /explicitly stopped by the coordinator/)
  assert.equal(sup.recoveredWorker, w2.id)

  const supBoard = ctx.value(await ctx.callTool('board', { cwd: ctx.work, group: 'sup-g' }))
  const supTask = supBoard.tasks.find(x => x.id === sup.agentId)
  assert.ok(supTask)
  assert.equal(supTask.role, 'supervisor')
  assert.equal(supTask.supervisor, true)
  const supHistory = ctx.value(await ctx.callTool('history', { cwd: ctx.work, group: 'sup-g' }))
  const supMember = supHistory.members.find(x => x.id === sup.agentId)
  assert.ok(supMember)
  assert.equal(supMember.role, 'supervisor')
  assert.equal(supMember.supervisor, true)

  // Verify recovered w2 finished
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: w2.id, group: 'sup-g' })).state === 'completed')

  // Check supervisor's own thread/start settings in RPC log: 'gpt-6.3-sol' from 'sol' alias, 'full' permissions!
  const rpcCalls = await readJsonLines(ctx.rpcLogPath)
  const supStarts = rpcCalls.filter(c => c.method === 'thread/start' && c.params?.config?.mcp_servers?.concord?.enabled_tools?.includes('group_status'))
  assert.ok(supStarts.length >= 1)
  assert.equal(supStarts.at(-1).params.model, 'gpt-6.3-sol')
  assert.equal(supStarts.at(-1).params.approvalPolicy, 'never')
  assert.equal(supStarts.at(-1).params.sandbox, 'danger-full-access')
  assert.equal(supStarts.at(-1).params.config.model_reasoning_effort, 'medium')

  // Now start a stalling worker and verify watchdog checkStalled wakes supervisor again
  await ctx.callTool('start', {
    worker: 'codex', group: 'stall-g', cwd: ctx.work, prompt: 'script:codex-stall',
  })
  await ctx.until(async () => (await readJsonLines(ctx.supLogPath)).length >= 2, 7000)
})

test('depth-2 leaf is restricted to direct parent and native subagents disabled; resumed sessions default to full permissions', async t => {
  const ctx = await startDaemonClient(t, { VIA_SOL_SUPERVISION: 'off' })

  // 1. Delegation & leaf isolation
  const parent = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'leaf-g', cwd: ctx.work, prompt: 'script:codex-delegate-leaf',
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: parent.id, group: 'leaf-g' })).state === 'completed')

  const inboxLogs = await readJsonLines(ctx.inboxLogPath)
  const leafEntry = inboxLogs.find(e => e.who === 'leaf')
  assert.ok(leafEntry)
  assert.equal(leafEntry.toolNames.includes('spawn_worker'), false)
  assert.match(leafEntry.coordDeniedError ?? '', /direct parent/)
  assert.equal(leafEntry.parentAccepted, true)
  assert.ok(leafEntry.peers.some(p => p.role === 'leaf' && p.depth === 2 && p.parentId === parent.id))
  const parentEntry = inboxLogs.find(e => e.who === parent.id)
  assert.ok(parentEntry.parentReceived.some(m => m.content === 'leaf result to parent'))

  const leafBoard = ctx.value(await ctx.callTool('board', { cwd: ctx.work, group: 'leaf-g' }))
  const leafTask = leafBoard.tasks.find(x => x.depth === 2)
  assert.ok(leafTask)
  assert.equal(leafTask.role, 'leaf')
  assert.equal(leafTask.parentId, parent.id)
  const leafHistory = ctx.value(await ctx.callTool('history', { cwd: ctx.work, group: 'leaf-g' }))
  const leafMember = leafHistory.members.find(x => x.depth === 2)
  assert.ok(leafMember)
  assert.equal(leafMember.role, 'leaf')
  assert.equal(leafMember.parentId, parent.id)

  // Check Codex thread/start config for both parent (depth 1) and leaf (depth 2)
  const rpcCalls = await readJsonLines(ctx.rpcLogPath)
  const threadStarts = rpcCalls.filter(c => c.method === 'thread/start')
  assert.equal(threadStarts.length, 2)
  for (const startCall of threadStarts) {
    assert.equal(startCall.params.config.features.multi_agent, false)
    assert.equal(startCall.params.config.features.multi_agent_v2, false)
    assert.equal(startCall.params.config.agents.enabled, false)
  }

  // 2. Resumed sessions default to 'full' permissions for BOTH Codex and AGY
  const resumedCodex = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'resume-g', cwd: ctx.work, prompt: 'resume codex', session: 'old-codex-session',
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: resumedCodex.id, group: 'resume-g' })).state === 'completed')

  const resumedAgy = ctx.value(await ctx.callTool('start', {
    worker: 'agy', group: 'resume-g', cwd: ctx.work, prompt: 'resume agy', session: 'old-agy-session',
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: resumedAgy.id, group: 'resume-g' })).state === 'completed')

  const afterResumeCalls = await readJsonLines(ctx.rpcLogPath)
  const codexResume = afterResumeCalls.find(c => c.method === 'thread/resume' && c.params.threadId === 'old-codex-session')
  assert.equal(codexResume.params.approvalPolicy, 'never')
  assert.equal(codexResume.params.sandbox, 'danger-full-access')
  const agySpawn = afterResumeCalls.find(c => c.method === 'agy/spawn')
  assert.ok(agySpawn.argv.includes('--dangerously-skip-permissions'))
})

test('Concord handles >16KB UTF-8 payloads, wakes Codex on prompt, list picks latest-mail group, and history/board/inbox surface summaries', async t => {
  const ctx = await startDaemonClient(t, { VIA_SOL_SUPERVISION: 'off' })

  // Test 1: Codex wakes on incoming Concord prompt + >16KB UTF-8 message works
  const targetCodex = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'comm-g', cwd: ctx.work, prompt: 'script:idle-codex',
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: targetCodex.id, group: 'comm-g' })).state === 'completed')

  const senderCodex = ctx.value(await ctx.callTool('start', {
    worker: 'codex', group: 'comm-g', cwd: ctx.work, prompt: `script:codex-send-large-to:${targetCodex.id}`,
  }))
  await ctx.until(async () => ctx.value(await ctx.callTool('status', { id: senderCodex.id, group: 'comm-g' })).state === 'completed')

  // targetCodex must auto-wake and retrieve the 5800-char Chinese message (~17.4 KB UTF-8)!
  await ctx.until(async () => {
    const logs = await readJsonLines(ctx.inboxLogPath)
    return logs.some(entry => entry.who === targetCodex.id && entry.wakeInbox?.[0]?.content?.length === 5800)
  })

  // Start a newer empty group 'empty-newer' (no messages), then call list() with no args -> MUST pick 'comm-g'!
  await ctx.callTool('start', {
    worker: 'codex', group: 'empty-newer', cwd: ctx.work, prompt: 'script:idle-only',
  })
  await ctx.until(async () => (ctx.value(await ctx.callTool('list', {}))).group === 'comm-g')
  const listed = ctx.value(await ctx.callTool('list', {}))
  assert.equal(listed.group, 'comm-g')
  assert.equal(listed.messages.length, 1)

  // Also test history/board/summary integration directly with mailSummaries + createBoard
  const hDir = join(ctx.root, 'sum-hist')
  const h = await openHistory(hDir, 'r1', Date.now, { sessionScoped: true, mail: true })
  const board = createBoard(new Map(), x => x, 'r1')
  const task = { id: 'codex-1', cwd: '/proj', group: 'sum-g', worker: 'codex', state: 'completed', processState: 'ready', depth: 1, role: 'worker' }
  h.worker(task, 'dispatch_accepted')
  const msgEvent = { id: 'm-1', cwd: '/proj', group: 'sum-g', from: 'codex-1', to: 'coordinator-1', text: 'Detailed work result', sentAt: 1000, source: 'concord', delivery: 'queued', providerPhase: 'sent' }
  board.message(msgEvent, 'queued')
  h.evidence(task, 'message_sent', msgEvent, 1000, true)
  const sums = mailSummaries(h, async () => ({ httpStatus: 200, summary: 'Concise AI summary of deliverable' }), {
    onSettled(_t, id, status, summary) { board.setSummary(id, status, summary) },
  })
  sums.enqueue(task, msgEvent, { from: 'codex-1', to: 'coordinator-1', operation: 'prompt', text: 'Detailed work result', attachments: [] })
  await delay(50)

  const readHist = h.read({ cwd: '/proj', group: 'sum-g' })
  const sentEv = readHist.events.find(e => e.type === 'message_sent')
  assert.equal(sentEv.summary, 'Concise AI summary of deliverable')
  assert.equal(sentEv.summaryStatus, 'ready')
  const snap = board.snapshot('sum-g', '/proj')
  assert.equal(snap.peerEvents[0].summary, 'Concise AI summary of deliverable')
  assert.equal(snap.peerEvents[0].forCoordinator, true)
  assert.equal(snap.unreadCoordinatorCount, 1)
  assert.deepEqual(h.summaryFor('/proj', 'sum-g', 'm-1', 'r1'), { summaryStatus: 'ready', summary: 'Concise AI summary of deliverable' })
  sums.close()
  h.close()
})

test('Concord unenroll removes exited worker from peer registry', async t => {
  const board = createBoard(new Map(), x => x, 'run-u')
  const concord = await createConcord({
    entry: CONCORD_ENTRY,
    board,
    wake() {},
  })
  t.after(() => concord.close())

  const w1 = { id: 'codex-1', worker: 'codex', cwd: '/tmp/u', group: 'g', depth: 1, peer: { enrolled: true }, turn: null }
  const w2 = { id: 'codex-2', worker: 'codex', cwd: '/tmp/u', group: 'g', depth: 1, peer: { enrolled: true }, turn: null }
  await concord.enroll(w1)
  await concord.enroll(w2)
  assert.equal(concord.unenroll(w1), true)
  assert.equal(w1.peer.enrolled, false)
  assert.equal(concord.unenroll(w1), false)
})
