import { execFile, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { workspaceRoot } from '../local/workspace.mjs'
import { createDesk, currentDeskProject } from './service.mjs'

export function deskStateFile(project, session) {
  const scope = session ? 'session:' + session : 'project:' + project
  const digest = createHash('sha256').update(scope).digest('hex').slice(0, 16)
  return join(tmpdir(), `via-desk-${process.getuid?.() ?? 'user'}-${digest}.json`)
}

export async function removeDeskStateIfOwned(stateFile, pid = process.pid) {
  try {
    const current = JSON.parse(await readFile(stateFile, 'utf8'))
    if (current?.pid === pid) await rm(stateFile, { force: true })
  } catch {}
}

export async function findReusableDesk(stateFile) {
  let state
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch {
    return null
  }
  if (!state || typeof state !== 'object') return null
  if (!Number.isSafeInteger(state.pid) || state.pid <= 0) return null
  if (!Number.isSafeInteger(state.port) || state.port < 1 || state.port > 65535) return null
  if (typeof state.key !== 'string' || !state.key) return null
  if (typeof state.url !== 'string') return null
  try {
    if (new URL(state.url).origin !== `http://127.0.0.1:${state.port}`) return null
  } catch {
    return null
  }
  try {
    process.kill(state.pid, 0)
  } catch {
    return null
  }
  const healthy = await new Promise(resolve => {
    let settled = false
    const finish = ok => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const req = httpRequest({
      host: '127.0.0.1',
      port: state.port,
      path: '/api/identity',
      method: 'GET',
      agent: false,
      headers: { 'x-via-desk': state.key },
      timeout: 1000,
    }, res => {
      res.resume()
      res.once('end', () => finish(res.statusCode === 200))
      res.once('error', () => finish(false))
    })
    req.once('timeout', () => { req.destroy(); finish(false) })
    req.once('error', () => finish(false))
    req.end()
  })
  return healthy ? state : null
}

async function main() {
  const args = process.argv.slice(2)
  const serving = args[0] === '--serve' && Boolean(process.send)
  if (serving) args.shift()
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--session')) throw Error('Invalid communication desk launch')
  const session = args[1]
  const project = await currentDeskProject(session ? workspaceRoot() : process.cwd())
  const historyDirectory = join(homedir(), 'Library/Application Support/Via/claude-history')
  const stateFile = deskStateFile(project, session)
  if (serving) {
    const desk = await createDesk({
      project,
      historyDirectory,
      session,
      onClose: () => { void removeDeskStateIfOwned(stateFile, process.pid) },
    })
    const port = Number(new URL(desk.origin).port)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      desk.close()
      void removeDeskStateIfOwned(stateFile, process.pid)
    }
    try {
      await writeFile(
        stateFile,
        JSON.stringify({ pid: process.pid, port, origin: desk.origin, url: desk.url, key: desk.key }),
        { mode: 0o600 },
      )
      await promisify(execFile)('/usr/bin/open', [desk.url], { timeout: 5000 })
      process.once('SIGTERM', close)
      process.once('SIGINT', close)
      process.send({ ready: true }, () => process.disconnect())
    } catch {
      close()
      process.exitCode = 1
    }
  } else {
    const existing = await findReusableDesk(stateFile)
    if (existing) {
      await promisify(execFile)('/usr/bin/open', [existing.url], { timeout: 5000 })
      return
    }
    const child = fork(fileURLToPath(import.meta.url), ['--serve', ...args], {
      cwd: project, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(Error('Communication desk could not start')) }, 8000)
      const finished = () => clearTimeout(timeout)
      child.once('error', error => { finished(); reject(error) })
      child.once('exit', () => { finished(); reject(Error('Communication desk could not start')) })
      child.once('message', response => {
        if (response?.ready !== true) return
        finished()
        child.unref()
        resolve()
      })
    })
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
      || fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  } catch {
    return false
  }
})()

if (isMain) {
  await main()
}
