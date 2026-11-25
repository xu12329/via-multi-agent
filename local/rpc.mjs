import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function connect(command, args, options, { notify, handle, exit, diagnose }) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let sequence = 0
  let stopped = false
  let gracefulTimer
  let resolveClosed
  const whenClosed = new Promise(resolve => { resolveClosed = resolve })

  function write(message) {
    if (child.stdin.destroyed) throw Error('Worker process closed')
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  function closed(evidence) {
    if (stopped) return
    stopped = true
    clearTimeout(gracefulTimer)
    for (const item of pending.values()) item.reject(Error('Worker process closed'))
    pending.clear()
    resolveClosed(evidence)
    exit(evidence)
  }

  child.on('error', () => closed({ confirmed: !child.pid }))
  child.on('close', (exitCode, signal) => closed({ confirmed: true, exitCode, signal }))
  child.stdin.on('error', () => child.kill())
  child.stderr.on('data', chunk => diagnose?.(chunk.toString('utf8')))
  createInterface({ input: child.stdout }).on('line', async line => {
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event.method && event.id !== undefined) {
      try { write({ jsonrpc: '2.0', id: event.id, result: await handle(event.method, event.params) }) }
      catch {
        if (!child.stdin.destroyed) write({ jsonrpc: '2.0', id: event.id, error: { code: -32601, message: 'Request unavailable' } })
      }
    } else if (event.method) {
      notify(event.method, event.params)
    } else if (pending.has(event.id)) {
      const { resolve, reject } = pending.get(event.id)
      pending.delete(event.id)
      if (event.error) {
        diagnose?.(event.error.message || '')
        reject(Error('Worker rejected request'))
      }
      else resolve(event.result)
    }
  })

  function terminate() {
    if (stopped || !child.pid || child.exitCode !== null || child.signalCode !== null) return
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }

  return {
    whenClosed,
    request(method, params) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        write({ jsonrpc: '2.0', id, method, params })
        pending.set(id, { resolve, reject })
      })
    },
    notify(method, params) { write({ jsonrpc: '2.0', method, params }) },
    close({ graceful = false } = {}) {
      if (!graceful) return terminate()
      if (stopped || !child.pid) return
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
      gracefulTimer ??= setTimeout(() => { gracefulTimer = null; terminate() }, 750)
      gracefulTimer.unref()
    },
  }
}
