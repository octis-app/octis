#!/usr/bin/env node
/**
 * Octis user management CLI
 * Usage:
 *   node scripts/create-user.js add <email> <password> [role]
 *   node scripts/create-user.js list
 *   node scripts/create-user.js reset-password <email> <new-password>
 *   node scripts/create-user.js delete <email>
 *
 * Roles: admin (full access, same as owner) | viewer (read + reply)
 * Default role: viewer
 */

import Database from 'better-sqlite3'
import bcrypt from 'bcrypt'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.OCTIS_DB_PATH
  || path.join(process.env.HOME || '/root', '.octis/octis.db')

let db
try {
  db = new Database(DB_PATH)
} catch (e) {
  // fallback: check if server uses workspace-relative path
  const alt = path.join(__dirname, '..', 'octis.db')
  try {
    db = new Database(alt)
  } catch {
    console.error(`Cannot open DB at ${DB_PATH} or ${alt}`)
    console.error('Set OCTIS_DB_PATH env var if your DB is elsewhere.')
    process.exit(1)
  }
}

// Ensure users table exists (safe no-op if already there)
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  agent_id TEXT NOT NULL DEFAULT 'main',
  created_at INTEGER DEFAULT (unixepoch())
)`)

// Add agent_id column if missing (migration for existing DBs)
try {
  db.exec(`ALTER TABLE users ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'`)
  console.log('[migrate] Added agent_id column to users table')
} catch {
  // column already exists — fine
}

const [,, cmd, ...args] = process.argv

function printUsage() {
  console.log(`
Usage:
  node scripts/create-user.js add <email> <password> [role] [agent_id]
  node scripts/create-user.js list
  node scripts/create-user.js reset-password <email> <new-password>
  node scripts/create-user.js delete <email>

Roles:  admin (full access)  |  viewer (read + reply)
agent_id: which OpenClaw agent this user sees (default: main)
  `)
}

async function addUser(email, password, role = 'viewer', agentId = 'main') {
  if (!email || !password) { printUsage(); process.exit(1) }
  const validRoles = ['admin', 'owner', 'viewer']
  if (!validRoles.includes(role)) {
    console.error(`Invalid role "${role}". Use: admin, viewer`)
    process.exit(1)
  }
  const hash = await bcrypt.hash(password, 12)
  try {
    db.prepare('INSERT INTO users (email, password_hash, role, agent_id) VALUES (?, ?, ?, ?)')
      .run(email, hash, role, agentId)
    console.log(`✅ Created user: ${email} | role: ${role} | agent_id: ${agentId}`)
  } catch (e) {
    if (e.message.includes('UNIQUE constraint')) {
      console.error(`❌ User already exists: ${email}`)
    } else {
      console.error('❌ Error:', e.message)
    }
    process.exit(1)
  }
}

async function resetPassword(email, newPassword) {
  if (!email || !newPassword) { printUsage(); process.exit(1) }
  const hash = await bcrypt.hash(newPassword, 12)
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, email)
  if (result.changes === 0) {
    console.error(`❌ User not found: ${email}`)
    process.exit(1)
  }
  console.log(`✅ Password reset for: ${email}`)
}

function listUsers() {
  const users = db.prepare('SELECT id, email, role, agent_id, datetime(created_at, \'unixepoch\') as created FROM users ORDER BY id').all()
  if (users.length === 0) {
    console.log('No users found.')
    return
  }
  console.log(`\n${'ID'.padEnd(4)} ${'Email'.padEnd(35)} ${'Role'.padEnd(8)} ${'AgentID'.padEnd(12)} Created`)
  console.log('─'.repeat(80))
  for (const u of users) {
    console.log(`${String(u.id).padEnd(4)} ${u.email.padEnd(35)} ${u.role.padEnd(8)} ${(u.agent_id||'main').padEnd(12)} ${u.created}`)
  }
  console.log()
}

function deleteUser(email) {
  if (!email) { printUsage(); process.exit(1) }
  const result = db.prepare('DELETE FROM users WHERE email = ?').run(email)
  if (result.changes === 0) {
    console.error(`❌ User not found: ${email}`)
    process.exit(1)
  }
  console.log(`✅ Deleted user: ${email}`)
}

switch (cmd) {
  case 'add':
    await addUser(args[0], args[1], args[2], args[3])
    break
  case 'list':
    listUsers()
    break
  case 'reset-password':
    await resetPassword(args[0], args[1])
    break
  case 'delete':
    deleteUser(args[0])
    break
  default:
    printUsage()
    process.exit(cmd ? 1 : 0)
}
