import { createHash } from 'node:crypto'
import { currentDeskProject } from './project-picker.mjs'
import { existingSessionHistoryDirectories, sessionHistoryExists } from '../local/claude-session.mjs'
import { openHistory } from '../local/history.mjs'

async function historyDirectories(legacyDirectory) {
  const directories = await existingSessionHistoryDirectories()
  if (await sessionHistoryExists(legacyDirectory)) directories.push(legacyDirectory)
  return directories
}

export async function listRecordedProjects(legacyDirectory) {
  const projects = new Map()
  for (const directory of await historyDirectories(legacyDirectory)) {
    const history = await openHistory(directory, null, Date.now, { readOnly:true })
    try {
      for (const row of history.projects()) {
        const project = projects.get(row.path) ?? { path:row.path, lastCommunicationAt:null, lastActivityAt:0 }
        if (row.lastCommunicationAt !== null) project.lastCommunicationAt = Math.max(project.lastCommunicationAt ?? 0, row.lastCommunicationAt)
        project.lastActivityAt = Math.max(project.lastActivityAt, row.lastActivityAt ?? 0)
        projects.set(row.path, project)
      }
    } finally { history.close() }
  }
  const visible = await Promise.all([...projects.values()].map(async project => {
    const trusted = await currentDeskProject(project.path).catch(() => null)
    if (trusted !== project.path) return null
    return { ...project, id:createHash('sha256').update(trusted).digest('hex') }
  }))
  const timestamp = item => item.lastCommunicationAt ?? item.lastActivityAt
  return visible.filter(Boolean).sort((a,b) => Number(b.lastCommunicationAt !== null) - Number(a.lastCommunicationAt !== null) ||
    timestamp(b) - timestamp(a) || a.path.localeCompare(b.path))
}

export async function openFolderHistory(project, legacyDirectory) {
  const directories = await historyDirectories(legacyDirectory)
  const groups = new Map()
  for (const directory of directories) {
    const history = await openHistory(directory, null, Date.now, { readOnly:true, mail:true })
    try {
      for (const name of history.groups(project)) {
        const group = groups.get(name) ?? []
        group.push(...history.runs(project, name).map(run => ({ run, directory })))
        groups.set(name, group)
      }
    } finally { history.close() }
  }
  for (const group of groups.values()) group.sort((a,b) => a.run.at - b.run.at || a.run.runId.localeCompare(b.run.runId))

  return {
    project,
    groups: [...groups.keys()].sort((a,b) => a.localeCompare(b)),
    runs: name => (groups.get(name) ?? []).map(item => item.run),
    async withRun(name, runId, read) {
      const match = groups.get(name)?.find(item => item.run.runId === runId)
      if (!match) throw Error('History run is outside this group')
      const history = await openHistory(match.directory, null, Date.now, { readOnly:true, mail:true })
      try { return read(history) } finally { history.close() }
    },
  }
}
