#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import pg from 'pg'

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/root/.openclaw'
const COSTS_DB_URL = process.env.COSTS_DB_URL
const USER_ID = process.env.COSTS_USER_ID || 'kennan'

if (!COSTS_DB_URL) {
  console.error('[sync-costs-v3] COSTS_DB_URL not set')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: COSTS_DB_URL })

async function main() {
  const sessionsFile = path.join(OPENCLAW_HOME, 'agents/main/sessions/sessions.json')
  
  if (!fs.existsSync(sessionsFile)) {
    console.error('[sync-costs-v3] sessions.json not found')
    process.exit(1)
  }
  
  const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
  
  const dailyCosts = {}
  let totalCost = 0
  
  for (const [key, session] of Object.entries(sessions)) {
    const cost = session.estimatedCostUsd || 0
    if (cost <= 0) continue
    
    const date = session.updatedAt 
      ? new Date(session.updatedAt).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10)
    
    dailyCosts[date] = (dailyCosts[date] || 0) + cost
    totalCost += cost
  }
  
  console.log('[sync-costs-v3] Sessions.json total: $' + totalCost.toFixed(2))
  
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM kennan.claw_user_daily_costs WHERE user_id = $1', [USER_ID])
    
    for (const [date, cost] of Object.entries(dailyCosts)) {
      await client.query(
        'INSERT INTO kennan.claw_user_daily_costs (cost_date, user_id, total_cost_usd, sessions_count, source) VALUES ($1, $2, $3, 1, $4)',
        [date, USER_ID, cost, 'sessions.json']
      )
    }
    
    await client.query('COMMIT')
    console.log('[sync-costs-v3] ✅ Synced')
    
    const sorted = Object.entries(dailyCosts).sort((a, b) => b[0].localeCompare(a[0]))
    for (const [date, cost] of sorted) {
      console.log('  ' + date + ': $' + cost.toFixed(2))
    }
    
  } finally {
    client.release()
  }
  
  await pool.end()
}

main().catch(e => {
  console.error('[sync-costs-v3] Fatal:', e.message)
  process.exit(1)
})
