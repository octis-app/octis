import express from 'express'
import cors from 'cors'
import pg from 'pg'
import fs from 'fs/promises'
import path from 'path'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || process.env.OCTIS_API_PORT || 3747

// --- Postgres ---
const pool = new pg.Pool({
  host: process.env.PG_HOST || '34.95.39.115',
  database: process.env.PG_DB || 'beatimo_warehouse',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
  ssl: false,
})

// --- Memory paths ---
const WORKSPACE = process.env.OCTIS_WORKSPACE || path.join(process.env.HOME, '.openclaw/workspace')
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md')
const TODOS_FILE = path.join(WORKSPACE, 'TODOS.md')
const MEMORY_DIR = path.join(WORKSPACE, 'memory')

// --- Endpoints ---

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }))

// Session costs — today + rolling 7 days
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

    const { rows: todayRow } = await pool.query(`
      SELECT COALESCE(SUM(total_cost_usd), 0) AS today_cost
      FROM raw_nexus.claw_user_daily_costs
      WHERE cost_date = CURRENT_DATE
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

// Memory — MEMORY.md + TODOS.md + recent daily logs
app.get('/api/memory', async (req, res) => {
  try {
    const [memory, todos] = await Promise.all([
      fs.readFile(MEMORY_FILE, 'utf8').catch(() => ''),
      fs.readFile(TODOS_FILE, 'utf8').catch(() => ''),
    ])

    // Get recent daily logs (last 3 days)
    let recentLogs = []
    try {
      const files = await fs.readdir(MEMORY_DIR)
      const dateFiles = files
        .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .slice(-3)
        .reverse()

      recentLogs = await Promise.all(
        dateFiles.map(async f => ({
          date: f.replace('.md', ''),
          content: await fs.readFile(path.join(MEMORY_DIR, f), 'utf8').catch(() => ''),
        }))
      )
    } catch {}

    // Get project files
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

// Projects — full content + file metadata
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
        return {
          name: f.replace('.md', ''),
          content,
          size: stat?.size || 0,
          mtime: stat?.mtime || null,
        }
      })
    )
    res.json({ projects })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Todos only (for session sidebar)
app.get('/api/todos', async (req, res) => {
  try {
    const todos = await fs.readFile(TODOS_FILE, 'utf8').catch(() => '')
    res.json({ todos })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const distPath = path.join(__dirname, '..', 'dist')
  app.use(express.static(distPath))
  // Catch-all for SPA routing — must come after API routes and static
  app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`Octis API server running on http://localhost:${PORT}`)
})
