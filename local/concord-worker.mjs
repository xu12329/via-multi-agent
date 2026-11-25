import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

const { VIA_CONCORD_SOCKET: path, VIA_CONCORD_TOKEN: token } = process.env
if (!path || !token) process.exit(1)

function broker(action, name, args) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => {
      socket.end(JSON.stringify({ token, action, name, args }))
    })
    socket.setEncoding('utf8')
    socket.setTimeout(16_000, () => socket.destroy(Error('Peer request timed out.')))
    let response = ''
    socket.on('data', chunk => { response += chunk })
    socket.on('error', () => reject(Error('Peer broker is unavailable.')))
    socket.on('end', () => {
      try {
        const reply = JSON.parse(response)
        if (!reply.ok) throw Error(reply.error)
        resolve(reply.result)
      } catch (error) { reject(error) }
    })
  })
}

const input = createInterface({ input: process.stdin })
input.on('line', async line => {
  let request
  try { request = JSON.parse(line) } catch { return }
  const { id, method, params } = request
  if (id === undefined) return
  let result
  try {
    switch (method) {
      case 'initialize':
        result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'concord', version: '1.0.0' } }
        break
      case 'tools/list':
        result = { tools: await broker('list') }
        break
      case 'tools/call': {
        result = await broker('call', params.name, params.arguments ?? {})
        break
      }
      case 'ping':
        result = {}
        break
      default:
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\n')
        return
    }
  } catch (error) {
    result = { isError: true, content: [{ type: 'text', text: error.message }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
})
