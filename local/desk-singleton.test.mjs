import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deskStateFile, findReusableDesk, removeDeskStateIfOwned } from '../desk/open.mjs'
import { createDesk } from '../desk/service.mjs'

test('deskStateFile deterministically distinguishes session and project scopes', () => {
  const s1 = deskStateFile('/workspace/proj', 'sess-a')
  const s1Again = deskStateFile('/workspace/proj', 'sess-a')
  const s2 = deskStateFile('/workspace/proj', 'sess-b')
  const p1 = deskStateFile('/workspace/proj')
  const p2 = deskStateFile('/workspace/other')

  assert.equal(s1, s1Again)
  assert.notEqual(s1, s2)
  assert.notEqual(s1, p1)
  assert.notEqual(p1, p2)
})

test('findReusableDesk reuses a live authenticated desk and rejects stale, dead, or unauthorized state files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'via-desk-singleton-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const workspace = join(root, 'workspace')
  const historyDir = join(root, 'history')
  await mkdir(workspace, { recursive: true })
  await mkdir(historyDir, { recursive: true })

  let markClosed
  const closed = new Promise(resolve => { markClosed = resolve })
  const desk = await createDesk({ project: workspace, historyDirectory: historyDir, idleMs: 60_000, onClose: markClosed })
  t.after(() => desk.close())

  assert.equal(typeof desk.key, 'string')
  assert.ok(desk.key.length >= 32)
  const port = Number(new URL(desk.origin).port)
  const stateFile = join(root, 'desk-state.json')

  assert.equal(await findReusableDesk(join(root, 'missing.json')), null)

  await writeFile(stateFile, '{not-json')
  assert.equal(await findReusableDesk(stateFile), null)

  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await once(exited, 'exit')
  await writeFile(stateFile, JSON.stringify({
    pid: exited.pid,
    port,
    origin: desk.origin,
    url: desk.url,
    key: desk.key,
  }))
  assert.equal(await findReusableDesk(stateFile), null)

  await writeFile(stateFile, JSON.stringify({
    pid: process.pid,
    port,
    origin: desk.origin,
    url: desk.url,
    key: 'wrong-key',
  }))
  assert.equal(await findReusableDesk(stateFile), null)

  await writeFile(stateFile, JSON.stringify({
    pid: process.pid,
    port,
    origin: desk.origin,
    url: 'https://evil.example/#desk=' + desk.key,
    key: desk.key,
  }))
  assert.equal(await findReusableDesk(stateFile), null)

  const valid = {
    pid: process.pid,
    port,
    origin: desk.origin,
    url: desk.url,
    key: desk.key,
  }
  await writeFile(stateFile, JSON.stringify(valid), { mode: 0o600 })
  assert.deepEqual(await findReusableDesk(stateFile), valid)

  // Closing the desk causes /api/identity health check to fail, so it is no longer reused.
  desk.close()
  await closed
  assert.equal(await findReusableDesk(stateFile), null)

  // PID-guarded state removal only deletes when the file still belongs to this process.
  await writeFile(stateFile, JSON.stringify({ pid: process.pid + 999, port }))
  await removeDeskStateIfOwned(stateFile, process.pid)
  await access(stateFile)

  await writeFile(stateFile, JSON.stringify({ pid: process.pid, port }))
  await removeDeskStateIfOwned(stateFile, process.pid)
  await assert.rejects(() => access(stateFile), { code: 'ENOENT' })
})
