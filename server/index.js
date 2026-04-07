import express from 'express'
import cors from 'cors'
import pg from 'pg'
import fs from 'fs/promises'
import path from 'path'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.join(__dirname, '../dist')
const app = express()

// --- Config ---
const PORT = process.env.PORT || process.env.OCTIS_API_PORT || 3747
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789'
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '639c6816ff74eb188727ff5ff62423be0de9b6e1f62862e1f6f6207970c284b5'
const API_TOKEN = process.env.OCTIS_API_TOKEN || 'octis-yumi-2026'

// --- CORS ---
const ALLOWED_ORIGINS = [
  'https://octis-dt2bgwjqna-nn.a.run.app',
  'http://localhost:5173',
  'http://localhost:3747',
  'http://127.0.0.1:5173',
]
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: false }))
app.use(express.json())

// --- Token auth middleware ---
function requireToken(req, res, next) {
  if (!API_TOKEN) return next()
  const auth = req.headers['x-octis-token'] || req.query.token
  if (auth !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// --- Postgres ---
const pool = new pg.Pool({
  host: process.env.PG_HOST || '34.95.39.115',
  database: process.env.PG_DB || 'beatimo_warehouse',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'M$fxV6bM!wQRSn',
  ssl: false,
})

// --- Memory paths ---
const WORKSPACE = process.env.OCTIS_WORKSPACE || path.join(process.env.HOME, '.openclaw/workspace')
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md')
const TODOS_FILE = path.join(WORKSPACE, 'TODOS.md')
const MEMORY_DIR = path.join(WORKSPACE, 'memory')

// --- Endpoints ---

// Serve static frontend
app.use(express.static(DIST_DIR))

app.get('/api/health', (req, res) => res.json({ ok: true }))

// Session costs
app.get('/api/costs', async (req, res) => {
  try {
    const { rows: daily } = await pool.query(`
      SELECT cost_date AS date, SUM(total_cost_usd) AS total_cost_usd,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        COUNT(DISTINCT session_count) AS session_count
      FROM raw_nexus.claw_user_daily_costs
      WHERE cost_date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY cost_date ORDER BY cost_date DESC
    `)
    const { rows: sessions } = await pool.query(`
      SELECT session_id AS session_key, first_message AS session_label, sender_name,
        SUM(total_cost_usd) AS cost, MAX(last_ts) AS last_activity,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
      FROM raw_nexus.claw_session_costs
      WHERE session_date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY session_id, first_message, sender_name
      ORDER BY cost DESC LIMIT 50
    `)
    const { rows: todayRow } = await pool.query(`
      SELECT COALESCE(SUM(total_cost_usd), 0) AS today_cost
      FROM raw_nexus.claw_user_daily_costs WHERE cost_date = CURRENT_DATE
    `)
    res.json({
      today: parseFloat(todayRow[0]?.today_cost || 0),
      daily: daily.map(r => ({ ...r, total_cost_usd: parseFloat(r.total_cost_usd) })),
      sessions: sessions.map(r => ({ ...r, cost: parseFloat(r.cost) })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Per-session cost breakdown
app.get('/api/costs/session/:sessionKey', async (req, res) => {
  try {
    const { sessionKey } = req.params
    const { rows } = await pool.query(`
      SELECT
        SUM(total_cost_usd) AS total,
        SUM(turn_count) AS msg_count,
        MAX(last_ts) AS last_activity
      FROM raw_nexus.claw_session_costs
      WHERE session_id = $1
    `, [sessionKey])
    if (!rows[0] || rows[0].total == null) return res.json({ total: 0, lastMsg: null, msgCount: 0 })

    // Last message cost: most recent single row
    const { rows: lastRows } = await pool.query(`
      SELECT total_cost_usd
      FROM raw_nexus.claw_session_costs
      WHERE session_id = $1
      ORDER BY last_ts DESC LIMIT 1
    `, [sessionKey])

    res.json({
      total: parseFloat(rows[0].total || 0),
      lastMsg: lastRows[0] ? parseFloat(lastRows[0].total_cost_usd) : null,
      msgCount: parseInt(rows[0].msg_count || 0),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Memory — protected
app.get('/api/memory', requireToken, async (req, res) => {
  try {
    const [memory, todos] = await Promise.all([
      fs.readFile(MEMORY_FILE, 'utf8').catch(() => ''),
      fs.readFile(TODOS_FILE, 'utf8').catch(() => ''),
    ])
    let recentLogs = []
    try {
      const files = await fs.readdir(MEMORY_DIR)
      const dateFiles = files.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-3).reverse()
      recentLogs = await Promise.all(
        dateFiles.map(async f => ({
          date: f.replace('.md', ''),
          content: await fs.readFile(path.join(MEMORY_DIR, f), 'utf8').catch(() => ''),
        }))
      )
    } catch {}
    let projects = []
    try {
      const files = await fs.readdir(MEMORY_DIR)
      const projectFiles = files.filter(f => f.endsWith('.md') && !/^\d{4}-\d{2}-\d{2}/.test(f))
      projects = await Promise.all(
        projectFiles.map(async f => ({
          name: f.replace('.md', ''),
          preview: (await fs.readFile(path.join(MEMORY_DIR, f), 'utf8').catch(() => '')).slice(0, 500),
        }))
      )
    } catch {}
    res.json({ memory, todos, recentLogs, projects })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Todos — protected
app.get('/api/todos', requireToken, async (req, res) => {
  try {
    const todos = await fs.readFile(TODOS_FILE, 'utf8').catch(() => '')
    res.json({ todos })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Sessions list via gateway (for Octis UI)
app.get('/api/sessions', requireToken, async (req, res) => {
  // Fetch sessions via a short-lived local WS connection
  try {
    const sessions = await gatewayRequest({ type: 'req', id: 'list-1', method: 'sessions.list', params: {} })
    res.json({ sessions: sessions?.payload?.sessions || sessions?.sessions || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- Gateway utility: one-shot request ---
function gatewayRequest(reqMsg, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL)
    let resolved = false
    const done = (val) => { resolved = true; ws.close(); resolve(val) }
    const fail = (e) => { if (!resolved) { resolved = true; ws.close(); reject(e) } }
    const timer = setTimeout(() => fail(new Error('gateway timeout')), timeoutMs)

    ws.on('open', () => {
      // Wait for challenge then send connect
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'req', id: 'connect-1', method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'octis-server', version: '0.1.0', platform: 'node', mode: 'operator' },
            role: 'operator', scopes: ['operator.read', 'operator.write'],
            caps: [], commands: [], permissions: {},
            auth: { token: GATEWAY_TOKEN },
            locale: 'en-US', userAgent: 'octis-server/0.1.0',
          }
        }))
      }, 50)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'res' && msg.payload?.type === 'hello-ok') {
          // Connected — send actual request
          ws.send(JSON.stringify(reqMsg))
        } else if (msg.type === 'res' && msg.id === reqMsg.id) {
          clearTimeout(timer)
          done(msg)
        }
      } catch {}
    })

    ws.on('error', fail)
    ws.on('close', () => { if (!resolved) fail(new Error('gateway disconnected')) })
  })
}

// --- WebSocket proxy server ---
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (clientWs, req) => {
  // Validate token from query param or header
  const urlParams = new URL(req.url, 'http://localhost').searchParams
  const clientToken = urlParams.get('token') || req.headers['x-octis-token']
  if (API_TOKEN && clientToken !== API_TOKEN) {
    clientWs.close(4401, 'Unauthorized')
    return
  }

  console.log('[octis] Browser client connected')

  // Connect to local gateway
  const gatewayWs = new WebSocket(GATEWAY_URL)
  let gatewayReady = false
  const pendingFromBrowser = []

  gatewayWs.on('open', () => {
    // Send connect with local gateway token
    setTimeout(() => {
      gatewayWs.send(JSON.stringify({
        type: 'req', id: 'proxy-connect-1', method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'octis-proxy', version: '0.1.0', platform: 'node', mode: 'operator' },
          role: 'operator', scopes: ['operator.read', 'operator.write'],
          caps: [], commands: [], permissions: {},
          auth: { token: GATEWAY_TOKEN },
          locale: 'en-US', userAgent: 'octis-proxy/0.1.0',
        }
      }))
    }, 50)
  })

  gatewayWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      // Mark as connected on hello-ok
      if (msg.type === 'res' && msg.payload?.type === 'hello-ok') {
        gatewayReady = true
        // Flush pending messages from browser
        for (const m of pendingFromBrowser) gatewayWs.send(m)
        pendingFromBrowser.length = 0
      }
      // Forward all messages to browser
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data.toString())
      }
    } catch {}
  })

  gatewayWs.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1001, 'Gateway disconnected')
  })

  gatewayWs.on('error', (err) => {
    console.error('[octis] Gateway WS error:', err.message)
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'Gateway error')
  })

  // Browser → gateway
  clientWs.on('message', (data) => {
    if (gatewayReady && gatewayWs.readyState === WebSocket.OPEN) {
      gatewayWs.send(data.toString())
    } else {
      pendingFromBrowser.push(data.toString())
    }
  })

  clientWs.on('close', () => {
    console.log('[octis] Browser client disconnected')
    gatewayWs.close()
  })

  clientWs.on('error', () => gatewayWs.close())
})

// SPA fallback (Express 5 / path-to-regexp v8 compatible)
app.get(/.*/, (req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Octis API + WS proxy running on http://0.0.0.0:${PORT}`)
  console.log(`Gateway proxy: ${GATEWAY_URL} → /ws`)
})
