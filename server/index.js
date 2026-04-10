import express from 'express'
import cors from 'cors'
import pg from 'pg'
import fs from 'fs/promises'
import path from 'path'
import { verifyToken } from '@clerk/backend'

const app = express()
app.use(cors())
app.use(express.json())

// --- Config paths ---
const HOME = process.env.HOME || '/root'
const OPENCLAW_CONFIG = path.join(HOME, '.openclaw/openclaw.json')
const WORKSPACE = process.env.OCTIS_WORKSPACE || path.join(HOME, '.openclaw/workspace')
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md')
const TODOS_FILE = path.join(WORKSPACE, 'TODOS.md')
const MEMORY_DIR = path.join(WORKSPACE, 'memory')

// --- Read gateway token directly from openclaw.json (single source of truth) ---
async function getGatewayConfig() {
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG, 'utf8')
    const config = JSON.parse(raw)
    const token = config?.gateway?.auth?.token || ''
    const url = process.env.GATEWAY_URL || 'wss://octis.duckdns.org/ws'
    return { url, token }
  } catch (e) {
    console.error('[octis] Failed to read openclaw.json:', e.message)
    return { url: 'wss://octis.duckdns.org/ws', token: '' }
  }
}

// --- Clerk auth ---
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_CidHH52KOvMFDQWCyegQHFAsu97xpstV4xG2SGWxpU'

// User config: Clerk userId → role + agentId
const USER_CONFIG = {
  // Casin (casin.hoa@beatimo.ca)
  'user_3C2XKvwT0WPSIz0JFdd7GJIMq1V': { role: 'owner', agentId: 'main' },
  // Casin (admin@beatimo.ca)
  'user_3BrnhtjopGTmVIepkoMlRzjLG0t': { role: 'owner', agentId: 'main' },
  // Add team members here: 'user_XXXX': { role: 'member', agentId: 'nexus' }
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ error: 'Missing auth token' })
    const payload = await verifyToken(token, { secretKey: CLERK_SECRET_KEY })
    const userId = payload?.sub
    if (!userId) return res.status(401).json({ error: 'Invalid token' })
    req.clerkUserId = userId
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Auth failed', detail: e.message })
  }
}

// --- Postgres ---
const pool = new pg.Pool({
  host: process.env.PG_HOST || '34.95.39.115',
  database: process.env.PG_DB || 'beatimo_warehouse',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'M$fxV6bM!wQRSn',
  ssl: false,
})

const PORT = process.env.OCTIS_API_PORT || 3747

// --- Endpoints ---

app.get('/api/health', (req, res) => res.json({ ok: true }))

// Gateway config — reads token live from openclaw.json every time
app.get('/api/gateway-config', requireAuth, async (req, res) => {
  const userConf = USER_CONFIG[req.clerkUserId]
  if (!userConf) return res.status(403).json({ error: 'User not provisioned' })
  const gateway = await getGatewayConfig()
  res.json({
    url: gateway.url,
    token: gateway.token,
    agentId: userConf.agentId || '',
    role: userConf.role,
  })
})

app.get('/api/me', requireAuth, (req, res) => {
  const userConf = USER_CONFIG[req.clerkUserId]
  if (!userConf) return res.status(403).json({ error: 'User not provisioned' })
  res.json({ userId: req.clerkUserId, role: userConf.role, agentId: userConf.agentId })
})

// Session costs
app.get('/api/costs', async (req, res) => {
  try {
    const { rows: daily } = await pool.query(`
      SELECT
        cost_date AS date,
        SUM(total_cost_usd) AS total_cost_usd,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(session_count) AS session_count
      FROM raw_nexus.claw_user_daily_costs
      WHERE cost_date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY cost_date
      ORDER BY cost_date DESC
    `)
    const { rows: sessions } = await pool.query(`
      SELECT
        session_id AS session_key,
        first_message AS session_label,
        sender_name,
        SUM(total_cost_usd) AS cost,
        MAX(last_ts) AS last_activity,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM raw_nexus.claw_session_costs
      WHERE session_date >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY session_id, first_message, sender_name
      ORDER BY cost DESC
      LIMIT 50
    `)
    const { rows: todaySessions } = await pool.query(`
      SELECT
        session_id AS session_key,
        first_message AS session_label,
        sender_name,
        SUM(total_cost_usd) AS cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM raw_nexus.claw_session_costs
      WHERE session_date = CURRENT_DATE
      GROUP BY session_id, first_message, sender_name
      ORDER BY cost DESC
      LIMIT 20
    `)
    const { rows: todayRow } = await pool.query(`
      SELECT COALESCE(SUM(total_cost_usd), 0) AS today_cost
      FROM raw_nexus.claw_user_daily_costs
      WHERE cost_date = CURRENT_DATE
    `)
    res.json({
      today: parseFloat(todayRow[0]?.today_cost || 0),
      daily: daily.map(r => ({ ...r, total_cost_usd: parseFloat(r.total_cost_usd) })),
      sessions: sessions.map(r => ({ ...r, cost: parseFloat(r.cost) })),
      todaySessions: todaySessions.map(r => ({ ...r, cost: parseFloat(r.cost) })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Session labels
app.get('/api/session-labels', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT session_id, first_message, sender_name, session_date
      FROM raw_nexus.claw_session_costs
      ORDER BY session_date DESC
    `)
    const labels = {}
    for (const row of rows) {
      const raw = row.first_message || ''
      let label = raw
        .replace(/^System: \[\d{4}-\d{2}-\d{2}[^\]]*\] Slack DM from [^:]+: /i, '')
        .replace(/^System: \[[^\]]*\] /i, '')
        .replace(/^New Assistant Thread\s*/i, '')
        .replace(/^Nouveau fil de discussion assistant\s*/i, '')
        .replace(/Conversation info \(untrusted metadata\):[\s\S]*/i, '')
        .replace(/Sender \(untrusted metadata\):[\s\S]*/i, '')
        .replace(/\n[\s\S]*/s, '')
        .trim()
        .slice(0, 70)
      if (!label) label = row.session_id.slice(0, 20)
      labels[row.session_id] = label
    }
    res.json(labels)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Memory
app.get('/api/memory', async (req, res) => {
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

app.get('/api/projects', async (req, res) => {
  try {
    const files = await fs.readdir(MEMORY_DIR)
    const projectFiles = files.filter(f => f.endsWith('.md') && !/^\d{4}-\d{2}-\d{2}/.test(f))
    const projects = await Promise.all(
      projectFiles.map(async f => {
        const filepath = path.join(MEMORY_DIR, f)
        const [content, stat] = await Promise.all([
          fs.readFile(filepath, 'utf8').catch(() => ''),
          fs.stat(filepath).catch(() => null),
        ])
        return { name: f.replace('.md', ''), content, size: stat?.size || 0, mtime: stat?.mtime || null }
      })
    )
    res.json({ projects })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/todos', async (req, res) => {
  try {
    const todos = await fs.readFile(TODOS_FILE, 'utf8').catch(() => '')
    res.json({ todos })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Serve static frontend
if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const distPath = path.join(__dirname, '..', 'dist')
  app.use(express.static(distPath))
  app.use((req, res) => res.sendFile(path.join(distPath, 'index.html')))
}

app.listen(PORT, () => {
  console.log(`[octis] API server on http://localhost:${PORT}`)
  getGatewayConfig().then(gw => {
    console.log(`[octis] Gateway: ${gw.url} | token: ${gw.token ? gw.token.slice(0,8) + '...' : 'MISSING'}`)
  })
})
