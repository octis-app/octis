#!/usr/bin/env node
/**
 * sync-costs-v2.js — Extract costs from OpenClaw trajectory files
 */

import fs from 'fs'
import path from 'path'
import pg from 'pg'
import { execSync } from 'child_process'

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/root/.openclaw'
const COSTS_DB_URL = process.env.COSTS_DB_URL
const USER_ID = process.env.COSTS_USER_ID || 'kennan'

if (!COSTS_DB_URL) {
  console.error('[sync-costs-v2] COSTS_DB_URL not set')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: COSTS_DB_URL })

function extractCostsFromTrajectoryFiles() {
  const sessionsDir = path.join(OPENCLAW_HOME, 'agents/main/sessions')
  const dailyCosts = {}
  
  // Get active trajectory files
  const activeFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.trajectory.jsonl'))
  for (const file of activeFiles) {
    const filePath = path.join(sessionsDir, file)
    const stat = fs.statSync(filePath)
    const fileDate = stat.mtime.toISOString().slice(0, 10)
    
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const matches = content.match(/"cost":\{[^}]*"total":([0-9.]+)/g) || []
      for (const match of matches) {
        const costMatch = match.match(/([0-9.]+)$/)
        if (costMatch) {
          const cost = parseFloat(costMatch[1])
          if (cost > 0 && cost < 100) { // Sanity check - single API call shouldn't cost >$100
            dailyCosts[fileDate] = (dailyCosts[fileDate] || 0) + cost
          }
        }
      }
    } catch {}
  }
  
  // Get deleted trajectory files
  const deletedFiles = fs.readdirSync(sessionsDir).filter(f => f.includes('.trajectory.jsonl.deleted.'))
  for (const file of deletedFiles) {
    // Extract date from deletion timestamp in filename
    const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/)
    const fileDate = dateMatch ? dateMatch[1] : null
    if (!fileDate) continue
    
    const filePath = path.join(sessionsDir, file)
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const matches = content.match(/"cost":\{[^}]*"total":([0-9.]+)/g) || []
      for (const match of matches) {
        const costMatch = match.match(/([0-9.]+)$/)
        if (costMatch) {
          const cost = parseFloat(costMatch[1])
          if (cost > 0 && cost < 100) {
            dailyCosts[fileDate] = (dailyCosts[fileDate] || 0) + cost
          }
        }
      }
    } catch {}
  }
  
  return dailyCosts
}

async function main() {
  console.log('[sync-costs-v2] Extracting costs from trajectory files...')
  
  const dailyCosts = extractCostsFromTrajectoryFiles()
  
  let totalCost = 0
  for (const cost of Object.values(dailyCosts)) {
    totalCost += cost
  }
  
  console.log(`[sync-costs-v2] Found ${Object.keys(dailyCosts).length} days, $${totalCost.toFixed(2)} total`)
  
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    
    // Clear old trajectory data for this user
    await client.query(
      "DELETE FROM kennan.claw_user_daily_costs WHERE user_id = $1 AND source = 'trajectory'",
      [USER_ID]
    )
    
    // Insert new data
    for (const [date, cost] of Object.entries(dailyCosts)) {
      await client.query(`
        INSERT INTO kennan.claw_user_daily_costs (cost_date, user_id, total_cost_usd, sessions_count, source)
        VALUES ($1, $2, $3, 1, 'trajectory')
        ON CONFLICT (cost_date, user_id) DO UPDATE SET
          total_cost_usd = EXCLUDED.total_cost_usd,
          source = 'trajectory',
          updated_at = NOW()
      `, [date, USER_ID, cost])
    }
    
    await client.query('COMMIT')
    
    console.log('[sync-costs-v2] ✅ Synced to database')
    
    // Print breakdown
    console.log('[sync-costs-v2] Daily breakdown:')
    const sorted = Object.entries(dailyCosts).sort((a, b) => b[0].localeCompare(a[0]))
    for (const [date, cost] of sorted) {
      console.log(`  ${date}: $${cost.toFixed(2)}`)
    }
    
  } finally {
    client.release()
  }
  
  await pool.end()
}

main().catch(e => {
  console.error('[sync-costs-v2] Fatal:', e.message)
  process.exit(1)
})
