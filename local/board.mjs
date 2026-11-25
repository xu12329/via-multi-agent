import { randomUUID } from 'node:crypto'

const messageLimit = 200
const taskLimit = 50

export function createBoard(tasks, snapshot, controllerId = randomUUID()) {
  const messages = new Map()
  return {
    message({ id, cwd, group, from, to, text, sentAt, source, readAt, replyTo, providerPhase, taskId, taskState, summaryStatus, summary }, delivery) {
      const existing = messages.get(id)
      if (messages.size >= messageLimit && !existing) messages.delete(messages.keys().next().value)
      messages.set(id, {
        id, group, from, to, text, sentAt, source, delivery,
        forCoordinator: typeof to === 'string' && to.startsWith('coordinator-'),
        ...(cwd ? { cwd } : {}), ...(readAt ? { readAt } : {}), ...(replyTo ? { replyTo } : {}),
        ...(providerPhase ? { providerPhase } : {}), ...(taskId ? { taskId, taskState } : {}),
        ...((summaryStatus ?? existing?.summaryStatus) ? { summaryStatus: summaryStatus ?? existing.summaryStatus } : {}),
        ...((summary !== undefined ? summary : existing?.summary) !== undefined ? { summary: summary !== undefined ? summary : existing.summary } : {}),
      })
    },
    setSummary(id, summaryStatus, summary) {
      const entry = messages.get(id)
      if (!entry) return false
      entry.summaryStatus = summaryStatus
      entry.summary = summaryStatus === 'ready' ? summary : null
      return true
    },
    receipt(event, now = Date.now()) {
      for (const id of event.messages ?? []) {
        const message = messages.get(id)
        if (message?.to !== event.worker) continue
        if (event.kind === 'worker_read' && message.readAt === undefined) message.readAt = now
        if (event.kind === 'worker_delivery') message.delivery = event.status
      }
    },
    snapshot(group, cwd) {
      const all = [...tasks.values()].filter(task => !cwd || task.cwd === cwd)
      const peerEvents = [...messages.values()]
        .filter(message => (!group || message.group === group) && (!cwd || message.cwd === cwd))
        .map(message => ({ ...message, forCoordinator: typeof message.to === 'string' && message.to.startsWith('coordinator-') }))
      return {
        controllerId,
        groups: [...new Set(all.map(task => task.group))],
        tasks: all.filter(task => !group || task.group === group).slice(-taskLimit).map(task => ({
          ...snapshot(task),
          prompt: task.prompt?.slice(0, 2400) ?? '',
          output: task.output?.slice(-6000) ?? '',
        })),
        peerEvents,
        unreadCoordinatorCount: peerEvents.filter(message => message.forCoordinator && !message.readAt).length,
      }
    },
  }
}
