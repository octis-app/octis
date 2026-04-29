import express from 'express'
import cors from 'cors'
import fs from 'fs/promises'
import { readFileSync, mkdirSync } from 'fs'
import path from 'path'
import { createRequire } from 'module'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import webpush from 'web-push'
import { WebSocket, WebSocketServer } from 'ws'

const _require = createRequire(import.meta.url)
const pdfParse = _require('pdf-parse')

// ─── Config ──────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || '/root'
const GATEWAY_URL = process.env.GATEWAY_URL
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN
const PORT = parseInt(process.env.OCTIS_API_PORT || process.env.PORT || '3747')
const WORKSPACE = process.env.OCTIS_WORKSPACE || path.join(HOME, '.openclaw/workspace')
const ADMIN_EMAIL = process.env.ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const COSTS_DB_URL = process.env.COSTS_DB_URL  // optional; enables /api/costs and /api/sessions/history
const GITHUB_PAT = process.env.GITHUB_PAT || ''
const GITHUB_REPO = 'octis-app/octis'

const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md')
const TODOS_FILE = path.join(WORKSPACE, 'TODOS.md')
const MEMORY_DIR = path.join(WORKSPACE, 'memory')

if (!GATEWAY_TOKEN) {
  console.error('[octis] GATEWAY_TOKEN env var is required')
  process.exit(1)
}

// JWT secret derived from gateway token — no extra env var
const JWT_SECRET = crypto.createHash('sha256').update(GATEWAY_TOKEN + ':octis-session').digest('hex')

// Auto-auth: if no ADMIN_PASSWORD set, skip login entirely (single-user mode)
const AUTO_AUTH = !ADMIN_PASSWORD
if (AUTO_AUTH) console.warn('[octis] Auto-auth mode: no ADMIN_PASSWORD set. Anyone with network access controls your agent.')
else console.log('[octis] Password auth enabled')

// ─── VAPID ───────────────────────────────────────────────────────────────────

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || ''
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || ''
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:admin@example.com'
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE)
  console.log('[octis] Push notifications enabled')
} else {
  console.warn('[octis] VAPID keys not set — push notifications disabled')
}

// ─── SQLite ───────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(HOME, '.octis')
mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'octis.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const __serverDir = path.dirname(new URL(import.meta.url).pathname)
const schema = readFileSync(path.join(__serverDir, '..', 'db', 'schema.sql'), 'utf8')
db.exec(schema)
// Migrations
try { db.exec('ALTER TABLE octis_projects ADD COLUMN hide_from_sessions INTEGER DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE octis_hidden_sessions ADD COLUMN deleted INTEGER DEFAULT 0') } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, key)
)`) } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS octis_drafts (
  session_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (session_key, user_id)
)`) } catch {}

// First-run: create admin account if users table empty
const userCount = db.prepare('SELECT COUNT(*) as n FROM users').get()
if (userCount.n === 0 && ADMIN_EMAIL) {
  const hash = ADMIN_PASSWORD ? bcrypt.hashSync(ADMIN_PASSWORD, 10) : null
  db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)').run(ADMIN_EMAIL, hash, 'admin')
  console.log('[octis] Created admin account:', ADMIN_EMAIL)
}

// ─── Optional Postgres for costs (feature-flagged) ───────────────────────────

let pgPool = null
if (COSTS_DB_URL) {
  try {
    const pg = (await import('pg')).default
    pgPool = new pg.Pool({ connectionString: COSTS_DB_URL, ssl: false })
    console.log('[octis] Costs DB enabled')
  } catch (e) {
    console.warn('[octis] Failed to init costs DB:', e.message)
  }
}

// ─── Express setup ───────────────────────────────────────────────────────────

const app = express()
app.set('trust proxy', 1)  // trust Caddy reverse proxy
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors())
app.use(cookieParser())
app.use(express.json({ limit: '10mb' }))

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (AUTO_AUTH) {
    req.user = db.prepare('SELECT * FROM users LIMIT 1').get()
      || { id: 0, email: ADMIN_EMAIL || 'admin', role: 'owner' }
    // Normalize role
    if (req.user.role === 'admin') req.user.role = 'owner'
    return next()
  }
  const token = req.cookies?.octis_token
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    // Always read fresh role from DB (so role changes don't require re-login)
    const freshUser = req.user.id ? db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id) : null
    if (freshUser) req.user.role = freshUser.role
    // Normalize: treat 'admin' as 'owner'
    if (req.user.role === 'admin') req.user.role = 'owner'
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
  }
}

// ─── Auth routes ─────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many attempts' }, validate: { xForwardedForHeader: false } })

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role, autoAuth: AUTO_AUTH })
})

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  if (AUTO_AUTH) return res.json({ ok: true })
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid credentials' })
  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' })
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' })
  res.cookie('octis_token', token, {
    httpOnly: true, secure: true, sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  })
  res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } })
})

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('octis_token')
  res.json({ ok: true })
})

// ─── Admin WebSocket helper ───────────────────────────────────────────────────

function adminGwCall(calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:18789/gateway', {
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, Origin: 'http://localhost:18789' }
    })
    let reqId = 1
    const pending = new Map()
    const results = []

    function sendReq(method, params) {
      return new Promise((res, rej) => {
        const id = String(reqId++)
        pending.set(id, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ type: 'req', id, method, params }))
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); rej(new Error(`Timeout: ${method}`)) }
        }, 8000)
      })
    }

    ws.on('message', async (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        try {
          await sendReq('connect', {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'openclaw-control-ui', version: '2026.4.10', platform: 'linux', mode: 'ui' },
            caps: [], auth: { token: GATEWAY_TOKEN }, role: 'operator', scopes: ['operator.admin']
          })
          for (const call of calls) results.push(await sendReq(call.method, call.params))
          ws.close()
          resolve(results)
        } catch (err) { ws.close(); reject(err) }
      }
      if (msg.type === 'res') {
        const p = pending.get(msg.id)
        if (p) { pending.delete(msg.id); if (msg.ok) p.resolve(msg.payload); else p.reject(new Error(msg.error?.message || 'RPC failed')) }
      }
    })

    ws.on('error', (err) => { ws.close(); reject(err) })
    setTimeout(() => { ws.close(); reject(new Error('Connection timeout')) }, 15000)
  })
}

// ─── Utilities ───────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sessionIdToFriendlyLabel(sessionId) {
  if (!sessionId) return 'Session'
  const id = sessionId.replace(/^agent:main:/, '')
  if (id.startsWith('slack:direct:')) return 'Slack DM'
  if (id.startsWith('slack:channel:')) {
    const threadMatch = id.match(/thread:(\d+)/)
    if (threadMatch) return 'Slack Thread'
    return 'Slack'
  }
  if (id.startsWith('session-')) {
    const ts = parseInt(id.replace('session-', ''))
    if (!isNaN(ts) && ts > 1e12) {
      const d = new Date(ts)
      return `Session ${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`
    }
    return 'Session'
  }
  if (id.startsWith('webchat-')) return 'Webchat'
  return id.slice(0, 16) + '…'
}

function cleanSessionLabel(raw, sessionId) {
  let label = (raw || '').trim()
  // If first_message is a bare UUID (device ID artifact from sync), ignore it
  if (UUID_RE.test(label)) label = ''
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
    .replace(/Sender \(untrusted metadata\):[\s\S]*/i, '')
    .replace(/Conversation info \(untrusted metadata\):[\s\S]*/i, '')
    .replace(/\n[\s\S]*/s, '')
    .replace(/\[.*?\]/g, '')
    .trim()
    .slice(0, 70)
  return label || sessionIdToFriendlyLabel(sessionId)
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true }))

// ─── Agents list ─────────────────────────────────────────────────────────────

app.get('/api/agents', requireAuth, (req, res) => {
  try {
    const agentsFile = path.join(__serverDir, 'config', 'agents.json')
    const agents = JSON.parse(readFileSync(agentsFile, 'utf8'))
    res.json({ agents })
  } catch {
    res.json({ agents: [{ id: 'main', name: 'Byte', emoji: '🦞', description: 'Default' }] })
  }
})

// ─── Cache clear page ─────────────────────────────────────────────────────────

app.get('/api/clear', (req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(`<!DOCTYPE html><html><head><title>Octis — Clearing cache…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0f1117;color:#e8eaf0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}
p{color:#6b7280;font-size:14px}</style></head><body>
<div style="font-size:2rem">&#x1F9F9;</div>
<div>Clearing Octis cache…</div>
<p id="s">Working…</p>
<script>
async function clear() {
  document.getElementById('s').textContent = 'Clearing caches…'
  if ('caches' in window) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))) }
  document.getElementById('s').textContent = 'Unregistering service workers…'
  if ('serviceWorker' in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())) }
  document.getElementById('s').textContent = 'Clearing local state…'
  Object.keys(localStorage).filter(k => k.startsWith('octis-pending-') || k.startsWith('octis-msg-cache-')).forEach(k => localStorage.removeItem(k))
  document.getElementById('s').textContent = 'Done! Redirecting…'
  setTimeout(() => location.replace('/'), 1000)
}
clear().catch(e => { document.getElementById('s').textContent = 'Error: ' + e })
<\/script></body></html>`)
})

// ─── Gateway config ───────────────────────────────────────────────────────────

app.get('/api/gateway-config', requireAuth, (req, res) => {
  res.json({ url: GATEWAY_URL, token: GATEWAY_TOKEN, agentId: 'main', role: req.user.role })
})

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ userId: String(req.user.id), role: req.user.role, agentId: 'main', email: req.user.email })
})

// ─── Session autoname ─────────────────────────────────────────────────────────

app.post('/api/session-autoname', async (req, res) => {
  try {
    const { messages } = req.body
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'No messages provided' })

    // Use Anthropic (claude-haiku) for autoname
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })

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

    if (!excerpt.trim() || excerpt.replace(/User:|Assistant:/g, '').trim().length < 10)
      return res.status(400).json({ error: 'Not enough conversation content' })

    const prompt = `Generate a 3-5 word session title for this conversation. Reply with ONLY the title — no quotes, no punctuation, no explanation.\nExamples: Octis Sidebar Layout Fixes | Sage GL Batch Push | Centurion Deal Analysis\n\n${excerpt}\n\nTitle:`

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 30, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(8000),
    })
    const data = await r.json()
    // Anthropic format: content[0].text
    const raw = (data?.content?.[0]?.text || '').trim()
    const label = raw.split('\n')[0].replace(/^['"`*\-•]+|['"`*\-•]+$/g, '').trim().slice(0, 60)
    if (!label) return res.status(500).json({ error: 'Empty label from model' })
    res.json({ label })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Session rename ───────────────────────────────────────────────────────────

app.post('/api/session-rename', requireAuth, (req, res) => {
  const { sessionKey, label } = req.body
  if (!sessionKey || !label) return res.status(400).json({ error: 'Missing sessionKey or label' })
  db.prepare('INSERT OR REPLACE INTO octis_session_labels (session_key, label) VALUES (?, ?)').run(sessionKey, label)
  res.json({ ok: true })
})

// ─── Session labels ───────────────────────────────────────────────────────────

app.get('/api/session-labels', (req, res) => {
  const rows = db.prepare('SELECT session_key, label FROM octis_session_labels').all()
  const labels = {}
  for (const r of rows) labels[r.session_key] = r.label
  res.json(labels)
})

// ─── Memory ───────────────────────────────────────────────────────────────────

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

// ─── Projects ─────────────────────────────────────────────────────────────────

app.get('/api/project-memory/:slug', async (req, res) => {
  try {
    const project = db.prepare('SELECT memory_file, description FROM octis_projects WHERE slug = ?').get(req.params.slug)
    const candidates = [
      project?.memory_file ? path.join(WORKSPACE, project.memory_file) : null,
      path.join(MEMORY_DIR, `${req.params.slug}.md`),
    ].filter(Boolean)
    let content = ''
    for (const p of candidates) {
      try { content = await fs.readFile(p, 'utf8'); break } catch {}
    }
    res.json({ content: content.slice(0, 800), description: project?.description || '' })
  } catch {
    res.json({ content: '' })
  }
})

app.get('/api/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM octis_projects ORDER BY position, name').all()
  res.json({ projects })
})

app.post('/api/projects', requireAuth, (req, res) => {
  const { name, emoji = '📁', color = '#6366f1', description = '', memory_file = '' } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'name required' })
  const slug = name.trim()
  db.prepare(
    `INSERT INTO octis_projects (name, slug, emoji, color, description, memory_file)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET name=excluded.name, emoji=excluded.emoji, color=excluded.color,
     description=excluded.description, memory_file=excluded.memory_file, updated_at=unixepoch()`
  ).run(slug, slug, emoji, color, description, memory_file)
  const project = db.prepare('SELECT * FROM octis_projects WHERE slug = ?').get(slug)
  res.json({ project })
})

app.patch('/api/projects/:id', requireAuth, (req, res) => {
  const { id } = req.params
  const { name, emoji, color, description, memory_file, position, hide_from_sessions } = req.body
  const sets = []
  const vals = []
  if (name !== undefined)               { sets.push('name=?');                vals.push(name) }
  if (emoji !== undefined)              { sets.push('emoji=?');               vals.push(emoji) }
  if (color !== undefined)              { sets.push('color=?');               vals.push(color) }
  if (description !== undefined)        { sets.push('description=?');         vals.push(description) }
  if (memory_file !== undefined)        { sets.push('memory_file=?');         vals.push(memory_file) }
  if (position !== undefined)           { sets.push('position=?');            vals.push(position) }
  if (hide_from_sessions !== undefined) { sets.push('hide_from_sessions=?');  vals.push(hide_from_sessions ? 1 : 0) }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' })
  sets.push('updated_at=unixepoch()')
  vals.push(id)
  db.prepare(`UPDATE octis_projects SET ${sets.join(', ')} WHERE id=?`).run(...vals)
  const project = db.prepare('SELECT * FROM octis_projects WHERE id = ?').get(id)
  res.json({ project })
})

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM octis_projects WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ─── Hidden sessions ──────────────────────────────────────────────────────────

app.get('/api/hidden-sessions', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT session_key FROM octis_hidden_sessions').all().map(r => r.session_key))
})

app.post('/api/hidden-sessions/hide', requireAuth, (req, res) => {
  const { sessionKey } = req.body
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
  db.prepare('INSERT OR IGNORE INTO octis_hidden_sessions (session_key) VALUES (?)').run(sessionKey)
  res.json({ ok: true })
})

app.post('/api/hidden-sessions/unhide', requireAuth, (req, res) => {
  const { sessionKey } = req.body
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
  db.prepare('DELETE FROM octis_hidden_sessions WHERE session_key = ?').run(sessionKey)
  res.json({ ok: true })
})

app.get('/api/hidden-session-details', requireAuth, (req, res) => {
  // Only return archived sessions (deleted=0), not permanently deleted ones
  const hiddenRows = db.prepare('SELECT session_key, hidden_at FROM octis_hidden_sessions WHERE (deleted IS NULL OR deleted = 0) ORDER BY hidden_at DESC').all()
  const getLabel = db.prepare('SELECT label, updated_at FROM octis_session_labels WHERE session_key = ?')
  const getFuzzy = db.prepare("SELECT label, updated_at FROM octis_session_labels WHERE session_key LIKE '%' || ? ORDER BY updated_at DESC LIMIT 1")
  const details = hiddenRows.map(({ session_key: key, hidden_at }) => {
    // 1. Exact match
    let labelRow = getLabel.get(key)
    // 2. For bare UUIDs, try agent:main:dashboard:{uuid}
    if (!labelRow?.label && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
      labelRow = getLabel.get('agent:main:dashboard:' + key) || labelRow
    }
    // 3. For full agent:main:session-xxx keys, try bare session-xxx form
    if (!labelRow?.label) {
      const shortKey = key.match(/(session-\d+)$/)?.[1]
      if (shortKey) labelRow = getLabel.get(shortKey) || labelRow
    }
    // 4. Fuzzy suffix match as last resort
    if (!labelRow?.label) {
      labelRow = getFuzzy.get(key) || labelRow
    }
    return {
      key,
      id: key,
      sessionId: key,
      label: labelRow?.label || null,
      lastActivity: labelRow?.updated_at ? new Date(labelRow.updated_at * 1000).toISOString() : null,
      hiddenAt: hidden_at ? new Date(hidden_at * 1000).toISOString() : null,
      status: 'quiet'
    }
  })
  res.json(details)
})

// ─── Pinned sessions ──────────────────────────────────────────────────────────

app.get('/api/pinned-sessions', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT session_key FROM octis_pinned_sessions ORDER BY pinned_at ASC').all().map(r => r.session_key))
})

app.post('/api/pinned-sessions/pin', requireAuth, (req, res) => {
  const { sessionKey } = req.body
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
  db.prepare('INSERT OR IGNORE INTO octis_pinned_sessions (session_key) VALUES (?)').run(sessionKey)
  res.json({ ok: true })
})

app.post('/api/pinned-sessions/unpin', requireAuth, (req, res) => {
  const { sessionKey } = req.body
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
  db.prepare('DELETE FROM octis_pinned_sessions WHERE session_key = ?').run(sessionKey)
  res.json({ ok: true })
})

// ─── Session ownership ──────────────────────────────────────────────────────
// Tracks which user created/opened each session.
// Owners (role=owner/admin) always see all sessions.
// Viewers only see sessions they have claimed.

function claimSessionOwnership(sessionKey, userId) {
  if (!sessionKey || !userId) return
  try {
    db.prepare('INSERT OR IGNORE INTO octis_session_ownership (session_key, user_id) VALUES (?, ?)').run(sessionKey, userId)
  } catch {}
}

// Create a session on a specific agent (owner-only)
app.post('/api/sessions/create', requireAuth, async (req, res) => {
  try {
    const { agentId = 'main' } = req.body
    const [result] = await adminGwCall([{ method: 'sessions.create', params: { agentId } }])
    const sessionKey = result?.key
    if (!sessionKey) return res.status(500).json({ error: 'No session key returned' })
    claimSessionOwnership(sessionKey, req.user.id)
    res.json({ ok: true, sessionKey, agentId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Claim a session (called from client when opening or creating a session)
app.post('/api/session-ownership/claim', requireAuth, (req, res) => {
  const { sessionKey } = req.body
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
  claimSessionOwnership(sessionKey, req.user.id)
  res.json({ ok: true })
})

// Return session keys this user owns (used by client to filter session list)
app.get('/api/my-sessions', requireAuth, (req, res) => {
  const role = req.user.role
  if (role === 'owner' || role === 'admin') {
    const mainAgentId = req.user.agent_id || 'main'
    // Owners see all sessions via the agent-namespace filter — no DB rows needed
    return res.json({ all: true, mainAgentId, sessionKeys: [] })
  }
  const rows = db.prepare('SELECT session_key FROM octis_session_ownership WHERE user_id = ?').all(req.user.id)
  res.json({ all: false, sessionKeys: rows.map(r => r.session_key) })
})

// ─── Push notifications ───────────────────────────────────────────────────────

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC })
})

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const { subscription, userAgent } = req.body
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' })
  const { endpoint, keys } = subscription
  const p256dh = keys?.p256dh || ''
  const auth_key = keys?.auth || ''
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_key, user_agent, subscription_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth_key=excluded.auth_key,
     user_agent=excluded.user_agent, subscription_json=excluded.subscription_json`
  ).run(req.user.id, endpoint, p256dh, auth_key, userAgent || '', JSON.stringify(subscription))
  res.json({ ok: true })
})

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, endpoint)
  res.json({ ok: true })
})

app.post('/api/push/send', async (req, res) => {
  try {
    const { title, body, data } = req.body
    const subs = db.prepare('SELECT subscription_json FROM push_subscriptions').all()
    const payload = JSON.stringify({ title: title || 'Octis', body: body || '', data: data || {} })
    const results = await Promise.allSettled(
      subs.map(r => webpush.sendNotification(JSON.parse(r.subscription_json), payload))
    )
    res.json({ sent: results.filter(r => r.status === 'fulfilled').length, failed: results.filter(r => r.status === 'rejected').length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Session project tags ─────────────────────────────────────────────────────

app.get('/api/session-projects', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT session_key, project FROM octis_session_projects ORDER BY updated_at DESC').all()
  const map = {}
  for (const r of rows) map[r.session_key] = r.project
  res.json(map)
})

app.post('/api/session-projects', requireAuth, (req, res) => {
  const { sessionKey, projectTag } = req.body
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
  if (!projectTag) {
    db.prepare('DELETE FROM octis_session_projects WHERE session_key = ?').run(sessionKey)
  } else {
    db.prepare(
      `INSERT OR REPLACE INTO octis_session_projects (session_key, project) VALUES (?, ?)`
    ).run(sessionKey, projectTag)
  }
  res.json({ ok: true })
})

// ─── Session init (project context injection) ─────────────────────────────────

app.post('/api/session-init', requireAuth, async (req, res) => {
  try {
    const { sessionKey, projectSlug } = req.body
    if (!sessionKey || !projectSlug) return res.json({ error: 'sessionKey and projectSlug required' })
    const project = db.prepare('SELECT * FROM octis_projects WHERE slug = ?').get(projectSlug)
    if (!project) return res.json({ error: 'Project not found' })
    const { name, emoji, description, memory_file } = project
    const descLine = description ? `\n${description}` : ''
    const memLine = memory_file ? `\nContext file: memory/${memory_file}` : ''
    const contextNote = `[Octis Project Context]\nThis session is filed under the **${name}** project in Octis.${descLine}${memLine}\n\nWhen the user asks which project this session is under, answer: **${name}**.`
    // Try to set label; if taken, append a numeric suffix until it succeeds
    let labelSet = false
    let baseLabel = `${emoji} ${name}`.trim()
    for (let attempt = 0; attempt <= 9; attempt++) {
      const label = attempt === 0 ? baseLabel : `${baseLabel} ${attempt + 1}`
      try {
        await adminGwCall([{ method: 'sessions.patch', params: { key: sessionKey, label } }])
        labelSet = true
        break
      } catch (labelErr) {
        if (!labelErr.message?.includes('label already in use')) throw labelErr
        // label taken — try next suffix
      }
    }
    if (!labelSet) {
      // Fallback: set a timestamp-based label so the session is still usable
      const ts = new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })
      await adminGwCall([{ method: 'sessions.patch', params: { key: sessionKey, label: `${baseLabel} ${ts}` } }])
    }
    await adminGwCall([{ method: 'chat.inject', params: { sessionKey, message: contextNote, label: '📁 Project' } }])
    claimSessionOwnership(sessionKey, req.user.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('[octis] session-init error:', err.message)
    res.json({ error: err.message })
  }
})

// ─── HTTP fallback for sessions.list ────────────────────────────────────
app.get('/api/sessions-list', requireAuth, async (req, res) => {
  try {
    const { limit = 50 } = req.query
    const agentId = req.user.agent_id || 'main'
    const params = { limit: Math.min(Number(limit), 100), agentId }
    const [result] = await adminGwCall([{ method: 'sessions.list', params }])
    res.json({ ok: true, sessions: result?.sessions || [] })
  } catch (err) {
    console.error('[octis] sessions-list HTTP error:', err.message)
    res.status(502).json({ ok: false, error: err.message })
  }
})

// ─── Enrich image blocks stripped by gateway chat.history ───────────────────
// The gateway strips base64 data from image blocks for bandwidth efficiency.
// This helper reads the local JSONL to restore image data for user messages.
async function enrichImageBlocks(sessionKey, messages) {
  // Find user messages with image blocks that have empty data
  const needsEnrich = messages.some(m =>
    m.role === 'user' && Array.isArray(m.content) &&
    m.content.some(b => b.type === 'image' && !b.data)
  )
  if (!needsEnrich) return messages

  try {
    // Resolve session UUID from sessions.json
    const sessionsPath = `${HOME}/.openclaw/agents/main/sessions/sessions.json`
    let sessionsJson = '{}'
    try { sessionsJson = await fs.readFile(sessionsPath, 'utf8') } catch {}
    const sessions = JSON.parse(sessionsJson)
    const sessionInfo = sessions[sessionKey]
    const sessionUUID = sessionInfo?.sessionId
    if (!sessionUUID) return messages

    // Read the JSONL file and build timestamp→content map for image messages
    const jsonlPath = `${HOME}/.openclaw/agents/main/sessions/${sessionUUID}.jsonl`
    let jsonlContent = ''
    try { jsonlContent = await fs.readFile(jsonlPath, 'utf8') } catch { return messages }

    // Build match key from text content — more reliable than timestamp format mismatch
    // JSONL stores the full OpenClaw envelope (Sender metadata + timestamp prefix),
    // but chat.history returns only the stripped message text. Strip the envelope first.
    const stripEnvelope = (text) => {
      if (!text.includes('Sender (untrusted metadata):')) return text
      const m = text.match(/\[\w+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\]\s*([\s\S]*)$/)
      return m ? m[1].trim() : text
    }
    const textKey = (content, stripEnv = false) => {
      if (!Array.isArray(content)) {
        const t = String(content || '')
        return (stripEnv ? stripEnvelope(t) : t).substring(0, 120)
      }
      return content.filter(b => b.type === 'text')
        .map(b => { const t = String(b.text || ''); return (stripEnv ? stripEnvelope(t) : t).substring(0, 120) })
        .join('|')
    }

    const imageMap = new Map() // textKey → full content array with image data
    for (const line of jsonlContent.split('\n')) {
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line)
        if (evt.message?.role === 'user' && Array.isArray(evt.message.content)) {
          const hasImgData = evt.message.content.some(b => b.type === 'image' && b.data)
          if (hasImgData) {
            const key = textKey(evt.message.content, true) // strip envelope for matching
            if (key) imageMap.set(key, evt.message.content)
          }
        }
      } catch {}
    }
    if (imageMap.size === 0) return messages

    return messages.map(m => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return m
      const hasEmptyImage = m.content.some(b => b.type === 'image' && !b.data)
      if (!hasEmptyImage) return m
      const key = textKey(m.content)
      const richContent = key && imageMap.get(key)
      return richContent ? { ...m, content: richContent } : m
    })
  } catch (e) {
    console.error('[octis] enrichImageBlocks error:', e.message)
    return messages
  }
}

// ─── HTTP fallback for chat.history ─────────────────────────────────────
app.get('/api/chat-history', requireAuth, async (req, res) => {
  try {
    const { sessionKey, limit = 50 } = req.query
    if (!sessionKey) return res.status(400).json({ ok: false, error: 'sessionKey required' })
    const [result] = await adminGwCall([{
      method: 'chat.history',
      params: { sessionKey, limit: Math.min(Number(limit), 300) }
    }])
    const raw = result?.messages || []
    const messages = await enrichImageBlocks(sessionKey, raw)
    res.json({ ok: true, messages })
  } catch (err) {
    console.error('[octis] chat-history HTTP error:', err.message)
    res.status(502).json({ ok: false, error: err.message })
  }
})

// ─── HTTP fallback for chat.send ────────────────────────────────────────────
// Used when the client WS is dead (iOS zombie TCP). Server proxies the send
// via its own persistent-ish admin WS connection to the gateway.
app.post('/api/chat-send', requireAuth, async (req, res) => {
  try {
    const { sessionKey, message, idempotencyKey, deliver } = req.body
    if (!sessionKey || !message) return res.status(400).json({ ok: false, error: 'sessionKey and message required' })
    const [result] = await adminGwCall([{
      method: 'chat.send',
      params: { sessionKey, message, idempotencyKey, deliver: deliver !== false }
    }])
    res.json({ ok: true, runId: result?.runId })
  } catch (err) {
    console.error('[octis] chat-send HTTP error:', err.message)
    res.status(502).json({ ok: false, error: err.message })
  }
})

// ─── Costs (optional — requires COSTS_DB_URL) ────────────────────────────────

app.get('/api/costs', requireAuth, async (req, res) => {
  if (!pgPool) return res.json({ disabled: true, message: 'Set COSTS_DB_URL to enable cost tracking.' })
  try {
    const days = Math.min(parseInt(req.query.days || '30'), 90)
    const { rows: daily } = await pgPool.query(`
      SELECT cost_date AS date, SUM(total_cost_usd) AS total_cost_usd,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(session_count) AS session_count
      FROM raw_nexus.claw_user_daily_costs
      WHERE cost_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      GROUP BY cost_date ORDER BY cost_date ASC
    `, [days])
    const { rows: sessions } = await pgPool.query(`
      SELECT cs.session_id AS session_key, COALESCE(ol.label, cs.first_message) AS session_label,
        cs.sender_name, SUM(cs.total_cost_usd) AS cost, MAX(cs.last_ts) AS last_activity,
        SUM(cs.input_tokens) AS input_tokens, SUM(cs.output_tokens) AS output_tokens
      FROM raw_nexus.claw_session_costs cs
      LEFT JOIN raw_nexus.octis_session_labels ol ON ol.session_key = cs.session_id
      WHERE cs.session_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      GROUP BY cs.session_id, cs.first_message, cs.sender_name, ol.label
      ORDER BY cost DESC LIMIT 50
    `, [days])
    // Use rolling 24h window for "today" so it matches Montreal timezone and doesn't reset at midnight UTC
    const { rows: todayRow } = await pgPool.query(`SELECT COALESCE(SUM(total_cost_usd),0) AS today_cost FROM raw_nexus.claw_user_daily_costs WHERE cost_date >= (NOW() - INTERVAL '24 hours')::date`)
    const { rows: todaySessionRows } = await pgPool.query(`
      SELECT cs.session_id AS session_key, COALESCE(ol.label, cs.first_message) AS session_label,
        cs.sender_name, SUM(cs.total_cost_usd) AS cost, MAX(cs.last_ts) AS last_activity,
        SUM(cs.input_tokens) AS input_tokens, SUM(cs.output_tokens) AS output_tokens
      FROM raw_nexus.claw_session_costs cs
      LEFT JOIN raw_nexus.octis_session_labels ol ON ol.session_key = cs.session_id
      WHERE cs.last_ts >= NOW() - INTERVAL '24 hours'
      GROUP BY cs.session_id, cs.first_message, cs.sender_name, ol.label
      ORDER BY cost DESC LIMIT 20
    `)
    res.json({
      today: parseFloat(todayRow[0]?.today_cost || 0),
      daily: daily.map(r => ({ ...r, total_cost_usd: parseFloat(r.total_cost_usd), date: String(r.date).slice(0, 10) })),
      sessions: sessions.map(r => ({ ...r, cost: parseFloat(r.cost), session_label: cleanSessionLabel(r.session_label, r.session_key) })),
      todaySessions: todaySessionRows.map(r => ({ ...r, cost: parseFloat(r.cost), session_label: cleanSessionLabel(r.session_label, r.session_key) })),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Session history (optional — requires COSTS_DB_URL) ──────────────────────

app.get('/api/sessions/history', async (req, res) => {
  if (!pgPool) return res.json([])
  try {
    const days = parseInt(req.query.days) || 30
    const { rows } = await pgPool.query(`
      SELECT session_id AS session_key, first_message AS session_label, sender_name,
        SUM(total_cost_usd) AS cost, MIN(session_date) AS first_date,
        MAX(last_ts) AS last_activity, SUM(turn_count) AS turn_count
      FROM raw_nexus.claw_session_costs
      WHERE session_date >= CURRENT_DATE - INTERVAL '${days} days'
      GROUP BY session_id, first_message, sender_name
      ORDER BY MAX(last_ts) DESC LIMIT 200
    `)
    const savedLabels = db.prepare('SELECT session_key, label FROM octis_session_labels').all()
    const labelMap = {}
    for (const r of savedLabels) {
      labelMap[r.session_key] = r.label
      // Also index without 'agent:main:' prefix so Postgres session_ids match
      const stripped = r.session_key.replace(/^agent:main:/, '')
      if (stripped !== r.session_key) labelMap[stripped] = r.label
    }
    res.json(rows.map(r => ({
      session_key: r.session_key,
      label: labelMap[r.session_key] || labelMap['agent:main:' + r.session_key] || cleanSessionLabel(r.session_label, r.session_key),
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

// ─── Todos ────────────────────────────────────────────────────────────────────

const SECTION_TO_PROJECT = {
  'Octis': 'Octis', 'Quantum Engine': 'Quantum', 'Beatimo Portal': 'Beatimo',
  'Ops Firm': 'Ops', 'Prospection Pipeline': 'Centurion', 'CRM Decision': 'Beatimo',
  'Sage': 'Infra', 'Building Stack': 'Infra', 'Monday.com': 'Beatimo',
  'Billing Generator': 'Beatimo', 'Casin Personal': 'Personal', 'This Week': 'Personal', 'Backlog': 'Personal',
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
    const ownerMatch = text.match(/^\[(ME|YOU|BOTH|WAIT(?:→[^\]]+)?|UNLOCK(?:→[^\]]+)?)\]\s*/)
    let owner = null
    if (ownerMatch) { owner = ownerMatch[1].replace(/→.*/, ''); text = text.slice(ownerMatch[0].length).trim() }
    let project = 'Personal'
    for (const [key, val] of Object.entries(SECTION_TO_PROJECT)) {
      if (currentSection.startsWith(key)) { project = val; break }
    }
    items.push({ project, text, owner, source_section: currentSection })
  }
  return items
}

function syncTodosFromFile() {
  try {
    const content = readFileSync(TODOS_FILE, 'utf8')
    const items = parseTodosFile(content)
    const upsert = db.prepare(
      `INSERT INTO octis_todos (project, text, owner, source_section) VALUES (?, ?, ?, ?)
       ON CONFLICT(project, text) DO UPDATE SET owner=excluded.owner, source_section=excluded.source_section
       WHERE octis_todos.status != 'done'`
    )
    const run = db.transaction((items) => { for (const i of items) upsert.run(i.project, i.text, i.owner, i.source_section) })
    run(items)
  } catch (e) {
    console.error('[todos] sync error:', e.message)
  }
}

// Auto-sync on startup
setImmediate(syncTodosFromFile)

app.get('/api/todos', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM octis_todos WHERE status='open' ORDER BY project, id`).all()
  const grouped = {}
  for (const row of rows) {
    if (!grouped[row.project]) grouped[row.project] = { count: 0, items: [] }
    grouped[row.project].count++
    grouped[row.project].items.push(row)
  }
  res.json(grouped)
})

app.get('/api/todos/count', (req, res) => {
  const rows = db.prepare(`SELECT project, COUNT(*) as count FROM octis_todos WHERE status='open' GROUP BY project`).all()
  const counts = {}
  for (const r of rows) counts[r.project] = Number(r.count)
  res.json(counts)
})

app.post('/api/todos/sync', requireAuth, (req, res) => {
  syncTodosFromFile()
  res.json({ ok: true })
})

app.patch('/api/todos/:id/complete', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const row = db.prepare(`UPDATE octis_todos SET status='done', completed_at=unixepoch() WHERE id=? AND status='open' RETURNING text`).get(id)
    if (!row) return res.status(404).json({ error: 'Not found or already done' })
    const text = row.text
    const content = await fs.readFile(TODOS_FILE, 'utf8').catch(() => '')
    const filtered = content.split('\n').filter(line => {
      if (!line.match(/^-\s+\[ \]/)) return true
      const stripped = line.replace(/^-\s+\[ \]\s+/, '').replace(/^\[[A-Z→a-z]+\]\s*/, '').trim()
      return stripped !== text
    })
    await fs.writeFile(TODOS_FILE, filtered.join('\n'), 'utf8')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── User settings (persistent key/value per user) ─────────────────────────
app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(req.user.id)
  const settings = {}
  for (const r of rows) {
    try { settings[r.key] = JSON.parse(r.value) } catch { settings[r.key] = r.value }
  }
  res.json({ ok: true, settings })
})

app.patch('/api/settings', requireAuth, (req, res) => {
  const updates = req.body // { key: value, ... }
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Invalid body' })
  const upsert = db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`)
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(req.user.id, k, JSON.stringify(v))
  })
  tx(Object.entries(updates))
  res.json({ ok: true })
})

// ─── Drafts (per-session, per-user, cross-device) ────────────────────────────
app.get('/api/drafts', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT session_key, text, updated_at FROM octis_drafts WHERE user_id = ?').all(req.user.id)
  const drafts = {}
  for (const r of rows) {
    if (r.text) drafts[r.session_key] = { text: r.text, updatedAt: r.updated_at }
  }
  res.json({ ok: true, drafts })
})

app.get('/api/drafts/:sessionKey', requireAuth, (req, res) => {
  const { sessionKey } = req.params
  const row = db.prepare('SELECT text FROM octis_drafts WHERE session_key = ? AND user_id = ?').get(sessionKey, req.user.id)
  res.json({ ok: true, text: row?.text || null })
})

app.put('/api/drafts/:sessionKey', requireAuth, (req, res) => {
  const { sessionKey } = req.params
  const { text } = req.body
  if (typeof text !== 'string') return res.status(400).json({ error: 'text required' })
  if (!text.trim()) {
    db.prepare('DELETE FROM octis_drafts WHERE session_key = ? AND user_id = ?').run(sessionKey, req.user.id)
    return res.json({ ok: true })
  }
  db.prepare(`INSERT INTO octis_drafts (session_key, user_id, text, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(session_key, user_id) DO UPDATE SET text=excluded.text, updated_at=unixepoch()`
  ).run(sessionKey, req.user.id, text)
  res.json({ ok: true })
})

// Permanently delete session from DB + gateway
// ─── Model info endpoints ────────────────────────────────────────────────────

const OPENCLAW_CONFIG_PATH = path.join(HOME, '.openclaw/openclaw.json')
const AUTH_STATE_PATH = path.join(HOME, '.openclaw/agents/main/agent/auth-state.json')
const SESSIONS_JSON_PATH = path.join(HOME, '.openclaw/agents/main/sessions/sessions.json')

function modelDisplayName(modelId) {
  if (!modelId) return 'Unknown'
  const map = {
    'anthropic/claude-sonnet-4-6': 'Sonnet',
    'anthropic/claude-sonnet-4-5': 'Sonnet',
    'anthropic/claude-opus-4-5': 'Opus',
    'anthropic/claude-opus-4': 'Opus',
    'anthropic/claude-haiku-4-5': 'Haiku',
    'anthropic/claude-haiku-4': 'Haiku',
    'google/gemini-2.0-flash': 'Gemini Flash',
    'google/gemini-2.0-pro': 'Gemini Pro',
    'google/gemini-1.5-pro': 'Gemini 1.5 Pro',
    'google/gemini-1.5-flash': 'Gemini Flash',
    'openai/gpt-4o': 'GPT-4o',
    'openai/gpt-4o-mini': 'GPT-4o mini',
  }
  if (map[modelId]) return map[modelId]
  // Fallback: extract the last segment
  const parts = modelId.split('/')
  return parts[parts.length - 1] || modelId
}

function modelProvider(modelId) {
  if (!modelId) return 'unknown'
  if (modelId.startsWith('anthropic/')) return 'anthropic'
  if (modelId.startsWith('google/')) return 'google'
  if (modelId.startsWith('openai/')) return 'openai'
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash) : 'unknown'
}

// GET /api/session-model?sessionKey=xxx
app.get('/api/session-model', requireAuth, async (req, res) => {
  try {
    const { sessionKey } = req.query

    // Read openclaw.json for default model
    let defaultModel = 'anthropic/claude-sonnet-4-6'
    try {
      const cfg = JSON.parse(await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf8'))
      defaultModel = cfg?.agents?.defaults?.model?.primary || defaultModel
    } catch {}

    // Try to read per-session model from sessions.json
    let sessionModel = defaultModel
    let isFallback = false
    if (sessionKey) {
      try {
        const sessions = JSON.parse(await fs.readFile(SESSIONS_JSON_PATH, 'utf8'))
        const sess = sessions[sessionKey]
        if (sess) {
          // Prefer modelOverride/providerOverride (set by /model command)
          // Fall back to modelProvider/model (last-used model)
          const provider = sess.providerOverride || sess.modelProvider
          const model = sess.modelOverride || sess.model
          if (provider && model) {
            sessionModel = `${provider}/${model}`
          }
          // Check if it's a fallback (provider differs from default provider)
          const defaultProvider = modelProvider(defaultModel)
          if (provider && provider !== defaultProvider) {
            isFallback = true
          }
        }
      } catch {}
    }

    // Validate fallbacks from config
    let fallbacks = []
    try {
      const cfg = JSON.parse(await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf8'))
      fallbacks = cfg?.agents?.defaults?.model?.fallbacks || []
    } catch {}

    res.json({
      model: sessionModel,
      displayName: modelDisplayName(sessionModel),
      provider: modelProvider(sessionModel),
      isFallback,
      defaultModel,
      fallbacks,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/provider-health
app.get('/api/provider-health', requireAuth, async (req, res) => {
  try {
    const authState = JSON.parse(await fs.readFile(AUTH_STATE_PATH, 'utf8'))
    const usageStats = authState?.usageStats || {}
    const lastGood = authState?.lastGood || {}

    // Build per-provider health summary
    const providerHealth = {}
    for (const [profileKey, stats] of Object.entries(usageStats)) {
      const provider = profileKey.split(':')[0]
      if (!providerHealth[provider]) {
        providerHealth[provider] = { errorCount: 0, lastFailureAt: null, healthy: true }
      }
      providerHealth[provider].errorCount += (stats.errorCount || 0)
      if (stats.lastFailureAt) {
        const current = providerHealth[provider].lastFailureAt
        if (!current || stats.lastFailureAt > current) {
          providerHealth[provider].lastFailureAt = stats.lastFailureAt
        }
      }
    }
    // Mark as unhealthy if errorCount > 0 and lastGood doesn't have this provider
    for (const [provider, health] of Object.entries(providerHealth)) {
      health.healthy = health.errorCount === 0 || !!lastGood[provider]
    }

    res.json({ ok: true, providers: providerHealth, lastGood })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/session-delete', requireAuth, async (req, res) => {
  const { sessionKey } = req.body
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })
  try {
    db.prepare('DELETE FROM octis_session_labels WHERE session_key = ?').run(sessionKey)
    db.prepare('DELETE FROM octis_session_projects WHERE session_key = ?').run(sessionKey)
    // Mark as deleted in hidden_sessions — keeps it in isHidden() filter so WS sessions.list can't revive it
    db.prepare('INSERT INTO octis_hidden_sessions (session_key, deleted) VALUES (?, 1) ON CONFLICT(session_key) DO UPDATE SET deleted=1').run(sessionKey)
    db.prepare('DELETE FROM octis_pinned_sessions WHERE session_key = ?').run(sessionKey)
    db.prepare('DELETE FROM octis_session_ownership WHERE session_key = ?').run(sessionKey)
    db.prepare('DELETE FROM octis_drafts WHERE session_key = ?').run(sessionKey)
  } catch (e) { console.error('session-delete DB error:', e) }
  // Best-effort gateway deletion
  try {
    await adminGwCall([{ method: 'sessions.delete', params: { sessionKey } }])
  } catch (e) { console.error('session-delete gateway error:', e) }
  res.json({ ok: true })
})

app.delete('/api/drafts/:sessionKey', requireAuth, (req, res) => {
  const { sessionKey } = req.params
  db.prepare('DELETE FROM octis_drafts WHERE session_key = ? AND user_id = ?').run(sessionKey, req.user.id)
  res.json({ ok: true })
})

// ─── Media / uploads ──────────────────────────────────────────────────────────

app.get('/api/uploads/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename)
    const data = await fs.readFile(path.join(WORKSPACE, 'uploads', filename))
    const ext = path.extname(filename).toLowerCase()
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' }
    res.set('Content-Type', mime[ext] || 'application/octet-stream')
    res.set('Cache-Control', 'private, max-age=86400')
    res.send(data)
  } catch { res.status(404).json({ error: 'File not found' }) }
})

app.post('/api/upload', requireAuth, async (req, res) => {
  try {
    const { filename, data } = req.body
    if (!filename || !data) return res.status(400).json({ error: 'filename and data required' })
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')
    const uploadsDir = path.join(WORKSPACE, 'uploads')
    await fs.mkdir(uploadsDir, { recursive: true })
    await fs.writeFile(path.join(uploadsDir, safeName), Buffer.from(data, 'base64'))
    res.json({ ok: true, filename: safeName })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/media/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename)
    const data = await fs.readFile(path.join(HOME, '.openclaw/media/inbound', filename))
    const ext = path.extname(filename).toLowerCase()
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' }
    res.set('Content-Type', mime[ext] || 'application/octet-stream')
    res.set('Cache-Control', 'private, max-age=86400')
    res.send(data)
  } catch { res.status(404).json({ error: 'Media file not found' }) }
})

// ─── GitHub issues ────────────────────────────────────────────────────────────

app.post('/api/issues', requireAuth, async (req, res) => {
  const { type, title, body } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' })
  if (!GITHUB_PAT) return res.status(503).json({ error: 'GITHUB_PAT not configured' })
  const labelMap = { bug: 'bug', feature: 'enhancement', ux: 'ux' }
  const label = labelMap[type] || 'bug'
  try {
    const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_PAT}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ title: title.trim(), body: body || '', labels: [label] }),
    })
    const data = await ghRes.json()
    if (!ghRes.ok) return res.status(500).json({ error: data.message || 'GitHub API error' })
    res.json({ number: data.number, url: data.html_url })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ─── PDF extraction ───────────────────────────────────────────────────────────

app.post('/api/extract-pdf', requireAuth, async (req, res) => {
  try {
    const { data } = req.body
    if (!data) return res.status(400).json({ error: 'data required' })
    const result = await pdfParse(Buffer.from(data, 'base64'))
    res.json({ text: result.text?.trim() || '', pages: result.numpages || 1 })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── Static frontend ──────────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__serverDir, '..', 'dist')
  app.use(express.static(distPath))
  app.use((req, res) => res.sendFile(path.join(distPath, 'index.html')))
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[octis] API server on http://localhost:${PORT}`)
  console.log(`[octis] Gateway: ${GATEWAY_URL} | token: ${GATEWAY_TOKEN.slice(0, 8)}...`)
  console.log(`[octis] Data: ${path.join(DATA_DIR, 'octis.db')}`)
})

