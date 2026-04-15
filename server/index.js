import express from 'express'
import cors from 'cors'
import pg from 'pg'
import fs from 'fs/promises'
import path from 'path'
import { verifyToken } from '@clerk/backend'
import webpush from 'web-push'

// VAPID config for Web Push
const VAPID_PUBLIC = 'BD3-GUgiWEFtJPoQGpSVy6YtoACLQtVCvU6Xu8WwiuvDxVFfE4Z9_ayommNrdmkhFzdWlKu9zkZNNKofWL3qrn8'
const VAPID_PRIVATE = '23EU9_x-Uu7U9DTN7X93CIDDhxFZ5ulQK9qri_pFSD8'
webpush.setVapidDetails('mailto:casin.hoa@beatimo.ca', VAPID_PUBLIC, VAPID_PRIVATE)

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

// --- Config paths ---
const HOME = process.env.HOME || '/root'
const OPENCLAW_CONFIG = path.join(HOME, '.openclaw/openclaw.json')
const WORKSPACE = process.env.OCTIS_WORKSPACE || path.join(HOME, '.openclaw/workspace')
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md')
const TODOS_FILE = path.join(WORKSPACE, 'TODOS.md')
const MEMORY_DIR = path.join(WORKSPACE, 'memory')
const LABELS_FILE = path.join(WORKSPACE, 'memory/octis-labels.json')
const USER_GATEWAYS_FILE = path.join(WORKSPACE, 'memory/octis-user-gateways.json')

// Per-user gateway config helpers
async function readUserGateways() {
  try { return JSON.parse(await fs.readFile(USER_GATEWAYS_FILE, 'utf8')) } catch { return {} }
}
async function writeUserGateways(data) {
  await fs.writeFile(USER_GATEWAYS_FILE, JSON.stringify(data, null, 2))
}

// Persistent label helpers
async function readLabels() {
  try { return JSON.parse(await fs.readFile(LABELS_FILE, 'utf8')) } catch { return {} }
}
async function writeLabels(labels) {
  await fs.writeFile(LABELS_FILE, JSON.stringify(labels, null, 2))
}

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

// Owner config: Clerk userId → role + agentId (server-managed, gateway from openclaw.json)
const USER_CONFIG = {
  // Casin (casin.hoa@beatimo.ca)
  'user_3C2XKvwT0WPSIz0JFdd7GJIMq1V': { role: 'owner', agentId: 'main' },
  // Casin (admin@beatimo.ca)
  'user_3BrnhtjopGTmVIepkoMlRzjLG0t': { role: 'owner', agentId: 'main' },
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

// Gateway config
app.get('/api/gateway-config', requireAuth, async (req, res) => {
  const userConf = USER_CONFIG[req.clerkUserId]
  if (userConf) {
    // Owner: gateway config is server-managed (from openclaw.json)
    const gateway = await getGatewayConfig()
    return res.json({ url: gateway.url, token: gateway.token, agentId: userConf.agentId || '', role: userConf.role })
  }
  // Member: check saved user gateway
  const gateways = await readUserGateways()
  const saved = gateways[req.clerkUserId]
  if (saved) return res.json({ url: saved.url, token: saved.token, agentId: '', role: 'member' })
  // New user — needs setup
  return res.json({ needsSetup: true, role: 'new' })
})

// Save gateway config for a non-owner user
app.post('/api/gateway-config', requireAuth, async (req, res) => {
  if (USER_CONFIG[req.clerkUserId]) return res.status(403).json({ error: 'Owner config is server-managed' })
  const { url, token } = req.body
  if (!url || !token) return res.status(400).json({ error: 'url and token required' })
  const gateways = await readUserGateways()
  gateways[req.clerkUserId] = { url, token, updatedAt: new Date().toISOString() }
  await writeUserGateways(gateways)
  res.json({ ok: true, role: 'member' })
})

app.get('/api/me', requireAuth, async (req, res) => {
  const userConf = USER_CONFIG[req.clerkUserId]
  if (userConf) return res.json({ userId: req.clerkUserId, role: userConf.role, agentId: userConf.agentId })
  const gateways = await readUserGateways()
  const saved = gateways[req.clerkUserId]
  const role = saved ? 'member' : 'new'
  res.json({ userId: req.clerkUserId, role, agentId: '' })
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

// Session autoname — call Claude Haiku to generate a curated topic title
app.post('/api/session-autoname', async (req, res) => {
  try {
    const { messages } = req.body
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'No messages provided' })

    // Read Anthropic key from agent auth profiles
    const authProfilePath = path.join(HOME, '.openclaw/agents/main/agent/auth-profiles.json')
    let apiKey = ''
    try {
      const prof = JSON.parse(await fs.readFile(authProfilePath, 'utf8'))
      apiKey = prof?.profiles?.['anthropic:default']?.key || ''
    } catch {}
    if (!apiKey) return res.status(500).json({ error: 'No Anthropic API key found' })

    // Build a short excerpt of the conversation for context
    const excerpt = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(0, 6)
      .map(m => {
        const content = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content)
            ? m.content.filter(b => b.type === 'text').map(b => b.text).join('')
            : String(m.content))
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${content.slice(0, 300)}`
      })
      .join('\n')

    const prompt = `Given this conversation excerpt, generate a short session title: 3–5 words. \nCapture the specific topic or task — be concrete, not generic. No filler words ("help with", "working on", "discussion about"). No quotes, no period.\nExamples: "Octis Sidebar Layout Fixes", "Sage GL Batch Push", "Centurion Deal Analysis", "Loan Schema Audit", "Email Triage Setup".\n\n${excerpt}\n\nTitle:`

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 30,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const data = await r.json()
    const label = (data?.content?.[0]?.text || '').trim().replace(/^[\'"]+|[\'"]+$/g, '').slice(0, 60)
    if (!label) return res.status(500).json({ error: 'Empty label from Claude' })
    res.json({ label })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Session rename (Postgres)
app.post('/api/session-rename', async (req, res) => {
  try {
    const { sessionKey, label } = req.body
    if (!sessionKey || !label) return res.status(400).json({ error: 'Missing sessionKey or label' })
    await pool.query(
      `INSERT INTO raw_nexus.octis_session_labels (session_key, label, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (session_key) DO UPDATE SET label = $2, updated_at = NOW()`,
      [sessionKey, label]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Session labels (Postgres — base from claw_session_costs, overrides from octis_session_labels)
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
      // Strip [Thread history - for context] block and extract user message
      const slackDmMatch = label.match(/Slack DM from [^:]+:\s*(.+)/i)
      if (slackDmMatch) {
        label = slackDmMatch[1]
      } else {
        label = label
          .replace(/^\[Thread history[^\]]*\][\s\S]*?System:\s*\[[^\]]*\]\s*/i, '')
          .replace(/^System: \[\d{4}-\d{2}-\d{2}[^\]]*\] Slack DM from [^:]+: /i, '')
          .replace(/^System: \[[^\]]*\] /i, '')
          .replace(/^New Assistant Thread\s*/i, '')
          .replace(/^Nouveau fil de discussion assistant\s*/i, '')
      }
      label = label
        .replace(/Conversation info \(untrusted metadata\):[\s\S]*/i, '')
        .replace(/Sender \(untrusted metadata\):[\s\S]*/i, '')
        .replace(/\n[\s\S]*/s, '')
        .trim()
        .slice(0, 70)
      if (!label) label = row.session_id.slice(0, 20)
      labels[row.session_id] = label
    }
    // Build a secondary index: slackThreadId → label (extracted from first_message)
    // This allows matching gateway keys like agent:main:slack:direct:u08ml:1776100438.018119
    const threadIdIndex = {}
    for (const row of rows) {
      const match = (row.first_message || '').match(/slack message id:\s*([\d.]+)/i)
      if (match) threadIdIndex[match[1]] = labels[row.session_id]
    }
    // Merge Postgres overrides (renames) on top — stored by gateway key
    const { rows: overrides } = await pool.query('SELECT session_key, label FROM raw_nexus.octis_session_labels')
    for (const r of overrides) labels[r.session_key] = r.label
    // Include thread ID index in response
    Object.assign(labels, threadIdIndex)
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

// Projects — Postgres-backed
// Return memory file content for a project (used for session context injection)
app.get('/api/project-memory/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT memory_file, description, name FROM raw_nexus.octis_projects WHERE slug=$1',
      [req.params.slug]
    )
    const project = rows[0]
    if (!project) return res.json({ content: '' })
    // Try memory_file field first, then fall back to memory/<slug>.md
    const candidates = [
      project.memory_file ? path.join(WORKSPACE, project.memory_file) : null,
      path.join(MEMORY_DIR, `${req.params.slug}.md`),
    ].filter(Boolean)
    let content = ''
    for (const p of candidates) {
      try { content = await fs.readFile(p, 'utf8'); break } catch {}
    }
    // Return first 800 chars (minimal context)
    res.json({ content: content.slice(0, 800), description: project.description || '' })
  } catch (err) {
    res.json({ content: '' })
  }
})

app.get('/api/projects', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, slug, emoji, color, description, memory_file, position, created_at, updated_at FROM raw_nexus.octis_projects ORDER BY position, name'
    )
    res.json({ projects: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/projects', requireAuth, async (req, res) => {
  try {
    const { name, emoji = '📁', color = '#6366f1', description = '', memory_file = '' } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })
    const slug = name.trim()
    const { rows } = await pool.query(
      `INSERT INTO raw_nexus.octis_projects (name, slug, emoji, color, description, memory_file)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, emoji=EXCLUDED.emoji, color=EXCLUDED.color, description=EXCLUDED.description, memory_file=EXCLUDED.memory_file, updated_at=now()
       RETURNING *`,
      [slug, slug, emoji, color, description, memory_file]
    )
    res.json({ project: rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.patch('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const { name, emoji, color, description, memory_file, position } = req.body
    const sets = []
    const vals = []
    let i = 1
    if (name !== undefined)        { sets.push(`name=$${i++}`);         vals.push(name) }
    if (emoji !== undefined)       { sets.push(`emoji=$${i++}`);        vals.push(emoji) }
    if (color !== undefined)       { sets.push(`color=$${i++}`);        vals.push(color) }
    if (description !== undefined) { sets.push(`description=$${i++}`);  vals.push(description) }
    if (memory_file !== undefined) { sets.push(`memory_file=$${i++}`);  vals.push(memory_file) }
    if (position !== undefined)    { sets.push(`position=$${i++}`);     vals.push(position) }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' })
    sets.push(`updated_at=now()`)
    vals.push(id)
    const { rows } = await pool.query(
      `UPDATE raw_nexus.octis_projects SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`,
      vals
    )
    res.json({ project: rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM raw_nexus.octis_projects WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Hidden/archived sessions (server-persisted, cross-device)
app.get('/api/hidden-sessions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT session_key FROM raw_nexus.octis_hidden_sessions')
    res.json(rows.map(r => r.session_key))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/hidden-sessions/hide', requireAuth, async (req, res) => {
  try {
    const { sessionKey } = req.body
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    await pool.query(
      'INSERT INTO raw_nexus.octis_hidden_sessions (session_key) VALUES ($1) ON CONFLICT DO NOTHING',
      [sessionKey]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/hidden-sessions/unhide', requireAuth, async (req, res) => {
  try {
    const { sessionKey } = req.body
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    await pool.query('DELETE FROM raw_nexus.octis_hidden_sessions WHERE session_key = $1', [sessionKey])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// VAPID public key (for frontend to subscribe)
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC })
})

// Register push subscription
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription, userAgent } = req.body
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' })
    await pool.query(
      `INSERT INTO raw_nexus.octis_push_subscriptions (user_id, endpoint, subscription, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET subscription = $3, user_agent = $4`,
      [req.clerkUserId, subscription.endpoint, JSON.stringify(subscription), userAgent || '']
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Unregister push subscription
app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body
    await pool.query(
      'DELETE FROM raw_nexus.octis_push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.clerkUserId, endpoint]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Send push to all subscriptions for a user (internal use by gateway/cron)
app.post('/api/push/send', async (req, res) => {
  try {
    const { userId, title, body, data } = req.body
    const target = userId || 'user_3C2XKvwT0WPSIz0JFdd7GJIMq1V' // default to Casin
    const { rows } = await pool.query(
      'SELECT subscription FROM raw_nexus.octis_push_subscriptions WHERE user_id = $1',
      [target]
    )
    const payload = JSON.stringify({ title: title || 'Octis', body: body || '', data: data || {} })
    const results = await Promise.allSettled(
      rows.map(r => webpush.sendNotification(r.subscription, payload))
    )
    const sent = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length
    res.json({ sent, failed })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Session project tags (server-persisted, cross-device)
app.get('/api/session-projects', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT session_key, project_tag FROM raw_nexus.octis_session_projects ORDER BY updated_at DESC'
    )
    const map = {}
    for (const r of rows) map[r.session_key] = r.project_tag
    res.json(map)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/session-projects', requireAuth, async (req, res) => {
  try {
    const { sessionKey, projectTag } = req.body
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
    if (!projectTag) {
      await pool.query('DELETE FROM raw_nexus.octis_session_projects WHERE session_key = $1', [sessionKey])
    } else {
      await pool.query(
        `INSERT INTO raw_nexus.octis_session_projects (session_key, project_tag, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (session_key) DO UPDATE SET project_tag = $2, updated_at = NOW()`,
        [sessionKey, projectTag]
      )
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Session history — past sessions from Postgres (incl. archived/deleted)
app.get('/api/sessions/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30
    const labels = await readLabels()
    const { rows } = await pool.query(`
      SELECT
        session_id AS session_key,
        first_message AS session_label,
        sender_name,
        SUM(total_cost_usd) AS cost,
        MIN(session_date) AS first_date,
        MAX(last_ts) AS last_activity,
        SUM(turn_count) AS turn_count
      FROM raw_nexus.claw_session_costs
      WHERE session_date >= CURRENT_DATE - INTERVAL '${days} days'
      GROUP BY session_id, first_message, sender_name
      ORDER BY MAX(last_ts) DESC
      LIMIT 200
    `)
    res.json(rows.map(r => ({
      session_key: r.session_key,
      label: labels[r.session_key] || r.session_label || r.session_key,
      sender_name: r.sender_name,
      cost: parseFloat(r.cost),
      first_date: r.first_date,
      last_activity: r.last_activity,
      turn_count: parseInt(r.turn_count) || 0,
    })))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Todo system ──────────────────────────────────────────────────────────────

const SECTION_TO_PROJECT = {
  'Octis': 'Octis',
  'Quantum Engine': 'Quantum',
  'Beatimo Portal': 'Beatimo',
  'Ops Firm': 'Ops',
  'Prospection Pipeline': 'Centurion',
  'CRM Decision': 'Beatimo',
  'Sage': 'Infra',
  'Building Stack': 'Infra',
  'Monday.com': 'Beatimo',
  'Billing Generator': 'Beatimo',
  'Casin Personal': 'Personal',
  'This Week': 'Personal',
  'Backlog': 'Personal',
}

function parseTodosFile(content) {
  const lines = content.split('\n')
  const items = []
  let currentSection = ''
  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+)/)
    if (sectionMatch) { currentSection = sectionMatch[1].trim(); continue }
    const todoMatch = line.match(/^-\s+\[ \]\s+(.+)/)
    if (!todoMatch) continue
    let text = todoMatch[1].trim()
    // Parse owner token
    const ownerMatch = text.match(/^\[(ME|YOU|BOTH|WAIT(?:→[^\]]+)?|UNLOCK(?:→[^\]]+)?)\]\s*/)
    let owner = null
    if (ownerMatch) { owner = ownerMatch[1].replace(/→.*/, ''); text = text.slice(ownerMatch[0].length).trim() }
    // Map section → project
    let project = 'Personal'
    for (const [key, val] of Object.entries(SECTION_TO_PROJECT)) {
      if (currentSection.startsWith(key)) { project = val; break }
    }
    items.push({ project, text, owner, source_section: currentSection })
  }
  return items
}

async function ensureTodosTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS octis_todos (
      id SERIAL PRIMARY KEY,
      project TEXT NOT NULL,
      text TEXT NOT NULL,
      owner TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      source_section TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      session_key TEXT,
      UNIQUE(project, text)
    )
  `)
}

async function syncTodosFromFile() {
  await ensureTodosTable()
  const content = await fs.readFile(TODOS_FILE, 'utf8').catch(() => '')
  const items = parseTodosFile(content)
  let upserted = 0
  for (const item of items) {
    const res = await pool.query(
      `INSERT INTO octis_todos (project, text, owner, source_section)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT octis_todos_project_text_uniq DO UPDATE SET
         owner = EXCLUDED.owner,
         source_section = EXCLUDED.source_section
       WHERE octis_todos.status != 'done'
       RETURNING id`,
      [item.project, item.text, item.owner, item.source_section]
    )
    if (res.rowCount > 0) upserted++
  }
  return upserted
}

// Auto-sync on startup (non-blocking)
setImmediate(() => syncTodosFromFile().catch(e => console.error('[todos] sync error:', e)))

// GET /api/todos — open todos grouped by project (auth required)
app.get('/api/todos', requireAuth, async (req, res) => {
  try {
    await ensureTodosTable()
    const result = await pool.query(`SELECT * FROM octis_todos WHERE status='open' ORDER BY project, id`)
    const grouped = {}
    for (const row of result.rows) {
      if (!grouped[row.project]) grouped[row.project] = { count: 0, items: [] }
      grouped[row.project].count++
      grouped[row.project].items.push(row)
    }
    res.json(grouped)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/todos/count — open counts by project (no auth — used for badges)
app.get('/api/todos/count', async (req, res) => {
  try {
    await ensureTodosTable()
    const result = await pool.query(`SELECT project, COUNT(*) as count FROM octis_todos WHERE status='open' GROUP BY project`)
    const counts = {}
    for (const row of result.rows) counts[row.project] = parseInt(row.count)
    res.json(counts)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/todos/sync — re-parse TODOS.md and upsert (auth required)
app.post('/api/todos/sync', requireAuth, async (req, res) => {
  try {
    const count = await syncTodosFromFile()
    res.json({ ok: true, upserted: count })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/todos/:id/complete — mark done + remove from TODOS.md
app.patch('/api/todos/:id/complete', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const row = await pool.query(`UPDATE octis_todos SET status='done', completed_at=NOW() WHERE id=$1 AND status='open' RETURNING text`, [id])
    if (row.rowCount === 0) return res.status(404).json({ error: 'Not found or already done' })
    const text = row.rows[0].text
    // Remove matching line from TODOS.md
    const content = await fs.readFile(TODOS_FILE, 'utf8').catch(() => '')
    const lines = content.split('\n')
    const filtered = lines.filter(line => {
      if (!line.match(/^-\s+\[ \]/)) return true
      // Strip prefix tokens and compare
      const stripped = line.replace(/^-\s+\[ \]\s+/, '').replace(/^\[[A-Z→a-z]+\]\s*/, '').trim()
      return stripped !== text
    })
    await fs.writeFile(TODOS_FILE, filtered.join('\n'), 'utf8')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Serve media files from OpenClaw inbound media store
app.get('/api/media/:filename', requireAuth, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename) // sanitize: strip any path traversal
    const filePath = path.join(HOME, '.openclaw/media/inbound', filename)
    const data = await fs.readFile(filePath)
    const ext = path.extname(filename).toLowerCase()
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' }
    res.set('Content-Type', mimeMap[ext] || 'application/octet-stream')
    res.set('Cache-Control', 'private, max-age=86400')
    res.send(data)
  } catch {
    res.status(404).json({ error: 'Media file not found' })
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
