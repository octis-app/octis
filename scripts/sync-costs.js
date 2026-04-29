#!/usr/bin/env node
/**
 * sync-costs.js — ETL: OpenClaw sessions.json → raw_nexus cost tables
 *
 * Reads all agent sessions.json files and syncs cost data into Postgres.
 * Designed to run on a schedule (every 15min via cron or pm2-cron).
 *
 * Usage:
 *   node sync-costs.js
 *   COSTS_DB_URL=postgresql://... node sync-costs.js
 */

import pg from 'pg'
import fs from 'fs'
import path from 'path'
import os from 'os'

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw')
const COSTS_DB_URL = process.env.COSTS_DB_URL
const DRY_RUN = process.env.DRY_RUN === '1'

if (!COSTS_DB_URL) {
  // Try to load from octis .env
  try {
    const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.env')
    const envContent = fs.readFileSync(envPath, 'utf8')
    for (const line of envContent.split('\n')) {
      const [k, ...v] = line.split('=')
      if (k?.trim() === 'COSTS_DB_URL' && v.join('=').trim()) {
        process.env.COSTS_DB_URL = v.join('=').trim()
        break
      }
    }
  } catch {}
}

const DB_URL = process.env.COSTS_DB_URL
if (!DB_URL) {
  console.error('[sync-costs] COSTS_DB_URL not set — skipping')
  process.exit(0)
}

const pool = new pg.Pool({ connectionString: DB_URL, ssl: false, max: 3 })

// Anthropic pricing (USD per 1M tokens) - as of 2026-04
const PRICING = {
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-5': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
}

function estimateCost(inputTokens, outputTokens, model = 'claude-sonnet-4-5') {
  const pricing = PRICING[model] || PRICING['claude-sonnet-4-5']
  const inputCost = (inputTokens / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output
  return inputCost + outputCost
}

/** Find all agents' sessions.json files */
function findSessionFiles() {
  const agentsDir = path.join(OPENCLAW_HOME, 'agents')
  const files = []
  if (!fs.existsSync(agentsDir)) return files
  for (const agent of fs.readdirSync(agentsDir)) {
    const f = path.join(agentsDir, agent, 'sessions', 'sessions.json')
    if (fs.existsSync(f)) files.push({ agent, file: f })
  }
  return files
}

/** Extract a readable sender name from session origin */
function senderName(session) {
  const origin = session.origin || {}
  if (origin.label) return origin.label
  if (origin.from) {
    // strip provider prefix: "slack:U0ATVAC5HL2" → "U0ATVAC5HL2"
    const parts = origin.from.split(':')
    return parts[parts.length - 1]
  }
  return origin.provider || 'unknown'
}

/** Strip agent prefix from session key for display */
function cleanSessionKey(key) {
  return key.replace(/^agent:[^:]+:/, '')
}

/** Parse a session's "first message" from its first .jsonl turn if available */
function firstMessage(session) {
  // Use session ID as fallback; try to read first user message from jsonl
  if (!session.sessionFile) return session.sessionId
  try {
    const content = fs.readFileSync(session.sessionFile, 'utf8')
    const lines = content.trim().split('\n')
    for (const line of lines) {
      try {
        const turn = JSON.parse(line)
        if (turn.role === 'user') {
          const text = typeof turn.content === 'string'
            ? turn.content
            : (Array.isArray(turn.content)
                ? turn.content.find(c => c.type === 'text')?.text || ''
                : '')
          const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 120)
          if (trimmed.length > 3) return trimmed
        }
      } catch {}
    }
  } catch {}
  return cleanSessionKey(session.sessionId || '')
}

async function sync() {
  const client = await pool.connect()
  try {
    const sessionFiles = findSessionFiles()
    console.log(`[sync-costs] Found ${sessionFiles.length} session store(s)`)

    // Collect all sessions across agents
    const allSessions = []
    for (const { agent, file } of sessionFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const [key, session] of Object.entries(data)) {
          const cost = parseFloat(session.estimatedCostUsd) || 0
          if (cost <= 0 && !session.updatedAt) continue  // skip empty sessions
          allSessions.push({ key, session, agent })
        }
      } catch (e) {
        console.warn(`[sync-costs] Failed to read ${file}:`, e.message)
      }
    }

    console.log(`[sync-costs] Processing ${allSessions.length} sessions`)

    // Upsert session costs
    for (const { key, session } of allSessions) {
      const inputTok = parseInt(session.inputTokens) || 0
      const outputTok = parseInt(session.outputTokens) || 0
      
      // Calculate cost from tokens (since OpenClaw doesn't populate estimatedCostUsd)
      const cost = estimateCost(inputTok, outputTok)
      
      const updatedAt = session.updatedAt ? new Date(session.updatedAt) : new Date()
      const sessionDate = updatedAt.toISOString().slice(0, 10)
      const sessionId = cleanSessionKey(key)
      const sender = senderName(session)
      const msg = firstMessage(session)

      if (DRY_RUN) {
        console.log(`  DRY: ${sessionId} | cost=$${cost.toFixed(4)} | date=${sessionDate} | sender=${sender}`)
        continue
      }

      await client.query(`
        INSERT INTO raw_nexus.claw_session_costs
          (session_id, first_message, sender_name, total_cost_usd, last_ts, session_date, input_tokens, output_tokens, turn_count, user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (session_id, session_date) DO UPDATE SET
          total_cost_usd = EXCLUDED.total_cost_usd,
          first_message = EXCLUDED.first_message,
          sender_name = EXCLUDED.sender_name,
          last_ts = EXCLUDED.last_ts,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          turn_count = EXCLUDED.turn_count,
          user_id = EXCLUDED.user_id
      `, [sessionId, msg, sender, cost, updatedAt, sessionDate, inputTok, outputTok, 0, 'kennan'])
    }

    if (!DRY_RUN) {
      // Rebuild daily aggregates from session data (Kennan only)
      await client.query(`
        INSERT INTO raw_nexus.claw_user_daily_costs (cost_date, total_cost_usd, input_tokens, output_tokens, session_count, user_id)
        SELECT
          session_date AS cost_date,
          SUM(total_cost_usd) AS total_cost_usd,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          COUNT(DISTINCT session_id) AS session_count,
          'kennan' AS user_id
        FROM raw_nexus.claw_session_costs
        WHERE user_id = 'kennan'
        GROUP BY session_date
        ON CONFLICT (cost_date) DO UPDATE SET
          total_cost_usd = EXCLUDED.total_cost_usd,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          session_count = EXCLUDED.session_count
      `)
    }

    // Print summary
    const { rows: daily } = await client.query(`
      SELECT cost_date, total_cost_usd, session_count
      FROM raw_nexus.claw_user_daily_costs
      ORDER BY cost_date DESC LIMIT 7
    `)
    const { rows: total } = await client.query(`
      SELECT COUNT(*) as sessions, SUM(total_cost_usd) as total FROM raw_nexus.claw_session_costs
    `)

    console.log(`[sync-costs] ✅ Done — ${total[0].sessions} sessions, $${parseFloat(total[0].total || 0).toFixed(4)} total`)
    console.log('[sync-costs] Daily breakdown:')
    for (const row of daily) {
      console.log(`  ${String(row.cost_date).slice(0,10)} | $${parseFloat(row.total_cost_usd).toFixed(4)} | ${row.session_count} sessions`)
    }
  } finally {
    client.release()
    await pool.end()
  }
}

sync().catch(e => {
  console.error('[sync-costs] Fatal error:', e.message)
  process.exit(1)
})
