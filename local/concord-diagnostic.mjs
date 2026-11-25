const tools = new Set([
  'inspect_work', 'update_work', 'spawn_worker', 'child_status',
  'report_stage', 'group_status', 'group_history', 'group_list',
  'steer_worker', 'followup_worker', 'stop_worker',
])
export function concordFailure(task, tool, value) {
  if (!tools.has(tool)) return
  const error = JSON.stringify(value ?? '').slice(0,8000)
  const category = /reject|permission|denied|approval/i.test(error) ? 'permission_or_rejection'
    : /not registered|recipient is unavailable|unknown recipient|ambiguous/i.test(error) ? 'recipient_unavailable'
    : /argument|invalid|schema|required/i.test(error) ? 'invalid_arguments'
    : /unauthori[sz]ed|unknown concord worker/i.test(error) ? 'not_authenticated'
    : 'tool_failed'
  task.concordDiagnostic = { tool, category }
}
