import express from 'express'
import cors from 'cors'
import fs from 'fs/promises'
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
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

const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many attempts' } })

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

function cleanSessionLabel(raw, sessionId) {
  let label = (raw || '').trim()
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
  return label || (sessionId ? sessionId.slice(0, 16) + '…' : 'Session')
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok: true }))

// ─── Agents list ─────────────────────────────────────────────────────────────

app.get('/api/agents', requireAuth, (req, res) => {
  try {
    const agentsFile = path.join(__serverDir, 'config', 'agents.json')
    const raw = JSON.parse(readFileSync(agentsFile, 'utf8'))
    const staticAgents = Array.isArray(raw) ? raw : (raw.agents || [])
    const staticMap = Object.fromEntries(staticAgents.map(a => [a.id, a]))
    const renameAgentId = raw.renameAgentId || 'fast'

    // Try to read openclaw.json for live agent list
    let liveAgents = []
    let defaultModel = ''
    try {
      const clawConfig = JSON.parse(readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf8'))
      liveAgents = clawConfig.agents?.list || []
      defaultModel = clawConfig.agents?.defaults?.model?.primary || ''
    } catch {}

    function friendlyModel(m) {
      if (!m) return 'Default'
      if (m.includes('claude-sonnet')) return 'Claude Sonnet'
      if (m.includes('claude-haiku')) return 'Claude Haiku'
      if (m.includes('claude-opus')) return 'Claude Opus'
      if (m.includes('deepseek-v4')) return 'DeepSeek V4'
      if (m.includes('gpt-4o-mini')) return 'GPT-4o mini'
      if (m.includes('gemini-2.5-flash')) return 'Gemini Flash'
      if (m.includes('gemini-2.5-pro')) return 'Gemini Pro'
      if (m.includes('qwen3-coder')) return 'Qwen3 Coder'
      return m.split('/').pop() || m
    }

    const primaryAgentId = req.user.agent_id || 'main'

    let merged
    if (liveAgents.length > 0) {
      merged = liveAgents.map(la => {
        const override = staticMap[la.id] || {}
        return {
          id: la.id,
          name: override.name || la.name || la.id,
          emoji: override.emoji || '🤖',
          description: override.description || '',
          // Agents in agents.json use their saved value; unconfigured agents default to hidden
          visibleInPicker: Object.keys(override).length > 0 ? (override.visibleInPicker ?? true) : false,
          soul: override.soul || '',
          model: friendlyModel(la.model?.primary || la.model || defaultModel),
          isPrimary: la.id === primaryAgentId,
        }
      })
    } else {
      merged = staticAgents.map(a => ({ 
        id: a.id,
        name: a.name || a.id,
        emoji: a.emoji || '🤖', 
        description: a.description || '',
        visibleInPicker: a.visibleInPicker ?? true,
        soul: a.soul || '',
        model: a.description?.match(/—\s*(.+)/)?.[1] || 'Default', 
        isPrimary: a.id === primaryAgentId 
      }))
    }

    res.json({ agents: merged, renameAgentId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/agents/:id/meta', requireAuth, (req, res) => {
  try {
    const { emoji, description, name, model, soul, visibleInPicker } = req.body
    const agentsFile = path.join(__serverDir, 'config', 'agents.json')
    const raw = JSON.parse(readFileSync(agentsFile, 'utf8'))
    const agentsList = Array.isArray(raw) ? raw : (raw.agents || [])
    const renameAgentId = raw.renameAgentId || 'fast'
    
    const idx = agentsList.findIndex(a => a.id === req.params.id)
    if (idx === -1) {
      agentsList.push({ 
        id: req.params.id, 
        name: name || req.params.id, 
        emoji: emoji || '🤖', 
        description: description || '', 
        visibleInPicker: visibleInPicker ?? true, 
        soul: soul || '' 
      })
    } else {
      if (emoji !== undefined) agentsList[idx].emoji = emoji
      if (description !== undefined) agentsList[idx].description = description
      if (name !== undefined) agentsList[idx].name = name
      if (soul !== undefined) agentsList[idx].soul = soul
      if (visibleInPicker !== undefined) agentsList[idx].visibleInPicker = visibleInPicker
      // model change: update openclaw.json agents.list[id].model
      if (model !== undefined) {
        agentsList[idx].model = model  // store in agents.json for display
        try {
          const clawPath = path.join(HOME, '.openclaw', 'openclaw.json')
          const claw = JSON.parse(readFileSync(clawPath, 'utf8'))
          const agentEntry = (claw.agents?.list || []).find(a => a.id === req.params.id)
          if (agentEntry) {
            agentEntry.model = model
            writeFileSync(clawPath, JSON.stringify(claw, null, 2))
          }
        } catch (e) {
          console.warn('[octis] Could not update openclaw.json model:', e.message)
        }
      }
    }
    
    writeFileSync(agentsFile, JSON.stringify({ renameAgentId, agents: agentsList }, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/agents-config', requireAuth, (req, res) => {
  try {
    const { renameAgentId } = req.body
    const agentsFile = path.join(__serverDir, 'config', 'agents.json')
    const raw = JSON.parse(readFileSync(agentsFile, 'utf8'))
    const agentsList = Array.isArray(raw) ? [] : (raw.agents || [])
    const config = { renameAgentId: renameAgentId || raw.renameAgentId || 'fast', agents: agentsList }
    writeFileSync(agentsFile, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
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

    // Use OpenRouter for autoname — Gemini Flash is faster and cheaper for 30-token labels
    const openrouterKey = process.env.OPENROUTER_API_KEY || ''
    if (!openrouterKey) return res.status(500).json({ error: 'No OpenRouter API key found' })

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

    // Get agent config to determine the renaming model
    const agentsFile = path.join(__serverDir, 'config', 'agents.json')
    let renameModel = process.env.OCTIS_RENAME_MODEL || 'openrouter/google/gemini-2.5-flash'
    try {
      const agentsConfig = JSON.parse(readFileSync(agentsFile, 'utf8'))
      const renameId = agentsConfig.renameAgentId || 'fast'
      // Look up model from openclaw.json
      const clawConfig = JSON.parse(readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf8'))
      const renameAgent = (clawConfig.agents?.list || []).find(a => a.id === renameId)
      if (renameAgent?.model) renameModel = typeof renameAgent.model === 'string' ? renameAgent.model : (renameAgent.model?.primary || renameModel)
    } catch {}

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: renameModel, max_tokens: 20, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(8000),
    })
    const data = await r.json()
    // OpenRouter returns OpenAI-format: choices[0].message.content
    const raw = (data?.choices?.[0]?.message?.content || '').trim()
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
  const { name, emoji, color, description, memory_file, position } = req.body
  const sets = []
  const vals = []
  if (name !== undefined)        { sets.push('name=?');         vals.push(name) }
  if (emoji !== undefined)       { sets.push('emoji=?');        vals.push(emoji) }
  if (color !== undefined)       { sets.push('color=?');        vals.push(color) }
  if (description !== undefined) { sets.push('description=?');  vals.push(description) }
  if (memory_file !== undefined) { sets.push('memory_file=?');  vals.push(memory_file) }
  if (position !== undefined)    { sets.push('position=?');     vals.push(position) }
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
  const hiddenKeys = db.prepare('SELECT session_key FROM octis_hidden_sessions').all().map(r => r.session_key)
  const details = hiddenKeys.map(key => {
    const labelRow = db.prepare('SELECT label, updated_at FROM octis_session_labels WHERE session_key = ?').get(key)
    return {
      key,
      id: key,
      sessionId: key,
      label: labelRow?.label || null,
      lastActivity: labelRow?.updated_at ? new Date(labelRow.updated_at * 1000).toISOString() : null,
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
    const contextNote = `📁 **${emoji} ${name}** — You are working in the ${name} project.${
      memory_file ? ` Context file: memory/${memory_file}` : ''
    }${description ? '\n' + description : ''}`
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

// ─── HTTP fallback for chat.history ─────────────────────────────────────
app.get('/api/chat-history', requireAuth, async (req, res) => {
  try {
    const { sessionKey, limit = 50 } = req.query
    if (!sessionKey) return res.status(400).json({ ok: false, error: 'sessionKey required' })
    const [result] = await adminGwCall([{
      method: 'chat.history',
      params: { sessionKey, limit: Math.min(Number(limit), 100) }
    }])
    res.json({ ok: true, messages: result?.messages || [] })
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
    for (const r of savedLabels) labelMap[r.session_key] = r.label
    res.json(rows.map(r => ({
      session_key: r.session_key,
      label: labelMap[r.session_key] || cleanSessionLabel(r.session_label, r.session_key),
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
