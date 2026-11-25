import { readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'

export function workspaceRoot() {
  let configured = process.env.VIA_WORKSPACE
  if (!configured) {
    try { configured = readFileSync(join(homedir(), '.config/via-desk/workspace'), 'utf8').replace(/\r?\n$/, '') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (configured && !isAbsolute(configured)) throw Error('Set an absolute Via workspace directory')
  return configured || process.cwd()
}

export async function viaWorkspace(cwd = process.cwd()) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw Error('Provide an absolute Via workspace path')
  const directory = await realpath(cwd)
  const root = await realpath(workspaceRoot())
  if ((directory !== root && !directory.startsWith(root + sep)) || !(await stat(directory)).isDirectory()) {
    throw Error('Select a directory inside the configured Via workspace')
  }
  return directory
}
