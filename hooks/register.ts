import type { Register } from 'claude-code'
import { deskApi, initializeDesk, registerDesk } from './desk'
import { initializePanel, panelApi, registerPanel } from './panel'

export const register: Register = (on) => {
  registerPanel(on)
  registerDesk(on)
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await initializePanel(panelApi($)).catch(() => undefined)
    await initializeDesk(deskApi($)).catch(() => undefined)
    return started
  })
}
