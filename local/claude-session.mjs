import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { workspaceRoot } from './workspace.mjs'
import { join } from 'node:path'

export function claudeSessionId(session) {
  if (typeof session !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session)) {
    throw Error('Via requires the current Claude Code session')
  }
  return session.toLowerCase()
}

async function sessionDirectory(components, create) {
  let directory = await realpath(workspaceRoot())
  for (const name of ['.via', 'claude-sessions', ...components]) {
    directory = join(directory, name)
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    const current = await lstat(directory).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!current) return null
    if (!current.isDirectory()) throw Error('Via session storage requires a local directory')
  }
  return directory
}

export async function claudeSessionDirectory(session) {
  const directory = await sessionDirectory([claudeSessionId(session)], true)
  if (!directory) throw Error('Via session storage disappeared')
  await sessionHistoryExists(directory)
  return directory
}

export async function sessionHistoryExists(directory) {
  const db = await lstat(join(directory, 'history.sqlite')).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (db && (!db.isFile() || db.nlink !== 1)) throw Error('Via session storage requires a separate history file')
  return Boolean(db?.size)
}

export async function existingSessionHistoryDirectories() {
  const root = await sessionDirectory([], false)
  if (!root) return []
  const entries = await readdir(root, { withFileTypes: true })
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let id
    try { id = claudeSessionId(entry.name) } catch { continue }
    if (id !== entry.name) continue
    const directory = join(root, id)
    if (await sessionHistoryExists(directory)) directories.push(directory)
  }
  return directories
}
