import type { EngineInterface, Register } from 'claude-code'

const PANE = 'via-desk'

async function sessionId($: EngineInterface) {
  const id = await $.session.id()
  return id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : ''
}

export function deskApi($: EngineInterface) {
  return {
    register: () => $.command.register({ name:PANE, description:'打开网页通信桌的本机入口', immediate:true }),
    synchronize: () => $.tool.call({tool:'mcp__plugin_via_workers__board', view:'desk-projects',
      tool_use_id:'via-desk-session-' + Date.now()} as never),
  }
}

export async function initializeDesk(api: ReturnType<typeof deskApi>) {
  await api.register()
  void api.synchronize().catch(() => undefined)
}

export function registerDesk(on: Parameters<Register>[0]) {
  let busy = false
  let failed = false

  const tools = ['start', 'models', 'board', 'history', 'list', 'status', 'steer', 'stop', 'followup', 'review_approval', 'coordinator_inbox', 'peer_read', 'reminders']
  for (const name of tools) {
    const tool = 'mcp__plugin_via_workers__' + name
    on('tool.call', { tool:tool as 'Bash' }, async ($, e, next) => {
      const session = await sessionId($)
      if (!session) return { deny:'无法识别当前 Claude Code 会话。' }
      return next({ ...e, _viaClaudeSession:session } as typeof e)
    })
  }

  on('command.run', { command:PANE }, async ($) => {
    if (!busy) failed = false
    await $.ui.open({ id:PANE, title:'Via 通信桌', focus:true, closeOnEscape:true, columns:42, rows:7 })
    return {}
  })

  on('ui.render', { component:'Pane', requestId:PANE }, ($, event, next) => {
    if (event.requestId !== PANE) return next(event)
    const { Box, Button, Text } = $.ui.resolve(event)
    const button = Button({
      key:'open-web-desk',
      label:busy ? '正在打开网页通信桌…' : '打开网页通信桌',
      variant:'primary',
      onPress:async () => {
        if (busy) return
        busy = true
        failed = false
        $.ui.invalidate('ui.render')
        try {
          const session = await sessionId($)
          if (!session || await sessionId($) !== session) { failed = true; return }
          const result = await $.process.run(['/bin/sh', $.plugin.root + '/local/node-launch.sh', $.plugin.root + '/desk/open.mjs', '--session', session],
            {cwd:$.plugin.root, timeoutMs:25_000})
          failed = result.exitCode !== 0
        } catch {
          failed = true
        } finally {
          busy = false
          $.ui.invalidate('ui.render')
        }
      },
    })
    if (!failed) return button
    return Box({ flexDirection:'column', rowGap:1, children:[
      button,
      Text({ wrap:'wrap', children:['打开失败。请确认当前是本地 Claude Code 会话，然后重试。'] }),
    ] })
  })
}
