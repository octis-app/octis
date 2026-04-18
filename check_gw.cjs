const WebSocket = require('ws')
const ws = new WebSocket('ws://127.0.0.1:18789', {
  headers: { 'Authorization': 'Bearer 8UJBwudjSyOifNfPltG0Nedqn1w5UcmTY9abYqGrAcY' }
})
ws.on('open', () => {
  console.log('connected')
  ws.send(JSON.stringify({ id: 'diag', method: 'sessions.list', params: { agentId: 'main' } }))
})
ws.on('message', (d) => {
  const m = JSON.parse(d)
  console.log('MSG type=' + m.type + ' id=' + m.id + ' payload_keys=' + Object.keys(m.payload || m).join(','))
  const sessions = m.payload?.sessions || m.sessions || []
  if (sessions.length) {
    console.log('Session count:', sessions.length)
    sessions.slice(0, 5).forEach(s => console.log(' -', s.key || s.sessionKey))
    ws.close()
    process.exit(0)
  }
})
ws.on('error', e => console.error('err:', e.message))
setTimeout(() => { console.log('done (timeout)'); ws.close(); process.exit(0) }, 10000)
