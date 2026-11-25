import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { daemonPath } from './daemon-path.mjs'

function connectWorker(path) {
  return new Promise((resolve, reject) => {
    const channel = connect(path)
    channel.once('error', reject)
    channel.once('connect', () => {
      channel.removeListener('error', reject)
      resolve(channel)
    })
  })
}

const { socket, lock } = await daemonPath()
let channel
try {
  channel = await connectWorker(socket)
} catch (error) {
  if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
  const service = fileURLToPath(new URL('./server.mjs', import.meta.url))
  const daemon = spawn('/usr/bin/lockf', ['-k', '-t', '0', lock, process.execPath, service, '--daemon'], {
    detached: true, stdio: 'ignore', env: process.env,
  })
  daemon.on('error', () => {})
  daemon.unref()
  for (let attempt = 0; attempt < 80 && !channel; attempt += 1) {
    await delay(50)
    channel = await connectWorker(socket).catch(error => {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
      return null
    })
  }
  if (!channel) throw Error('Via could not connect to its local controller')
}
channel.on('error', () => { process.exitCode = 1 })
channel.on('close', () => process.stdin.destroy())
process.stdin.pipe(channel)
channel.pipe(process.stdout, { end: false })
