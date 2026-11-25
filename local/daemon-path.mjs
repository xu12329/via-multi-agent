import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { workspaceRoot } from './workspace.mjs'

export async function daemonPath() {
  const workspace = await realpath(workspaceRoot())
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, 24)
  const directory = join('/tmp', `via-workers-${process.getuid()}-${key}`)
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw Error('Via requires a private local socket directory')
  }
  return { directory, socket: join(directory, 'workers.sock'), lock: join(directory, 'daemon.lock') }
}
