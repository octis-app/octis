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
  console.log('MSG:', JSON.stringify(m).slice(0, 300))
})
ws.on('error', e => console.error('err:', e.message))
setTimeout(() => { ws.close(); process.exit(0) }, 8000)
