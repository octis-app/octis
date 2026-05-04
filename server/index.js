// server/index.js - Octis Node.js API server with Express
import express from 'express'
import cors from 'cors'
import session from 'express-session'
import passport from 'passport'
import { Strategy as LocalStrategy } from 'passport-local'
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt'
import bcrypt from 'bcryptjs'
import sqlite3 from 'sqlite3'
import { open } from 'sqlite'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import jwt from 'jsonwebtoken'
import { WebSocket } from 'ws'
import { spawn } from 'child_process'
import https from 'https'
import http from 'http'
import util from 'util'

const _require = createRequire(import.meta.url)
const pdfParse = _require('pdf-parse')

// Safety net: log unhandled rejections instead of crashing.
// The adminGwCall fix above prevents the main crash path, but this guards
// against any other dangling promise rejection.
process.on('unhandledRejection', (reason, promise) => {
  console.warn('Unhandled Rejection at:', promise, 'reason:', reason)
})

// ─── Config ──────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || '/root'
const GATEWAY_URL = process.env.GATEWAY_URL
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me'
const DATA_DIR = process.env.OCTIS_DATA_DIR || path.join(HOME, '.octis')
const SQLITE_PATH = path.join(DATA_DIR, 'octis.db')
const DEFAULT_PASSWORD_HASH = '$2a$10$o2x9gzp3989yBx242jN3uOh.ytK9E5R0k83oXpY4sYv2tL9.X.q2m' // default octis2026!

// Ensure data direcory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// ─── Database setup ──────────────────────────────────────────────────────────
sqlite3.verbose() // Enable detailed logging
const db = await open({
  filename: SQLITE_PATH,
  driver: sqlite3.Database
})

await db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  );

  CREATE TABLE IF NOT EXISTS agents_meta (
    agent_id TEXT PRIMARY KEY,
    emoji TEXT,
    description TEXT,
    name TEXT,
    soul TEXT,
    visible_in_picker BOOLEAN DEFAULT TRUE,
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS session_labels (
    session_key TEXT UNIQUE,
    label TEXT,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_agents_meta_visibility ON agents_meta(visible_in_picker);
`)

// Seed default admin user
try {
  const count = await db.get('SELECT COUNT(*) as count FROM users')
  if (count.count === 0) {
    const hash = await bcrypt.hash('octis2026!', 10)
    await db.run('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)', ['admin@local.dev', hash, 'admin'])
    console.log('[server] Seeded default admin user (email: admin@local.dev, password: octis2026!)')
  }
} catch (e) {
  console.error('[server] Failed to seed admin user:', e.message)
}

// ─── Session/Passport setup ──────────────────────────────────────────────────
const app = express()

// Enhanced security middleware
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? undefined : '*' }))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// Trust proxy for SSL termination
app.set('trust proxy', 1)

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', 
    sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000
  }
}))

// Passport local authentication
const saltRounds = 10

passport.use(new LocalStrategy(async (email, password, done) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email])
    if (!user) return done(null, false, { message: 'Incorrect email.' })
    
    const isValid = await bcrypt.compare(password, user.password_hash)
    if (!isValid) return done(null, false, { message: 'Incorrect password.' })
    
    return done(null, user)
  } catch (err) {
    return done(err)
  }
}))

// Passport JWT authentication for API endpoints
passport.use(new JwtStrategy({
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: JWT_SECRET
}, async (payload, done) => {
  try {
    const user = await db.get('SELECT id, email, role FROM users WHERE id = ?', [payload.id])
    if (user) return done(null, user)
    return done(null, false)
  } catch (err) {
    return done(err, false)
  }
}))

passport.serializeUser((user, done) => done(null, user.id))
passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.get('SELECT id, email, role FROM users WHERE id = ?', [id])
    done(null, user)
  } catch (err) {
    done(err, null)
  }
})

app.use(passport.initialize())
app.use(passport.session())

// ─── Authentication middleware ───────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  // JWT tokens preferred for API calls, cookies for web endpoints
  const jwtToken = ExtractJwt.fromAuthHeaderAsBearerToken()(req)
  const isLoggedIn = req.isAuthenticated() || (jwtToken && req.user)
  
  if (isLoggedIn) {
    return next()
  } 
  res.status(401).json({ error: 'Authentication required' })
}

// ─── Authentication routes ───────────────────────────────────────────────────
app.post('/login', passport.authenticate(['local'], { session: true }), async (req, res) => {
  const user = req.user
  // Set long-lived JWT token alongside session cookie for API access from same client
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' })
  res.cookie('octis_token', token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000
  })
  res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } })
})


app.post('/logout', (req, res) => {
  req.logout(() => {})
  req.session.destroy()
  res.clearCookie('connect.sid')
  res.clearCookie('octis_token')
  res.json({ ok: true })
})

// GET /logout — full client reset page
// Clears cookie + localStorage + service worker cache, then redirects to /
// Use this URL directly when the app is inaccessible (e.g. blinking auth loop on mobile)
app.get('/logout', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Logging Out...</title></head>
    <body>
      <script>
        // Clear cookies and local storage
        document.cookie.split(";").forEach(function(c) { 
          document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/"); 
        });
        localStorage.clear();
        sessionStorage.clear();
        
        // Unregister service workers
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then(function(registrations) {
            for(let registration of registrations) {
              registration.unregister();
            }
          });
        }
        
        // Redirect to login
        setTimeout(() => window.location.href = '/', 100);
      </script>
      <h3>Logging out...</h3>
      <noscript>Please clear browser cookies/storage and cache if issues persist.</noscript>
    </body>
    </html>
  `)
})

// ─── Admin WebSocket helper ───────────────────────────────────────────────────

function adminGwCall(calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:18789/gateway', {
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, Origin: 'http://localhost:18789' }
    })
    
    let resolved = false
    
    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'exec', commands: calls }))
    })
    
    ws.on('message', (data) => {
      try {
        const resp = JSON.parse(data.toString())
        if (resp.result) {
          if (!resolved) {
            resolved = true
            ws.close()
            resolve(resp.result)
          }
        } else if (resp.error && !resolved) {
          resolved = true
          ws.close()
          reject(new Error(resp.error))
        }
      } catch (e) {
        console.error('[server] Malformed ws data', e)
      }
    })
    
    ws.on('error', (err) => {
      console.error('[server] WS connection error', err.message)
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })
    
    ws.on('close', () => {
      if (!resolved) {
        resolved = true
        reject(new Error('WS connection closed unexpectedly'))
      }
    })
    
    // Timeout in case gateway doesn't respond
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        ws.terminate()
        reject(new Error('Admin GW request timed out'))
      }
    }, 30000) // 30 second timeout for admin commands
  })
}

// ─── Agents config (renameAgentId etc.) ─────────────────────────────────────
app.patch('/api/agents-config', requireAuth, (req, res) => {
  try {
    const { agentIds } = req.body
    if (!agentIds || !Array.isArray(agentIds) || agentIds.length > 10) {
      return res.status(400).json({ error: 'Invalid agentIds array - max 10 at a time' })
    }

    Promise.all(agentIds.map(id => adminGwCall([`op read "op://Octis/${id}/id"`, `config get agents.${id}.agentId`])
      .then(([opId, cfgId]) => {
        // Only update if 1Password + config disagree (migration needed)
        if (opId && opId.trim() !== cfgId?.trim && cfgId?.startsWith('agent:')) {
          console.log(`[server] Renaming agent ${cfgId} → ${opId}`)
          return adminGwCall([
            `config patch agents --json-value '{"${cfgId}":{"agentId":"${opId}"}}'`, 
            `config get agents.${opId}`,  // Verify creation
            `config delete agents.${cfgId}`       // Remove old key
          ])
        }
        return Promise.resolve()
      })))
      .then(() => res.json({ ok: true, renamed: agentIds.length }))
      .catch(e => {
        console.error('[server] Agent ID remapping failed', e.message)
        res.status(500).json({ error: 'Agent remapping failed', details: e.message })
      })

  } catch (e) {
    console.error('[server] Agent config request failed', e.message)
    res.status(500).json({ error: 'Invalid request', details: e.message })
  }
})

// ─── Session history (optional — requires COSTS_DB_URL) ──────────────────────
const { Pool } = _require('pg') // Dynamically require pg since not in package.json normally
let pgPool = null
if (process.env.COSTS_DB_URL) {
  try {
    pgPool = new Pool({ connectionString: process.env.COSTS_DB_URL, ssl: false })
    console.log('[server] Connected to PostgreSQL for cost tracking')
  } catch (e) {
    console.warn('[server] Could not connect to PostgreSQL:', e.message)
  }
}

// ─── Sessions routes ─────────────────────────────────────────────────────────
app.get('/api/sessions/my', requireAuth, async (req, res) => {
  try {
    const { label, daysBack = 30 } = req.query
    
    // From SQLite: Get user's sessions with labels from octis_session_labels if exists
    let sql = `
      SELECT DISTINCT 
        s.session_key,
        COALESCE(lab.label, s.session_label) AS label,
        s.session_metadata,
        s.first_message,
        s.agent_id,
        s.created_at,
        s.updated_at
      FROM json_each(
        json_object('main', json_array(
          ${db.query('SELECT session_key FROM active_sessions') ? "json_group_array(json_object('session_key', session_key, 'session_label', session_label)) FILTER (WHERE LENGTH(session_label) > 0)" : "json_array()"}
        ))
      ) AS j
      LEFT JOIN session_labels lab ON lab.session_key = j.value->>'session_key'
      LEFT JOIN users u ON u.id = lab.user_id
      WHERE (lab.user_id IS NULL OR lab.user_id = ?)
      ${
        label ? "AND (j.value->>'session_label' LIKE ? OR lab.label LIKE ?)" : ""
      }
      ORDER BY j.value->>'updated_at' DESC
    `
    
    const params = [req.user.id]
    if (label) params.push(`%${label}%`, `%${label}%`)
    
    // Simplified - just return a basic structure for UI
    const sessions = [
      { session_key: 'mock-session-1', label: 'Mock Session 1', agent_id: 'mock-agent' },
      { session_key: 'mock-session-2', label: 'Mock Session 2', agent_id: 'mock-agent' }
    ]
    
    res.json(sessions)
  } catch (e) {
    console.error('[server] Sessions get failed:', e.message)
    // Return an empty array as fallback
    res.json([])
  }
})

app.delete('/api/sessions/:key', requireAuth, async (req, res) => {
  try {
    const sessionKey = decodeURIComponent(req.params.key)
    
    // In actual implementation, we'd use openclaw gateway to delete
    // For mock, just return success
    if (sessionKey.startsWith('agent:')) {
      await adminGwCall([`sessions delete ${sessionKey}`])
      res.json({ ok: true })
    } else {
      res.status(400).json({ error: 'Invalid session key format' })
    }
  } catch (e) {
    console.error('[server] Session delete failed:', e.message)
    res.status(500).json({ error: 'Delete failed', details: e.message })
  }
})

// GET /api/sessions/:key/raw -> gateway sessions.read session:$key
// Streams raw turn data with minimal transform for client reconstruction
app.get('/api/sessions/:key/raw', requireAuth, async (req, res) => {
  try {
    const sessionKey = decodeURIComponent(req.params.key)
    if (!sessionKey.startsWith('agent:') && !sessionKey.startsWith('session:')) {
      return res.status(400).json({ error: 'Invalid session key format' })
    }
    
    // Get from OpenClaw gateway via adminGwCall
    const session = await adminGwCall([`sessions read ${sessionKey}`])
    
    // Send as streaming JSON
    res.setHeader('Content-Type', 'application/json')
    res.write(JSON.stringify(session))
    
  } catch (e) {
    console.error('[server] Session raw fetch failed:', e.message)
    res.status(500).json({ error: 'Raw session fetch failed', details: e.message })
  }
})

// ─── History routes ──────────────────────────────────────────────────────────
app.post('/api/sessions/history', requireAuth, async (req, res) => {
  try {
    const { sessionKeys } = req.body
    
    if (!Array.isArray(sessionKeys) || sessionKeys.length > 100) {
      return res.status(400).json({ error: 'Invalid sessionKeys - max 100 at a time' })
    }
    
    // Get history from multiple sessions
    const histories = {}
    for (const key of sessionKeys) {
      try {
        const history = await adminGwCall([`sessions history --session-key "${key}"`])
        histories[key] = history 
      } catch (e) {
        histories[key] = { error: e.message }
        console.warn(`[server] Failed to fetch history for ${key}`, e.message)
      }
    }
    
    res.json(histories)
  } catch (e) {
    console.error('[server] Bulk history fetch failed:', e.message)
    res.status(500).json({ error: 'Bulk history fetch failed', details: e.message })
  }
})

// ─── Agents routes ───────────────────────────────────────────────────────────
app.get('/api/agents', requireAuth, async (req, res) => {
  try {
    // Use the admin gateway to get agents
    const agents = await adminGwCall(['config get agents'])

    // Filter out system agents by default (configurable)
    const includeSystem = req.query.system !== undefined
    const filteredAgents = {}

    for (const [id, agentConfig] of Object.entries(agents)) {
      if (agentConfig.type === 'system' && !includeSystem) continue
      filteredAgents[id] = agentConfig
    }

    res.json(filteredAgents)
  } catch (e) {
    console.error('[server] Agents fetch failed:', e.message)
    res.status(500).json({ error: 'Agents fetch failed', details: e.message })
  }
})

app.patch('/api/agents/:id/meta', requireAuth, async (req, res) => {
  try {
    const { emoji, description, name, model, soul, visibleInPicker } = req.body
    const agentId = req.params.id

    // Store in our local metadata table, not in the gateway config
    // This allows us to manage UI display info without touching core configs
    const existing = await db.get('SELECT agent_id FROM agents_meta WHERE agent_id = ?', [agentId])
    
    if (existing) {
      await db.run(`
        UPDATE agents_meta SET emoji = ?, description = ?, name = ?, visible_in_picker = ?
        WHERE agent_id = ?
      `, [emoji, description, name, visibleInPicker ?? true, agentId])
    } else {
      await db.run(`
        INSERT INTO agents_meta (agent_id, emoji, description, name, soul, visible_in_picker)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [agentId, emoji, description, name, soul, visibleInPicker ?? true])
    }
    
    // Also update the gateway if there are core changes
    const changes = {}
    if (model) changes.model = model
    if (soul) changes.soul = soul
    
    if (Object.keys(changes).length > 0) {
      await adminGwCall([`config patch agents.${agentId} --json-value '${JSON.stringify(changes)}'`])
    }

    res.json({ ok: true, agentId, meta: { emoji, description, name, model, soul, visibleInPicker } })
  } catch (e) {
    console.error('[server] Agent meta update failed:', e.message)
    res.status(500).json({ error: 'Meta update failed', details: e.message })
  }
})

// ─── Labels routes ───────────────────────────────────────────────────────────
app.get('/api/sessions/labels', requireAuth, async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM session_labels WHERE user_id = ?', [req.user.id])
    res.json(rows.reduce((obj, row) => ({ ...obj, [row.session_key]: row.label }), {}))
  } catch (e) {
    console.error('[server] Labels fetch failed:', e.message)
    res.status(500).json({ error: 'Labels fetch failed', details: e.message })
  }
})

app.put('/api/sessions/:key/label', requireAuth, async (req, res) => {
  try {
    const sessionKey = decodeURIComponent(req.params.key)
    const { label } = req.body

    if (typeof label !== 'string' || label.length < 1 || label.length > 100) {
      return res.status(400).json({ error: 'Invalid label - string 1-100 chars required' })
    }

    const existing = await db.get('SELECT * FROM session_labels WHERE session_key = ?', [sessionKey])
    if (existing) {
      await db.run('UPDATE session_labels SET label = ?, updated_at = CURRENT_TIMESTAMP WHERE session_key = ?', [label, sessionKey])
    } else {
      await db.run('INSERT INTO session_labels (session_key, label, user_id) VALUES (?, ?, ?)', [sessionKey, label, req.user.id])
    }
    
    res.json({ ok: true, session_key: sessionKey, label })
  } catch (e) {
    console.error('[server] Label update failed:', e.message)
    res.status(500).json({ error: 'Label update failed', details: e.message })
  }
})

// ─── PDF extraction ──────────────────────────────────────────────────────────
app.post('/api/extract-pdf', requireAuth, async (req, res) => {
  if (!req.files || !req.files.pdf) {
    return res.status(400).json({ error: 'Missing pdf file' })
  }

  const pdfFile = req.files.pdf
  if (!pdfFile.name.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'File must be a PDF' })
  }

  try {
    const buffer = typeof pdfFile.data === 'string' ? Buffer.from(pdfFile.data, 'base64') : pdfFile.data
    const data = await pdfParse(buffer)
    const text = data.text.substring(0, 10000) // Limit to 10k chars

    res.json({ 
      ok: true, 
      text,
      totalPages: data.numpages || 0,
      title: data.info?.Title || '',
      author: data.info?.Author || '' 
    })
  } catch (e) {
    console.error('[server] PDF extraction failed:', e.message)
    res.status(500).json({ error: 'PDF extraction failed', details: e.message })
  }
})

// ─── Session autoname ─────────────────────────────────────────────────────────
app.post('/api/session-autoname', requireAuth, async (req, res) => {
  try {
    const { messages, sessionKey } = req.body

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array required' })
    }

    // Use Anthropic (claude-haiku) for autoname
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })

    const excerpt = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const text = typeof m.content === 'string' 
          ? m.content 
          : Array.isArray(m.content) 
            ? m.content.map(c => c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '').join(' ')
            : JSON.stringify(m.content || '')
        return `${m.role === 'user' ? 'User:' : 'Assistant:'} ${text}`
      })
      .join('\n')
      .substring(0, 3000)

    if (!excerpt.trim() || excerpt.replace(/User:|Assistant:/g, '').trim().length < 10)
      return res.status(400).json({ error: 'Not enough conversation content' })

    // Look up project context if sessionKey provided
    let projectContext = ''
    if (sessionKey) {
      // Get cached agent context associated with the session
      try {
        const agentId = sessionKey.split(':')[1] || ''
        if (agentId) {
          // For this demo, just look for any project-related patterns in session key
          if (agentId.includes('sage') || agentId.includes('accounting')) projectContext = 'Sage Intacct accounting system'
          else if (agentId.includes('centurion') || agentId.includes('real')) projectContext = 'Real estate investment analysis'
          else if (agentId.includes('casken')) projectContext = 'Casken collaboration platform'
        }
      } catch {}
    }

    const systemPrompt = `You are a session naming expert. Generate concise, project-relevant titles.
Examples: "Sage GL Migration Issue" | "Centurion Property Valuation" | "Casken API Design"
Rules: 3-5 words, project-aware when possible, action-oriented`

    const fullPrompt = `
Below is a conversation between a user and AI assistant. Generate a brief, descriptive session title 
that captures the main topic${projectContext ? ` (related to ${projectContext})` : ''}.
RESPOND WITH THE TITLE ONLY - no quotes, no explanations, no punctuation except hyphens/spaces as needed.

Conversation:
${excerpt}

Title:`

    const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        system: systemPrompt,
        messages: [{ role: 'user', content: fullPrompt }],
        max_tokens: 60
      })
    })

    if (!apiResponse.ok) {
      const errorData = await apiResponse.text()
      throw new Error(`Anthropic API error: ${apiResponse.status} - ${errorData}`)
    }

    // Anthropic format: content[0].text
    const data = await apiResponse.json()
    // Anthropic format: content[0].text
    const raw = (data?.content?.[0]?.text || '').trim()
    const label = raw.split('\n')[0].replace(/^['"`*\-•]+|['"`*\-•]+$/g, '').trim().slice(0, 60)
    if (!label) return res.status(500).json({ error: 'Empty label from model' })
    res.json({ label })
  } catch (e) {
    console.error('[server] Session autoname failed:', e.message)
    res.status(500).json({ error: 'Autonaming failed', details: e.message })
  }
})

// ─── Gateway passthrough (with auth) ─────────────────────────────────────────
// POST /api/gateway -> adminGwCall
app.post('/api/gateway', requireAuth, async (req, res) => {
  try {
    const { commands } = req.body
    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'Command array required' })
    }
    
    if (commands.length > 10) {
      return res.status(400).json({ error: 'Max 10 commands at a time' })
    }

    // Validate that commands are safe
    for (const cmd of commands) {
      if (typeof cmd !== 'string') continue
      // Basic blacklist (extendable) 
      if (/^(config\s+patch|gateway\s+restart|gateway\s+stop|pm2\s+\w+\s+openclaw|docker\s+\w+\s+openclaw)/.test(cmd.trim())) {
        console.log(`[server] BLOCKED command from user ${req.user.id}: ${cmd}`)
        return res.status(403).json({ error: 'Command not authorized' })
      }
    }

    const result = await adminGwCall(commands)
    res.json(result)
  } catch (e) {
    console.error('[server] Gateway passthrough failed:', e.message)
    res.status(500).json({ error: 'Gateway call failed', details: e.message })
  }
})

// ─── Chat routes ─────────────────────────────────────────────────────────────
app.get('/api/chat/history', requireAuth, async (req, res) => {
  // Same as before (no conflict here)
  try {
    const sessionKey = req.query.session
    if (!sessionKey) {
      return res.status(400).json({ error: 'session param required' })
    }

    // Get from OpenClaw gateway 
    const result = await adminGwCall([
      `sessions history --session-key "${sessionKey}" --format compact --include-tools false`
    ])

    // If result contains history in expected format, send it as-is
    if (result && typeof result === 'object') {
      // Result should be an array of turns [user, assistant, user, assistant, ...]
      res.json(Array.isArray(result) ? result : { error: 'Unexpected history format' })
    } else {
      res.status(500).json({ error: 'History not in expected format', result })
    }
  } catch (e) {
    console.error('[server] Chat history failed:', e.message)
    res.status(500).json({ error: 'History fetch failed', details: e.message })
  }
})

app.post('/api/chat/send', requireAuth, async (req, res) => {
  // Same as before (no conflict here)
  try {
    const { session, messages, tool } = req.body
    
    if (!session || !messages) {
      return res.status(400).json({ error: 'session and messages required' })
    }

    // Validate message format
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' })
    }

    // Determine action based on tool
    const isRegenerate = tool === 'regenerate'
    const isContinue = tool === 'continue' 

    let result
    if (isRegenerate) {
      // Just regenerate last response
      result = await adminGwCall([`sessions chat --session-key "${session}" --regenerate`])
    } else if (isContinue) {
      // Continue without input message
      result = await adminGwCall([`sessions chat --session-key "${session}" --continue`])
    } else {
      // Standard send: convert our format to OpenClaw format and send
      const lastMsg = messages[messages.length - 1]
      if (lastMsg.role !== 'user') {
        return res.status(400).json({ error: 'Final message must be user role' })
      }
      
      // Extract content properly from our format
      const content = lastMsg.content
      const textContent = typeof content === 'string' 
        ? content
        : Array.isArray(content)
          ? content.map(c => c.type === 'text' ? c.text : 
                     c.type === 'image' ? `[image:${c.data?.substring(0, 20)||''}]` : 
                     JSON.stringify(c)).join(' ')
          : JSON.stringify(content)

      result = await adminGwCall([`sessions chat --session-key "${session}" --message "${textContent.replace(/"/g, "'")}"`])
    }

    res.json(result || { error: 'no result from gateway' })
  } catch (e) {
    console.error('[server] Chat send failed', e.message)
    res.status(500).json({ error: 'Send failed', details: e.message })
  }
})

// ─── Enrich image blocks stripped by gateway chat.history ───────────────────
// The gateway strips base64 data from image blocks for bandwidth efficiency.
// This helper reads the local JSONL to restore image data for user messages.
// Handles both OpenClaw native format ({type:'image', data:...}) and
// Anthropic format ({type:'image', source:{type:'base64', data:...}})
function hasImageData(block) {
  // Both formats have some form of image data
  return (block.type === 'image') && 
         ((block.data && typeof block.data === 'string') ||
         (block.source && block.source.data && typeof block.source.data === 'string'))
}

async function enrichImageBlocks(sessionKey, messages) {
  // Find user messages with image blocks that have empty data
  const needsEnrich = messages.some(m =>
    m.role === 'user' && Array.isArray(m.content) &&
    m.content.some(b => b.type === 'image' && !hasImageData(b))
  )
  if (!needsEnrich) return messages

  // Session files are located in openclaw agents/{id}/sessions/{sessionKey}.jsonl
  // Try to locate the session file by looking up the actual session
  let sessionFile = null
  try {
    const sessionInfo = await adminGwCall([`sessions list --filter-key "${sessionKey}"`])
    // The session file path would come from gateway API
    if (sessionInfo && sessionInfo.location) {
      sessionFile = sessionInfo.location
    }
  } catch (e) {
    console.warn(`[server] Could not locate session file for ${sessionKey}:`, e.message)
    return messages // Return unchanged if can't access file
  }

  if (!sessionFile || !fs.existsSync(sessionFile)) {
    console.warn(`[server] Session file missing for image enrichment: ${sessionFile}`)
    return messages
  }

  // Build a map of user message content → enriched version with img data 
  // by parsing the raw JSONL file
  const contentLines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean)
  const imageMap = new Map() // text representation → full content array with images

  for (const line of contentLines) {
    try {
      const evt = JSON.parse(line)
      if (evt.message?.role === 'user' && Array.isArray(evt.message.content)) {
        const hasImgData = evt.message.content.some(b => hasImageData(b))
        if (hasImgData) {
          const key = textKey(evt.message.content, true) // strip envelope for matching
          if (key) imageMap.set(key, evt.message.content)
        }
      }
    } catch (e) {
      // Continue - malformed JSON in turn is okay
    }
  }

  // Helper to create a comparable string key for matching content
  function textKey(contentArray, includeAll = false) {
    if (!Array.isArray(contentArray)) return null
    if (includeAll) return contentArray.map(c => c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : JSON.stringify(c)).join(' | ')
    else return contentArray.filter(c => c.type === 'text').map(c => c.text).join(' | ')
  }

  return messages.map(m => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m
    const hasEmptyImage = m.content.some(b => b.type === 'image' && !hasImageData(b))
    if (!hasEmptyImage) return m
    const key = textKey(m.content)
    const richContent = key && imageMap.get(key)
    
    if (!richContent) {
      console.log(`[server] No enriched image data found for message in ${sessionKey}`)
      return m // Return original if no enriched version 
    }
                
    // Replace the image blocks with the ones that have data
    return {
      ...m,
      content: m.content.map((block, i) => {
        if (block.type === 'image' && !hasImageData(block) && i < richContent.length) {
          return richContent[i] // Return the enriched version
        }
        return block
      })
    }
  })
}

// ─── Cost tracking ───────────────────────────────────────────────────────────
app.get('/api/costs/tracking', requireAuth, async (req, res) => {
  if (!pgPool) return res.json({ disabled: true, message: 'Set COSTS_DB_URL to enable cost tracking.' })
  try {
    const days = Math.min(parseInt(req.query.days || '30'), 90)
    const userId = 'kennan'  // Kennan's data only
    
    // Get daily aggregates from trajectory-based cost extraction
    const { rows: daily } = await pgPool.query(`
      SELECT cost_date, total_cost_usd, input_tokens, output_tokens, sessions_count
      FROM kennan.claw_user_daily_costs 
      WHERE user_id = $1 AND cost_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      ORDER BY cost_date ASC
    `, [userId, days])
    
    // Get top sessions (last N days)
    const { rows: sessions } = await pgPool.query(`
      SELECT cs.session_id AS session_key, COALESCE(ol.label, cs.first_message) AS session_label,
        cs.sender_name, SUM(cs.total_cost_usd) AS cost, MAX(cs.last_ts) AS last_activity,
        SUM(cs.input_tokens) AS input_tokens, SUM(cs.output_tokens) AS output_tokens
      FROM kennan.claw_session_costs cs
      LEFT JOIN kennan.octis_session_labels ol ON ol.session_key = cs.session_id
      WHERE cs.user_id = $1 AND cs.session_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      GROUP BY cs.session_id, cs.first_message, cs.sender_name, ol.label
      ORDER BY SUM(cs.total_cost_usd) DESC
      LIMIT 50
    `, [userId, days])
    
    // Get today's totals for dashboard cards
    const { rows: syncRow } = await pgPool.query(`
      SELECT MAX(last_ts) AS last_sync FROM kennan.claw_user_daily_costs WHERE user_id = $1
      AND cost_date = CURRENT_DATE
    `, [userId])
    
    const { rows: todayRow } = await pgPool.query(`
      SELECT 
        SUM(total_cost_usd) AS today_cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(CASE WHEN turn_count > 0 THEN 1 ELSE 0 END) AS session_count
      FROM kennan.claw_session_costs 
      WHERE user_id = $1 AND session_date = CURRENT_DATE
    `, [userId])
    
    console.log('[DEBUG] todayRow from kennan.claw_user_daily_costs:', JSON.stringify(todayRow))
    const todayCostTotal = parseFloat(todayRow[0]?.today_cost || 0)
    console.log('[DEBUG] todayCostTotal:', todayCostTotal)
    
    // Get today's top sessions (FIXED: use session_date for better performance)
    const { rows: todaySessionRows } = await pgPool.query(`
      SELECT cs.session_id AS session_key, COALESCE(ol.label, cs.first_message) AS session_label,
        cs.sender_name, SUM(cs.total_cost_usd) AS cost, MAX(cs.last_ts) AS last_activity,
        SUM(cs.input_tokens) AS input_tokens, SUM(cs.output_tokens) AS output_tokens
      FROM kennan.claw_session_costs cs
      LEFT JOIN kennan.octis_session_labels ol ON ol.session_key = cs.session_id
      WHERE cs.user_id = $1 AND cs.session_date = CURRENT_DATE
      GROUP BY cs.session_id, cs.first_message, cs.sender_name, ol.label
      ORDER BY cost DESC LIMIT 20
    `, [userId])
    
    // Get yesterday's total for comparison
    const { rows: yesterdayRow } = await pgPool.query(`
      SELECT COALESCE(SUM(total_cost_usd), 0) AS yesterday_cost
      FROM kennan.claw_user_daily_costs 
      WHERE user_id = $1 AND cost_date = CURRENT_DATE - INTERVAL '1 day'
    `, [userId])

    // Format the response data 
    res.json({
      enabled: true,
      daysRequested: days,
      summary: {
        total: sessions.reduce((sum, r) => sum + parseFloat(r.cost || 0), 0),
        sessionCount: sessions.length,
        today: todayCostTotal,
        todayInputTokens: parseInt(todayRow[0]?.input_tokens || 0),
        todayOutputTokens: parseInt(todayRow[0]?.output_tokens || 0),
        todaySessionCount: parseInt(todayRow[0]?.session_count || 0),
        yesterday: parseFloat(yesterdayRow[0]?.yesterday_cost || 0),
        lastSync: syncRow[0]?.last_sync || null,
      },
      daily: daily.map(r => ({
        date: String(r.date).slice(0, 10),
        cost: parseFloat(r.total_cost_usd || 0),
        input_tokens: parseInt(r.input_tokens || 0),
        output_tokens: parseInt(r.output_tokens || 0),        
        session_count: parseInt(r.session_count || 0)
      })),
      sessions: sessions.map(r => ({ 
        session_key: r.session_key, 
        cost: parseFloat(r.cost), 
        input_tokens: parseInt(r.input_tokens || 0),
        output_tokens: parseInt(r.output_tokens || 0),
        session_label: cleanSessionLabel(r.session_label, r.session_key) 
      })),
      todaySessions: todaySessionRows.map(r => ({ 
        session_key: r.session_key, 
        cost: parseFloat(r.cost),
        input_tokens: parseInt(r.input_tokens || 0),
        output_tokens: parseInt(r.output_tokens || 0),
        session_label: cleanSessionLabel(r.session_label, r.session_key) 
      })),
    })
  } catch (e) {
    console.error('[server] Costs tracking failed:', e.message)
    if (e.message.includes('relation "kennan')) {
      res.status(500).json({ 
        error: 'Missing kennan cost tables. Run init-user-cost-tracking.sql to set up schema.' 
      })
    } else {
      res.status(500).json({ error: 'Cost tracking error', details: e.message })  
    }
  }
})

// Clean session label for display - extract meaningful part from raw message
function cleanSessionLabel(label, sessionKey) {
  if (!label) return sessionKey.split(':').pop() || sessionKey
  
  // If it's a raw first message, simplify it
  if (typeof label === 'string') {
    let clean = label
      .replace(/^(User:|user:|assistant:|Assistant:)\s*/, '')  // Remove role prefixes
      .replace(/[.!?]+\s*$/, '')  // Remove trailing punctuation
      .replace(/\s+/g, ' ')  // Reduce multiple spaces
      .trim()
    
    // Shorten if too long
    return clean.length > 60 ? clean.substring(0, 60) + '...' : clean
  }
  
  return String(label).substring(0, 60)
}

// ─── Session history (optional — requires COSTS_DB_URL) ──────────────────────

app.get('/api/sessions/history', async (req, res) => {
  if (!pgPool) return res.json([])
  
  try {
    const days = Math.min(parseInt(req.query.days || '30'), 30)
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000)

    const { rows } = await pgPool.query(`
      SELECT session_id AS session_key, first_message AS session_label, sender_name,
        SUM(total_cost_usd) AS cost, MIN(session_date) AS first_date,
        MAX(last_ts) AS last_activity, SUM(turn_count) AS turn_count
      FROM kennan.claw_session_costs
      WHERE session_date >= CURRENT_DATE - INTERVAL '${days} days'
      GROUP BY session_id, first_message, sender_name
      ORDER BY MAX(last_ts) DESC LIMIT ?
    `, [limit])

    res.json(rows.map(row => ({
      // ... conversion to expected format
      session_key: row.session_key,
      session_label: row.session_label,
      sender: row.sender_name,
      cost: parseFloat(row.cost || 0),
      first_date: row.first_date,
      last_activity: row.last_activity,
      turn_count: parseInt(row.turn_count || 0)
    })))
  } catch (e) {
    console.error('[server] Session history fetch failed:', e.message)
    res.json([]) // Return empty as fallback
  }
})

// ─── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
const isHttps = process.env.HTTPS === '1'

if (isHttps) {
  // Use local development certificate (self-signed or from certbot)
  const options = {
    key: fs.readFileSync(process.env.SSL_KEY || path.join(DATA_DIR, 'cert/privkey.pem')),
    cert: fs.readFileSync(process.env.SSL_CERT || path.join(DATA_DIR, 'cert/fullchain.pem'))
  }
  
  https.createServer(options, app).listen(PORT, () => {
    console.log(`[octis] Server running on https://localhost:${PORT}`)
  })
} else {
  http.createServer(app).listen(PORT, () => {
    console.log(`[octis] Server running on http://localhost:${PORT}`)
  })
}

// DEBUG endpoint for cost tracking
app.get('/debug/costs', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not available in production')
  }
  
  try {
    const { rows } = await pgPool.query(`
        SELECT session_id, first_message, total_cost_usd, last_ts, session_date 
        FROM kennan.claw_session_costs 
        WHERE session_date >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY session_date DESC
        LIMIT 10
    `)
    
    res.json(rows)
  } catch (e) {
    console.error('DEBUG costs error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

console.log(`[octis] Started with data dir: ${DATA_DIR}`)
console.log(`[octis] Gateway: ${GATEWAY_URL || 'not set'} | Token: ${GATEWAY_TOKEN ? 'set' : 'not set'}`)
console.log(`[octis] Data: ${SQLITE_PATH}`)