import { concordFailure } from './concord-diagnostic.mjs'
import { workerTools } from './delegation.mjs'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from './rpc.mjs'
import { startPeerSocket } from './peer.mjs'

const endpoint = fileURLToPath(new URL('./concord-worker.mjs', import.meta.url))
const nativeTools = new Set(['inspect_work', 'update_work'])
const supervisorTools = [
  { name: 'group_status', description: 'Inspect live worker status, process state, turn, activity, diagnostics, and recent output in this group.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1 } } } },
  { name: 'group_history', description: 'Read recorded Via history events for this group.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  { name: 'group_list', description: 'Read recent Concord mail summaries for this group.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
  { name: 'steer_worker', description: 'Send a live steering instruction to an active worker in this group without starting a new turn.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1 } } } },
  { name: 'followup_worker', description: 'Resume an idle worker turn in this group (refused if explicitly stopped by coordinator).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1 } } } },
  { name: 'stop_worker', description: 'Stop a stuck or runaway worker turn in this group.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1 }, expectedTurnId: { type: 'string', minLength: 1 } } } },
]
const supervisorToolNames = new Set(supervisorTools.map(tool => tool.name))
const wakeText = 'A new work message is available in your Concord inbox. Use inspect_work with your own agent_id to retrieve it. Carry out the assigned work, then use update_work operation reply with the original message ID when a reply is requested. Do not reply to replies.'

export async function createConcord({ entry, board, wake, history, observeRead, delegate, supervise, summaries, milestone, transport = connect }) {
  const directory = await mkdtemp(join(tmpdir(), 'via-concord-'))
  const scopes = new Map()
  const clients = new Map()
  const enrolling = new Map()
  const authorization = new Map()
  const events = new Map()
  const pendingReplies = new Map()
  let closed = false
  const socket = await startPeerSocket({
    async request({ token, action, name, args }) {
      const member = authorization.get(token)
      if (closed || !member) throw Error('Unknown Concord worker')
      if (action === 'list') return member.tools
      member.task.lastActivityAt = Date.now()
      if (action === 'call' && name === 'report_stage' && milestone && member.task.depth > 0) {
        const output = milestone(member.task, args ?? {})
        return { content:[{type:'text',text:JSON.stringify(output)}], structuredContent:output }
      }
      if (action === 'call' && delegate && workerTools.some(tool => tool.name === name)) {
        const output = await delegate(member.task, name, args ?? {})
        return { content:[{type:'text',text:JSON.stringify(output)}], structuredContent:output }
      }
      if (action === 'call' && supervise && supervisorToolNames.has(name)) {
        if (!member.task.supervisor) throw Error('Supervisor tools are restricted to the Sol supervisor')
        try {
          const output = await supervise(member.task, name, args ?? {})
          return { content:[{type:'text',text:JSON.stringify(output)}], structuredContent:output }
        } catch (error) {
          concordFailure(member.task, name, error.message)
          throw error
        }
      }
      if (action !== 'call' || !nativeTools.has(name)) throw Error('Unsupported Concord tool')
      member.task.peer.authenticatedAt ??= Date.now()
      const previous = member.scope.pending ?? Promise.resolve()
      const providerTurn = member.task.turn
      const next = previous.catch(() => {}).then(async () => {
        try {
          const result = await call(member, name, args ?? {}, providerTurn)
          if (result?.isError) concordFailure(member.task, name, result.content)
          return result
        } catch (error) {
          concordFailure(member.task, name, error.message)
          throw error
        }
      })
      member.scope.pending = next
      return next
    },
  })
  const key = task => JSON.stringify([task.group, task.cwd])
  function peerAddress(member, address) {
    const peers = [...clients.values()].filter(other => other !== member && other.ready && other.scope === member.scope)
    const normalize = value => String(value ?? '').trim().toLowerCase()
    const requested = normalize(address)
    const match = peers.find(other => normalize(other.task.id) === requested)
    if (match) return match.task.id
    const aliases = peers.filter(({ task }) => {
      const names = task.supervisor
        ? ['supervisor', 'sol-supervisor']
        : [task.worker, task.worker === 'agy' ? 'gemini' : task.worker === 'codex' ? 'sol' : 'claude', task.selection?.effective?.model]
      return names.map(normalize).filter(Boolean).includes(requested)
    })
    if (aliases.length === 1) return aliases[0].task.id
    throw Error(`Concord recipient is unavailable or ambiguous. Group addresses: ${peers.map(({ task }) => task.id).join(', ') || '(none)'}`)
  }
  function present(event) {
    if (events.size >= 200 && !events.has(event.id)) events.delete(events.keys().next().value)
    events.set(event.id, event)
    board.message(event, event.delivery)
  }
  function lookup(task, id) {
    if (typeof id !== 'string') return
    const event = events.get(id)
    if (event?.cwd === task.cwd && event.group === task.group) return event
    return history?.message(task, id)
  }
  function observeDelivery(task, event, deliveredAt, deliveredVia) {
    if (!deliveredAt) return
    history?.evidence(task, 'message_delivery', { ...event, delivery: 'delivered', providerPhase: 'delivered', deliveredVia }, deliveredAt)
  }
  async function call(member, name, args, providerTurn) {
    if (closed) throw Error('Concord controller closed')
    if (name === 'inspect_work') {
      // A global inspect is discovery. Only this authenticated member can consume its inbox.
      const inputs = args.agent_id === member.task.id ? { agent_id: member.task.id } : {}
      const result = await member.run(name, inputs)
      for (const receipt of result.structuredContent?.inbox ?? []) {
        const event = lookup(member.task, receipt.messageId)
        if (!event || event.to !== member.task.id || event.readAt || !receipt.readAt) continue
        observeDelivery(member.task, event, receipt.deliveredAt, receipt.deliveredVia)
        const read = { ...event, readAt: receipt.readAt, delivery: 'read', providerPhase: receipt.status }
        history?.evidence(member.task, 'message_read', read, receipt.readAt)
        present(read)
        observeRead?.(member.task, read, providerTurn)
      }
      // Native Concord exposes detailed MCP records in structuredContent. Some
      // worker clients surface only text, so append the same authenticated subset.
      const { inbox, presence } = result.structuredContent ?? {}
      if (Array.isArray(inbox) && inputs.agent_id) {
        const received = inbox.map(({ messageId, senderAgentId, content, replyToMessageId }) =>
          ({ messageId, senderAgentId, content, replyToMessageId }))
        return { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ inbox: received }) }] }
      }
      if (Array.isArray(presence)) {
        const peers = presence.map(({ agentId, owner }) => {
          const peerTask = clients.get(agentId)?.task
          return {
            agentId,
            owner,
            ...(peerTask ? {
              role: peerTask.role ?? (peerTask.supervisor ? 'supervisor' : peerTask.depth === 2 ? 'leaf' : peerTask.depth === 0 ? 'coordinator' : 'worker'),
              depth: peerTask.depth ?? null,
              parentId: peerTask.parentId ?? null,
              ...(peerTask.supervisor ? { supervisor: true } : {}),
            } : {}),
          }
        })
        return { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ peers }) }] }
      }
      return result
    }
    const { operation, reply_to_message_id } = args
    const attachments = args.text_attachments ?? []
    if (!Array.isArray(attachments) || attachments.length > 3 ||
        attachments.some(value => typeof value !== 'string' || !value.trim())) throw Error('Attach up to three explicit text strings')
    const text = args.content
    const content = typeof text === 'string' && attachments.length
      ? [text, ...attachments.map((value,index) => `Text attachment ${index+1}:\n${value}`)].join('\n\n') : text
    const idempotency_key = args.idempotency_key ?? (operation === 'reply' ? `reply-${reply_to_message_id}` : undefined)
    if (!['prompt', 'reply'].includes(operation) || typeof text !== 'string' || !text.trim() || content.length > 6000) {
      throw Error('Concord accepts a bounded prompt or a reply to a received work message')
    }
    const to = peerAddress(member, args.to_agent_id)
    if (member.task.depth === 2 && to !== member.task.parentId) {
      throw Error(`Leaf workers may only message their direct parent (${member.task.parentId})`)
    }
    if (args.wake_on_reply !== undefined && typeof args.wake_on_reply !== 'boolean') throw Error('Invalid reply wake option')
    if (args.wake_on_reply && (operation !== 'prompt' || args.expects_reply === false || clients.get(to)?.task.depth === 0)) {
      throw Error('Reply wake requires an expected worker-to-worker reply')
    }
    if (args.wake_on_reply) {
      for (const [id, pending] of pendingReplies) if (pending.expiresAt <= Date.now()) pendingReplies.delete(id)
    }
    if (args.wake_on_reply && pendingReplies.size >= 200) throw Error('Too many pending reply wakes')
    const parent = operation === 'reply' ? lookup(member.task, reply_to_message_id) : null
    if (operation === 'reply' && (!parent?.readAt || parent.to !== member.task.id || parent.from !== to || parent.replyTo)) {
      throw Error('Reply must address a work message read by this worker')
    }
    const result = await member.run(name, { operation, content, to_agent_id: to,
      ...(parent ? { reply_to_message_id } : { expects_reply: args.expects_reply !== false }),
      ...(typeof idempotency_key === 'string' ? { idempotency_key: idempotency_key.slice(0, 120) } : {}),
    })
    const receipt = result.structuredContent
    if (result.isError || !receipt?.message_id || (!history && receipt.idempotent_replay)) return result
    if (receipt.sender_agent_id !== member.task.id || receipt.recipient_agent_id !== to ||
        (receipt.reply_to_message_id ?? null) !== (parent?.id ?? null)) throw Error('Concord receipt identity mismatch')
    const existing = lookup(member.task, receipt.message_id)
    if (existing) {
      observeDelivery(member.task, existing, receipt.delivered_at)
      return result
    }
    const event = { id: receipt.message_id, cwd: member.task.cwd, group: member.task.group,
      from: receipt.sender_agent_id, to: receipt.recipient_agent_id, text: content,
      sentAt: Date.parse(receipt.receipt?.sent_at) || Date.now(), source: 'concord',
      delivery: receipt.delivered_at ? 'delivered' : 'queued', providerPhase: receipt.receipt?.status ?? 'sent',
      replyTo: receipt.reply_to_message_id ?? undefined }
    const type = parent ? 'message_reply' : 'message_sent'
    const accepted = history?.evidence(member.task, type, { ...event, delivery: 'queued', providerPhase: 'sent' },
      receipt.receipt?.sent_at, summaries && !receipt.idempotent_replay
        ? (summaries.enabled ? true : 'unavailable') : false)
    if (accepted && !receipt.idempotent_replay) {
      summaries?.enqueue(member.task, event, {
        from: event.from,
        to: event.to,
        operation: parent ? 'reply' : 'prompt',
        replyTo: event.replyTo ?? null,
        text,
        attachments,
      })
    }
    observeDelivery(member.task, event, receipt.delivered_at)
    present(event)
    if (!parent && args.wake_on_reply && !receipt.idempotent_replay) pendingReplies.set(event.id, { worker:member.task.id, expiresAt:Date.now() + 3_600_000 })
    if (parent) {
      parent.providerPhase = 'replied'
      present(parent)
      if (pendingReplies.get(parent.id)?.worker === to) {
        const pending = pendingReplies.get(parent.id)
        pendingReplies.delete(parent.id)
        const receiver = clients.get(to)?.task
        if (receiver && pending.expiresAt > Date.now() && !closed && !receipt.idempotent_replay) {
          wake(receiver, event.id, 'A requested reply arrived in your Concord inbox. Read your own inbox, match the reply to your original request, and continue your assigned work. Do not reply to replies.', 'reply')
        }
      }
    } else if (!closed && !receipt.idempotent_replay) {
      const receiver = clients.get(to)?.task
      if (receiver) wake(receiver, event.id, wakeText)
    }
    return result
  }
  return {
    enroll(task) {
      const scopeKey = key(task)
      const previous = enrolling.get(scopeKey) ?? Promise.resolve()
      const next = previous.catch(() => {}).then(() => enroll(task))
      enrolling.set(scopeKey, next)
      return next
    },
    unenroll(task) {
      const member = clients.get(task.id)
      if (!member) return false
      member.ready = false
      authorization.delete(member.token)
      clients.delete(task.id)
      member.rpc.close()
      if (task.peer) {
        task.peer.enrolled = false
        task.peer.backendReady = false
      }
      return true
    },
    cancelReplyWakes(task) {
      for (const [id, pending] of pendingReplies) if (pending.worker === task.id) pendingReplies.delete(id)
    },
    readCoordinator(task) {
      const member = clients.get(task.id)
      if (task.depth !== 0 || member?.task !== task) throw Error('Coordinator is not enrolled')
      const previous = member.scope.pending ?? Promise.resolve()
      const next = previous.catch(() => {}).then(() => call(member,'inspect_work',{agent_id:task.id}))
      member.scope.pending = next
      return next
    },
    inbox(worker) {
      return [...events.values()].filter(event => event.to === worker).map(({ text, ...event }) => ({ ...event }))
    },
    linkTask(task, messageId, taskId, taskState) {
      const event = lookup(task, messageId)
      if (!event?.readAt || event.to !== task.id || event.replyTo ||
          (event.taskId && event.taskId !== taskId)) return false
      history?.messageTask(task, messageId, taskId, taskState)
      present({ ...event, taskId, taskState })
      return true
    },
    async close() {
      closed = true
      authorization.clear()
      for (const member of clients.values()) member.rpc.close()
      await socket.close()
      await Promise.allSettled(enrolling.values())
      await Promise.allSettled([...clients.values()].map(member => member.scope.pending))
      await rm(directory, { recursive: true, force: true })
    },
  }

  async function enroll(task) {
    if (closed) throw Error('Concord controller closed')
    const scopeKey = key(task)
    if (!scopes.has(scopeKey)) scopes.set(scopeKey, (async () => {
      // The Concord repo and profiles live in a private child of the controller root.
      // Worker cwd stays the user-selected project, and never decides the database.
      const cwd = await mkdtemp(join(directory, 'scope-'))
      const home = join(cwd, 'home')
      await mkdir(join(home, '.concord'), { recursive: true })
      await writeFile(join(home, '.concord/config.json'), JSON.stringify({ autoAdapters: false, cloudLink: false }), { mode: 0o600 })
      return { cwd, home }
    })())
    const scope = await scopes.get(scopeKey)
    if (closed) throw Error('Concord controller closed')
    const env = { HOME: scope.home, PATH: '/usr/bin:/bin', CONCORD_REPO_ROOT: scope.cwd,
      CONCORD_ALLOWED_ROOTS: scope.cwd, CONCORD_AGENT_ID: task.id, CONCORD_NO_UPDATE_CHECK: '1', CONCORD_TELEMETRY_DISABLED: '1' }
    const rpc = transport('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', process.execPath, entry],
      { cwd: scope.cwd, env }, { notify() {}, handle() { throw Error('Unsupported Concord request') }, exit() {} })
    const token = randomUUID()
    const member = { task, scope, rpc, token, run: (name, args) => rpc.request('tools/call', { name, arguments: args }) }
    clients.set(task.id, member)
    try {
      await rpc.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'via-concord', version: '1' } })
      rpc.notify('notifications/initialized', {})
      const title = task.supervisor
        ? 'Via Sol supervisor'
        : task.parentId
          ? `Via leaf ${task.worker} (${task.parentId})`
          : `Via ${task.worker}`
      const registration = await member.run('start_work', {
        task_id: task.id,
        title,
        owner: task.id,
        kind: 'task',
        ...(task.parentId ? { parent_task_id: task.parentId } : {}),
      })
      if (registration.isError) throw Error('Concord refused worker registration')
      const catalog = await rpc.request('tools/list', {})
      member.tools = catalog.tools.filter(tool => nativeTools.has(tool.name))
      if (member.tools.length !== nativeTools.size) throw Error('Concord tools are unavailable')
      member.tools = member.tools.map(tool => {
        const properties = tool.inputSchema.properties ?? {}
        if (tool.name === 'inspect_work') return { ...tool, description:
          'With no arguments, list registered peers in your group. With your own agent_id, retrieve your inbox and record a real read.',
          inputSchema:{ type:'object', additionalProperties:false, properties:{agent_id:properties.agent_id} } }
        return { ...tool, description:
          'Send to an exact registered worker or reply to a message you have read. For a new prompt include operation, to_agent_id, content and a stable idempotency_key. For reply pass reply_to_message_id from the inbox. Only expected worker-to-worker replies may set wake_on_reply=true. Send final evidence and unresolved blockers to coordinator, rather than intermediate mail.',
          inputSchema:{ type:'object', additionalProperties:false, required:['operation','to_agent_id','content'],
            properties:{ operation:{enum:['prompt','reply']}, to_agent_id:properties.to_agent_id, content:properties.content,
              idempotency_key:properties.idempotency_key, expects_reply:properties.expects_reply,
              reply_to_message_id:properties.reply_to_message_id,
              text_attachments:{type:'array',maxItems:3,items:{type:'string'},
                description:'Optional explicit text attachment content. Paths are never read.'},
              wake_on_reply:{type:'boolean',description:'Resume this worker once on a linked reply.'} } } }
      })
      if (delegate && task.depth === 1 && !task.supervisor) member.tools.push(...workerTools)
      if (supervise && task.supervisor) member.tools.push(...supervisorTools)
      if (milestone && task.depth > 0) member.tools.push({
        name:'report_stage', description:'Report a genuinely saved checkpoint or a blocking error to the operator. Reuse the same id for retries.',
        inputSchema:{type:'object',additionalProperties:false,required:['id','state','detail'],properties:{
          id:{type:'string'}, state:{enum:['saved','blocked']}, detail:{type:'string',maxLength:180},
        }},
      })
      member.ready = true
      authorization.set(token, member)
      return { toolNames: member.tools.map(tool=>tool.name), name: 'concord', command: process.execPath, args: [endpoint], env: { VIA_CONCORD_SOCKET: socket.path, VIA_CONCORD_TOKEN: token } }
    } catch (error) {
      clients.delete(task.id)
      rpc.close()
      throw error
    }
  }
}
