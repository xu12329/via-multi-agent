import { execFile } from 'node:child_process'

const labels = {
  completed: '已完成',
  worker_started: '已启动',
  worker_saved: '已保存阶段成果',
  worker_blocked: '报告阻塞',
  coordinator_mail: '收到定向来信',
  worker_error: '异常结束',
  approval_pending: '等待审批',
  approval_timeout: '审批已超时',
}

const notificationScript = `on run argv
display notification (item 1 of argv) with title (item 2 of argv)
end run`

export function coordinatorHost(name) {
  if (/claude/i.test(name ?? '')) return 'Claude Code'
  if (/codex/i.test(name ?? '')) return 'Codex'
  return null
}

export function pushOperatorEvent({ send, host, event, desktop = true, notify = execFile }) {
  const label = labels[event.kind]
  if (!host || !label) return
  const group = event.group.replace(/[^\p{L}\p{N} ._-]/gu, ' ').slice(0, 55)
  const text = `${group} · ${event.id} ${label}${event.detail ? `：${event.detail}` : ''}`
  send({
    jsonrpc: '2.0', method: 'notifications/message',
    params: { level: event.kind === 'worker_error' || event.kind === 'approval_timeout' || event.kind === 'worker_blocked' ? 'warning' : 'notice',
      logger: 'via.operator', data: { event: event.kind, worker: event.id, projectGroup: group, text } },
  })
  if (desktop && process.platform === 'darwin') {
    notify('/usr/bin/osascript', ['-e', notificationScript, text, `Via · ${host}`], { timeout: 4000 }, () => {})
  }
}
