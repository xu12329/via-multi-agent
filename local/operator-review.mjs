import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const script = `on run argv
set messageText to item 1 of argv
set positiveLabel to item 2 of argv
set secondsLeft to (item 3 of argv) as integer
if positiveLabel is "Allow Once" then
  set answer to display dialog messageText with title "Via worker approval" buttons {"Deny", "Allow Once"} default button "Deny" giving up after secondsLeft
else
  set answer to display dialog messageText with title "Via worker approval" buttons {"Deny"} default button "Deny" giving up after secondsLeft
end if
if gave up of answer then return "timeout"
return button returned of answer
end run`

export function createOperatorReview({ approvals, elicit, dialog = localDialog, now = Date.now }) {
  const shown = new Set()
  return async function review(task, requestId) {
    const pending = approvals.list(task).find(request => request.requestId === requestId && request.status === 'pending')
    if (!pending || shown.has(requestId)) throw Error('Approval is unavailable or already being reviewed')
    shown.add(requestId)
    try {
      const message = `Via ${pending.worker} worker (${task.id}) in group ${task.group} requests ${pending.action} access. Scope: ${pending.scope}. Approve only if you authorized this operation.`
      const timeout = Math.max(0, pending.expiresAt - now())
      if (!timeout) throw Error('Approval has expired')
      const decision = elicit
        ? await elicit(message, pending.allowOnce, timeout)
        : await dialog(message, pending.allowOnce, timeout)
      if (!decision) return { status: 'pending' }
      return approvals.decide({ id: task.id, group: task.group, requestId, decision })
    } finally {
      shown.delete(requestId)
    }
  }
}

async function localDialog(message, canAllow, timeout) {
  try {
    const { stdout } = await run('/usr/bin/osascript', ['-e', script, message,
      canAllow ? 'Allow Once' : 'Deny', String(Math.ceil(timeout / 1000))], { timeout })
    if (stdout.trim() === 'Allow Once' && canAllow) return 'allow_once'
    if (stdout.trim() === 'Deny') return 'reject'
    return null
  } catch {
    throw Error('Local approval dialog was unavailable')
  }
}
