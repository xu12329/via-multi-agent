import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { viaWorkspace as currentDeskProject, workspaceRoot } from '../local/workspace.mjs'

export { currentDeskProject }

const folderDialog = `on run argv
  try
    set startFolder to POSIX file (item 1 of argv) as alias
    set deskFolder to choose folder with prompt "请选择要打开通信桌的 Via 工作区项目" default location startFolder
    return POSIX path of deskFolder
  on error number -128
    return ""
  end try
end run`

async function systemFolderDialog(defaultProject) {
  const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-e', folderDialog, defaultProject], { timeout: 120_000 })
  return stdout.replace(/\r?\n$/, '')
}

export async function chooseDeskProject(preferred, ask = systemFolderDialog) {
  const workspace = await currentDeskProject(workspaceRoot())
  const saved = typeof preferred === 'string' && await currentDeskProject(preferred).catch(() => null)
  const selected = await ask(saved === preferred ? saved : workspace)
  return selected ? currentDeskProject(selected) : null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw Error('The project picker accepts no arguments')
  const selected = await chooseDeskProject()
  if (selected) process.stdout.write(selected + '\n')
}
