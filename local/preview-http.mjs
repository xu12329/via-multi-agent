import { avatarFiles } from './avatars.mjs'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}

const imageFiles = new Map([
  ...avatarFiles,
])

async function serveImage(req, res, pathname, assetsDirectory) {
  let image
  try {
    const file = await open(join(assetsDirectory, imageFiles.get(pathname)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) return json(res, 404, { error: 'Via image unavailable' })
      image = await file.readFile()
    } finally {
      await file.close()
    }
  } catch { return json(res, 404, { error: 'Via image unavailable' }) }

  const etag = `"${createHash('sha256').update(image).digest('hex')}"`
  const cache = { etag, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, cache)
    return res.end()
  }
  res.writeHead(200, { ...cache, 'content-type': 'image/png', 'content-length': image.length })
  return res.end(image)
}

async function listen(server, target) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(target, resolve)
  })
  return server
}

function registryPath(directory, project) {
  return join(directory, 'controllers-scoped', createHash('sha256').update(project).digest('hex'))
}

export async function registerBoard(directory, project, runId, snapshot, { scoped = false } = {}) {
  const registry = scoped ? registryPath(directory, project) : join(directory, 'controllers')
  await mkdir(registry, { recursive: true, mode: 0o700 })
  const temp = await mkdtemp(join(tmpdir(), 'via-view-'))
  const socketPath = join(temp, 'board.sock')
  const record = join(registry, runId)
  let server
  try {
    server = await listen(createServer((req, res) => {
      if (req.method !== 'GET' || !req.url?.startsWith('/board?')) return json(res, 404, { error: 'Unknown Via view' })
      const group = new URL(req.url, 'http://localhost').searchParams.get('group') || undefined
      return json(res, 200, snapshot(group))
    }), socketPath)
    await writeFile(record, JSON.stringify({ project, runId, socketPath, startedAt: Date.now() }), { mode: 0o600, flag: 'wx' })
    return async () => {
      server.close()
      await Promise.all([rm(record, { force: true }), rm(temp, { recursive: true, force: true })])
    }
  } catch (error) {
    server?.close()
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}

async function liveBoard(directory, project, group, selectedRun) {
  const directories = [registryPath(directory, project), join(directory, 'controllers')]
  const files = (await Promise.all(directories.map(async registry => {
    const entries = await readdir(registry).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    return entries.map(file => ({ registry, file }))
  }))).flat()
  const candidates = (await Promise.all(files.map(async ({ registry, file }) => {
    if (!/^[a-f0-9-]{36}$/.test(file)) return
    const record = await readFile(join(registry, file), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!record) return
    try {
      const info = JSON.parse(record)
      if (info.project === project && info.runId === file && (!selectedRun || selectedRun === file)) return info
    } catch { /* A controller may still be writing its registration. */ }
  }))).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt)
  let fallback
  for (const { runId, socketPath } of candidates) {
    const found = await new Promise(resolve => {
      const upstream = request({ socketPath, path: '/board?' + new URLSearchParams({ group: group ?? '' }), timeout: 800 }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('error', () => resolve(null))
        res.on('end', () => {
          try { resolve(res.statusCode === 200 ? JSON.parse(body) : null) } catch { resolve(null) }
        })
      })
      upstream.on('error', () => resolve(null))
      upstream.on('timeout', () => upstream.destroy())
      upstream.end()
    })
    if (found?.controllerId === runId && (!group || found.tasks.length || found.groups.includes(group))) return found
    if (found?.controllerId === runId) fallback ??= found
  }
  return fallback
}

function withAvatars(live, history, project) {
  const perGroup = new Map()
  const lookup = (group, id) => {
    if (typeof group !== 'string' || typeof id !== 'string') return {}
    if (!perGroup.has(group)) perGroup.set(group, history.avatars(project, group))
    return perGroup.get(group).get(`${live.controllerId}:${id}`) ?? {}
  }
  return {
    ...live,
    tasks: live.tasks.map(task => ({ ...task, ...lookup(task.group, task.id) })),
    peerEvents: live.peerEvents.map(event => ({
      ...event,
      fromAvatarUrl: lookup(event.group, event.from).avatarUrl,
      toAvatarUrl: lookup(event.group, event.to).avatarUrl,
    })),
  }
}

export async function servePreview({ project, directory, history, page, port, assetsDirectory, projectDesk = false, sessionScoped = false, folderControl, accessKey, onAccess = () => {} }) {
  const host = '127.0.0.1'
  const server = createServer(async (req, res) => {
    if (req.headers.host !== `${host}:${server.address().port}`) return json(res, 403, { error: 'Local Via preview only' })
    let url
    try { url = new URL(req.url, `http://${req.headers.host}`) } catch {
      return json(res, 400, { error: 'Invalid Via preview URL' })
    }
    if (url.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Local Via preview only' })
    if (req.method === 'GET' && url.pathname === '/') {
      try {
        const html = await readFile(page)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        })
        return res.end(html)
      } catch { return json(res, 503, { error: 'Via preview page unavailable' }) }
    }
    if ((req.headers.origin && req.headers.origin !== url.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      return json(res, 403, { error: 'Use the same Via preview page' })
    }
    if (req.method === 'GET' && assetsDirectory && imageFiles.has(url.pathname)) return serveImage(req, res, url.pathname, assetsDirectory)
    if (accessKey && req.headers['x-via-desk'] !== accessKey) {
      return json(res, 403, { error: 'Open the desk from its local launcher' })
    }
    if (accessKey) onAccess()

    const scopeFields = (archive = folderControl?.current()) => ({
      mode: sessionScoped && !archive ? 'session' : 'folder',
      folder: archive?.project ?? project,
      canReturn: Boolean(sessionScoped && archive),
      canChooseFolder: Boolean(folderControl),
    })

    if (req.method === 'GET' && accessKey && folderControl && url.pathname === '/api/folder/projects') {
      if (url.search) return json(res, 400, { error: 'The projects list accepts no input' })
      try { return json(res, 200, { projects:await folderControl.projects() }) }
      catch { return json(res, 503, { error: '暂时无法读取已记录项目。' }) }
    }

    if (req.method === 'POST' && accessKey && folderControl &&
        ['/api/folder/select', '/api/folder/return', '/api/folder/open'].includes(url.pathname)) {
      if (req.headers.origin !== url.origin) return json(res, 403, { error: 'Use the same Via preview page' })
      const open = url.pathname === '/api/folder/open'
      const id = url.searchParams.get('id')
      const invalidQuery = open ? !/^[a-f0-9]{64}$/.test(id ?? '') || [...url.searchParams].length !== 1 : Boolean(url.search)
      if (invalidQuery || Number(req.headers['content-length'] || 0) !== 0 || req.headers['transfer-encoding']) {
        return json(res, 400, { error: 'The folder picker accepts no path or other input' })
      }
      try {
        const changed = open ? await folderControl.open(id)
          : url.pathname === '/api/folder/select' ? await folderControl.choose() : folderControl.return()
        if (changed === undefined) return json(res, 404, { error: '该目录已不在已记录项目中。' })
        if (changed === null) return json(res, 409, { error: 'A folder picker is already open' })
        return json(res, 200, { changed, ...scopeFields() })
      } catch {
        return json(res, 400, { error: '无法读取所选目录。请选择已配置的 Via 工作区内的有效文件夹。' })
      }
    }
    if (req.method !== 'GET') return json(res, 403, { error: 'Local Via preview only' })
    const archive = folderControl?.current()
    const currentSession = sessionScoped && !archive
    const source = archive ? 'folder-history' : currentSession ? 'claude-session' : 'legacy-project'
    const scope = folderControl ? scopeFields(archive) : {}
    if (url.pathname === '/api/identity') return json(res, 200, {
      service: 'via-history-preview', project: archive?.project ?? project, ...(projectDesk ? { source, ...scope } : {}),
    })
    const board = url.pathname === '/api/board'
    if (!board && url.pathname !== '/api/history') return json(res, 404, { error: 'Unknown Via view' })
    const query = url.searchParams
    const allowed = board ? ['cwd', 'group'] : ['cwd', 'group', 'at', 'after', 'since', 'until', 'limit']
    if (projectDesk) allowed.push('runId')
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1)) {
      return json(res, 400, { error: 'Invalid query fields' })
    }
    const group = query.get('group')
    if ((!board || query.has('group')) && !group?.trim()) return json(res, 400, { error: 'Select a project group' })
    const options = { group }
    for (const key of ['at', 'after', 'since', 'until', 'limit']) {
      if (!query.has(key)) continue
      const raw = query.get(key)
      const value = Number(raw)
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || (key === 'limit' && (value < 1 || value > 200))) {
        return json(res, 400, { error: 'Invalid history cursor or limit' })
      }
      options[key] = value
    }
    try {
      const sessionGroups = currentSession ? history.sessionGroups() : []
      const scopedProject = archive?.project ?? (currentSession && group ? history.sessionGroup(group)?.cwd : project)
      if (!scopedProject || (archive && group && !archive.groups.includes(group))) {
        return json(res, 404, { error: 'Unknown Via group in this scope' })
      }
      if (query.has('cwd') && query.get('cwd') !== scopedProject) return json(res, 403, { error: 'Project is outside this Via preview' })
      const runs = projectDesk && group ? archive?.runs(group) ?? history.runs(scopedProject, group) : []
      const defaultRun = currentSession ? runs.at(-1)?.runId : null
      const selectedRun = query.get('runId') || defaultRun || (runs.length === 1 ? runs[0].runId : null)
      if (selectedRun && !runs.some(run => run.runId === selectedRun)) return json(res, 404, { error: 'Unknown Via run in this group' })
      if (projectDesk && !board && !selectedRun && runs.length > 1) {
        return json(res, 409, { error: 'Select a Via run', runs })
      }
      const historyOptions = { ...options, cwd: scopedProject, runId: selectedRun }
      const read = fn => archive ? archive.withRun(group, selectedRun, fn) : fn(history)
      const live = archive || (projectDesk && (!group || !selectedRun)) ? null : await liveBoard(directory, scopedProject, group, selectedRun)
      if (!board) {
        const result = await read(selected => selected.read(historyOptions))
        return json(res, 200, { ...result, activeRunId: live?.controllerId ?? null })
      }
      const showApprovals = group && (!projectDesk || selectedRun)
      const archivedApprovals = showApprovals ? await read(selected => selected.approvals(historyOptions)) : null
      return json(res, 200, {
        ...(live ? withAvatars(live, history, scopedProject) : { controllerId: null, groups: [], tasks: [], peerEvents: [] }),
        liveAvailable: Boolean(live),
        historyGroups: archive?.groups ?? (currentSession ? sessionGroups.map(item => item.name) : history.groups(scopedProject)),
        ...(projectDesk ? { runs, source, ...scope } : {}),
        ...(currentSession ? { defaultGroup: sessionGroups[0]?.name ?? null, defaultRun: defaultRun ?? null,
          ...(group ? { groupProject: scopedProject } : {}) } : {}),
        ...(showApprovals ? { archivedApprovals } : {}),
      })
    } catch (error) {
      if (['History cursor is outside this group window', 'History time window is reversed'].includes(error.message)) {
        return json(res, 400, { error: error.message })
      }
      return json(res, 503, { error: 'Via history is temporarily unavailable' })
    }
  })
  return listen(server, { host, port })
}
