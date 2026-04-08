import WebSocket from 'ws'

const ws = new WebSocket('ws://34.152.7.106:18789')
let done = false

ws.on('message', (data) => {
  const msg = JSON.parse(data)
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    ws.send(JSON.stringify({
      type: 'req', id: 'connect', method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        client: { id: 'test', version: '0.1.0', platform: 'node', mode: 'ui' },
        role: 'operator', scopes: ['operator.read'], caps: [], commands: [], permissions: {},
        auth: { token: '8UJBwudjSyOifNfPltG0Nedqn1w5UcmTY9abYqGrAcY' },
        locale: 'en-US', userAgent: 'test/0.1'
      }
    }))
  }
  if (msg.type === 'res' && msg.id === 'connect' && msg.ok) {
    ws.send(JSON.stringify({ type: 'req', id: 'list', method: 'sessions.list', params: {} }))
  }
  if (msg.type === 'res' && msg.id === 'list') {
    const sessions = msg.payload?.sessions || []
    console.log('Total sessions:', sessions.length)
    if (sessions[0]) {
      console.log('Keys:', Object.keys(sessions[0]))
      console.log('Sample 1:', JSON.stringify(sessions[0], null, 2))
    }
    if (sessions[1]) {
      console.log('Sample 2:', JSON.stringify(sessions[1], null, 2))
    }
    done = true
    ws.close()
  }
})
ws.on('close', () => { if (!done) console.log('closed without result') })
ws.on('error', (e) => console.error('error', e.message))
setTimeout(() => { if (!done) { console.log('timeout'); ws.close() } }, 10000)
