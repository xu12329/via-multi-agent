import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeSessionDirectory } from '../local/claude-session.mjs'
import { openHistory } from '../local/history.mjs'
import { servePreview } from '../local/preview-http.mjs'

import { chooseDeskProject, currentDeskProject } from './project-picker.mjs'
import { listRecordedProjects, openFolderHistory } from './folder-history.mjs'

export { currentDeskProject }

export async function createDesk({ project, historyDirectory = join(homedir(), 'Library/Application Support/Via/claude-history'),
  session, idleMs = 600_000, folderDialog, onClose }) {
  const legacyDirectory = historyDirectory
  const sessionScoped = session !== undefined
  if (sessionScoped) historyDirectory = await claudeSessionDirectory(session)
  const key = randomBytes(32).toString('hex')
  const asset = name => fileURLToPath(new URL(name, import.meta.url))
  const needsSeed = sessionScoped || await access(join(historyDirectory, 'history.sqlite')).then(
    () => false,
    error => {
      if (error.code !== 'ENOENT') throw error
      return true
    },
  )
  if (needsSeed) {
    const seed = await openHistory(historyDirectory, null, Date.now, { sessionScoped, mail: true })
    seed.close()
  }
  const history = await openHistory(historyDirectory, null, Date.now, { readOnly: true, sessionScoped, mail: true })
  let folderArchive = null
  let picking = false

  const folderControl = {
    current: () => folderArchive,
    projects: () => listRecordedProjects(legacyDirectory),
    async open(id) {
      if (picking) return null
      picking = true
      try {
        const project = (await listRecordedProjects(legacyDirectory)).find(item => item.id === id)
        if (!project) return undefined
        const selected = await currentDeskProject(project.path)
        if (selected !== project.path) return undefined
        folderArchive = await openFolderHistory(selected, legacyDirectory)
        return true
      } finally { picking = false }
    },
    async choose() {
      if (picking) return null
      picking = true
      try {
        const selected = await chooseDeskProject(folderArchive?.project ?? project, folderDialog)
        if (!selected) return false
        // Build the new scope before swapping so a failed selection preserves the current desk.
        const archive = await openFolderHistory(selected, legacyDirectory)
        folderArchive = archive
        return true
      } finally { picking = false }
    },
    return() {
      if (picking) return null
      if (!sessionScoped || !folderArchive) return false
      folderArchive = null
      return true
    },
  }

  let server
  let timer
  function close() {
    if (!server?.listening) return
    clearTimeout(timer)
    server.close(() => {
      history.close()
      onClose?.()
    })
  }
  function refreshIdle() {
    clearTimeout(timer)
    timer = setTimeout(close, idleMs)
    timer.unref()
  }
  try {
    server = await servePreview({ project, history, directory: historyDirectory, page: asset('index.html'),
      assetsDirectory: asset('assets/'), port: 0, projectDesk: true, sessionScoped, folderControl, accessKey: key, onAccess: refreshIdle })
  } catch (error) {
    history.close()
    throw error
  }
  refreshIdle()
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, url: `${origin}/#desk=${key}`, key, close }
}
