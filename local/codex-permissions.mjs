import { createReadStream } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

const modes = { 'danger-full-access':'dangerFullAccess', 'workspace-write':'workspaceWrite', 'read-only':'readOnly' }
const workspaceFlags = ['network_access','exclude_tmpdir_env_var','exclude_slash_tmp']
const approvalNames = new Set(['never','on-request','untrusted'])
const reviewers = new Set(['user','auto_review','guardian_subagent'])

function nativePolicy(payload) {
  const policy = payload?.sandbox_policy
  if (!policy || !Object.hasOwn(modes, policy.type)) return null
  const approval = payload.approval_policy
  if (!approvalNames.has(approval) && !(approval && typeof approval.granular === 'object')) return null
  const profile = { sandbox:policy.type, approvalPolicy:approval }
  if (reviewers.has(payload.approvals_reviewer)) {
    profile.approvalsReviewer = payload.approvals_reviewer === 'guardian_subagent' ? 'auto_review' : payload.approvals_reviewer
  }
  if (policy.type === 'workspace-write') {
    const options = Object.fromEntries(workspaceFlags.map(key => [key, policy[key] === true]))
    options.writable_roots = (policy.writable_roots ?? []).filter(isAbsolute)
    profile.config = { sandbox_workspace_write:options }
  }
  if (policy.type === 'read-only' && policy.network_access) {
    throw Error('This Codex read-only permission profile is unavailable on resume')
  }
  return profile
}

export async function savedCodexPolicy(rpc, session) {
  const response = await rpc.request('thread/read', { threadId:session, includeTurns:false }).catch(() => null)
  const thread = response?.thread
  if (thread?.id !== session || !thread.path?.endsWith('.jsonl')) return null
  const [home,path] = await Promise.all([
    realpath(process.env.CODEX_HOME || join(homedir(), '.codex')).catch(() => ''),
    realpath(thread.path).catch(() => ''),
  ])
  if (!home || !['sessions','archived_sessions'].some(folder => path.startsWith(join(home, folder) + sep))) return null

  const lines = createInterface({ input:createReadStream(path), crlfDelay:Infinity })
  let metadata, context
  for await (const line of lines) {
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.type === 'session_meta' && !metadata) metadata = row.payload
    if (row.type === 'turn_context') context = row.payload
  }
  if (metadata?.id !== session || !context?.sandbox_policy) return null
  const policy = nativePolicy(context)
  if (!policy) throw Error('Cannot safely restore the saved Codex permission profile')
  return policy
}

export function confirmedCodexPolicy(requested, response) {
  if (!requested?.sandbox) return true
  const sandbox = response.sandbox
  if (sandbox?.type !== modes[requested.sandbox] || !isDeepStrictEqual(response.approvalPolicy, requested.approvalPolicy)) return false
  if (requested.approvalsReviewer && response.approvalsReviewer !== requested.approvalsReviewer) return false
  const expected = requested.config?.sandbox_workspace_write
  if (!expected) return true
  return Boolean(sandbox.networkAccess) === expected.network_access &&
    Boolean(sandbox.excludeTmpdirEnvVar) === expected.exclude_tmpdir_env_var &&
    Boolean(sandbox.excludeSlashTmp) === expected.exclude_slash_tmp &&
    isDeepStrictEqual([...(sandbox.writableRoots ?? [])].sort(), [...expected.writable_roots].sort())
}
