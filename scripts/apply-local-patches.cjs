#!/usr/bin/env node
/**
 * apply-local-patches.js
 * Re-applies local Octis patches that are NOT upstream.
 * Run automatically after git pull via .git/hooks/post-merge.
 * Run manually: node scripts/apply-local-patches.js
 *
 * Each patch: { file, marker, apply(content) -> newContent }
 * If marker is already present, patch is skipped (idempotent).
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function patch(relPath, marker, transform) {
  const absPath = path.join(ROOT, relPath)
  let content = fs.readFileSync(absPath, 'utf8')
  if (content.includes(marker)) {
    console.log(`  [skip] ${relPath} — already patched`)
    return
  }
  const result = transform(content)
  if (result === content) {
    console.warn(`  [WARN] ${relPath} — transform made no changes (anchor not found?)`)
    return
  }
  fs.writeFileSync(absPath, result, 'utf8')
  console.log(`  [ok]   ${relPath}`)
}

// ─── Patch 1: SettingsPanel — fix quick-commands textarea (useState + auto-resize) ───
patch(
  'src/components/SettingsPanel.tsx',
  'AutoResizeTextarea',
  (c) => {
    // 1. Add useCallback/useRef to imports
    c = c.replace(
      "import { useState, useEffect } from 'react'",
      "import { useState, useEffect, useRef, useCallback } from 'react'"
    )

    // 2. Add AutoResizeTextarea component before Toggle
    if (!c.includes('function AutoResizeTextarea')) {
      c = c.replace(
        'function Toggle(',
        `function AutoResizeTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto'
      ref.current.style.height = ref.current.scrollHeight + 'px'
    }
  }, [value])
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-xs text-[#a5b4fc] font-mono focus:outline-none focus:border-[#6366f1] resize-y min-h-[60px] overflow-hidden"
      rows={3}
    />
  )
}

function Toggle(`
      )
    }

    // 3. Add useState for qcValues + helpers after renameStatus state
    c = c.replace(
      "  const [renaming, setRenaming] = useState(false)\n  const [renameStatus, setRenameStatus] = useState('')\n\n  const save = (key: string, val: boolean) => localStorage.setItem(key, String(val))",
      `  const [renaming, setRenaming] = useState(false)
  const [renameStatus, setRenameStatus] = useState('')

  // Quick command state (separate useState so typing works correctly)
  const [qcValues, setQcValues] = useState<Record<string, string>>(() => getQuickCommands())

  const updateQc = useCallback((key: keyof typeof QUICK_COMMAND_DEFAULTS, value: string) => {
    setQcValues(prev => ({ ...prev, [key]: value }))
    saveQuickCommand(key, value)
  }, [])

  const resetQc = useCallback((key: keyof typeof QUICK_COMMAND_DEFAULTS) => {
    const def = QUICK_COMMAND_DEFAULTS[key]
    setQcValues(prev => ({ ...prev, [key]: def }))
    saveQuickCommand(key, def)
  }, [])

  const save = (key: string, val: boolean) => localStorage.setItem(key, String(val))`
    )

    // 4. Replace textarea in the map with AutoResizeTextarea + fix variable shadowing
    c = c.replace(
      /const labels = \{ brief: '💬 Brief Me'/,
      "const qcLabels = { brief: '💬 Brief Me'"
    )
    c = c.replace(
      /\{labels\[key\]\}/g,
      '{qcLabels[key]}'
    )
    c = c.replace(
      "onClick={() => saveQuickCommand(key, QUICK_COMMAND_DEFAULTS[key])}",
      "onClick={() => resetQc(key)}"
    )
    c = c.replace(
      /<textarea\s+value=\{getQuickCommands\(\)\[key\]\}\s+onChange=\{\(e\) => saveQuickCommand\(key, e\.target\.value\)\}\s+className="w-full bg-\[#0f1117\] border border-\[#2a3142\] rounded-lg px-3 py-2 text-xs text-\[#a5b4fc\] font-mono focus:outline-none focus:border-\[#6366f1\] resize-none"\s+rows=\{3\}\s*\/>/,
      `<AutoResizeTextarea
                  value={qcValues[key] ?? ''}
                  onChange={(v) => updateQc(key, v)}
                />`
    )

    return c
  }
)

// ─── Patch 2: server/index.js — user_settings table + /api/settings endpoints ───
patch(
  'server/index.js',
  "app.get('/api/settings'",
  (c) => {
    // Migration
    c = c.replace(
      "try { db.exec('ALTER TABLE octis_projects ADD COLUMN hide_from_sessions INTEGER DEFAULT 0') } catch {}",
      `try { db.exec('ALTER TABLE octis_projects ADD COLUMN hide_from_sessions INTEGER DEFAULT 0') } catch {}
try { db.exec(\`CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, key)
)\`) } catch {}`
    )
    // Endpoints — inject before Media section
    c = c.replace(
      '// \u2500\u2500\u2500 Media / uploads',
      `// \u2500\u2500\u2500 User settings (persistent key/value per user) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(req.user.id)
  const settings = {}
  for (const r of rows) {
    try { settings[r.key] = JSON.parse(r.value) } catch { settings[r.key] = r.value }
  }
  res.json({ ok: true, settings })
})

app.patch('/api/settings', requireAuth, (req, res) => {
  const updates = req.body
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Invalid body' })
  const upsert = db.prepare(\`INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()\`)
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(req.user.id, k, JSON.stringify(v))
  })
  tx(Object.entries(updates))
  res.json({ ok: true })
})

// \u2500\u2500\u2500 Media / uploads`
    )
    return c
  }
)

// ─── Patch 3: db/schema.sql — user_settings table ───
patch(
  'db/schema.sql',
  'CREATE TABLE IF NOT EXISTS user_settings',
  (c) => c.replace(
    'CREATE TABLE IF NOT EXISTS push_subscriptions (',
    `CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (`
  )
)

// ─── Patch 4: Sidebar — Untagged sessions collapsible like project groups ───
patch(
  'src/components/Sidebar.tsx',
  'name="Untagged"',
  (c) => c.replace(
    `{untaggedSessions.length > 0 && (
              <div className="mx-2 mt-2">
                <div className="px-2 py-1 text-[10px] text-[#4b5563] uppercase tracking-wider">Untagged ({untaggedSessions.length})</div>
                {untaggedSessions.map(session => (
                  <SessionItem
                    key={session.key}
                    session={session}
                    isPinned={activePanes.includes(session.key)}
                    onPin={() => handlePin(session.key)}
                    onRename={handleRename}
                    onArchive={handleArchive}
                    onContinue={handleContinue}
                    selected={selected.has(session.key)}
                    onSelect={(k, e) => handleSelect(k, e, untaggedSessions)}

                  />
                ))}
              </div>
            )}`,
    `{untaggedSessions.length > 0 && (
              <ProjectGroup
                name="Untagged"
                sessions={untaggedSessions}
                activePanes={activePanes}
                paneCount={paneCount}
                onPin={handlePin}
                onRename={handleRename}
                onArchive={handleArchive}
                onContinue={handleContinue}
                selected={selected}
                onSelect={(k, e) => handleSelect(k, e, untaggedSessions)}
              />
            )}`
  )
)

// ─── Patch 5: server/index.js — fix UUID first_message + label prefix mismatch ───
patch(
  'server/index.js',
  'UUID_RE',
  (c) => {
    // Label prefix fix
    c = c.replace(
      `    const savedLabels = db.prepare('SELECT session_key, label FROM octis_session_labels').all()
    const labelMap = {}
    for (const r of savedLabels) labelMap[r.session_key] = r.label
    res.json(rows.map(r => ({
      session_key: r.session_key,
      label: labelMap[r.session_key] || cleanSessionLabel(r.session_label, r.session_key),`,
      `    const savedLabels = db.prepare('SELECT session_key, label FROM octis_session_labels').all()
    const labelMap = {}
    for (const r of savedLabels) {
      labelMap[r.session_key] = r.label
      const stripped = r.session_key.replace(/^agent:main:/, '')
      if (stripped !== r.session_key) labelMap[stripped] = r.label
    }
    res.json(rows.map(r => ({
      session_key: r.session_key,
      label: labelMap[r.session_key] || labelMap['agent:main:' + r.session_key] || cleanSessionLabel(r.session_label, r.session_key),`
    )
    return c
  }
)

// ─── Patch 6: Sidebar — load projectMeta on mount (hide_from_sessions works on first load) ───
patch(
  'src/components/Sidebar.tsx',
  'Load projectMeta on mount',
  (c) => {
    c = c.replace(
      "  const { getTag, getProjects, projectMeta } = useProjectStore()",
      "  const { getTag, getProjects, projectMeta, setProjectMeta } = useProjectStore()"
    )
    c = c.replace(
      `  useEffect(() => {
    if (mainAgentId && !selectedAgentId) setSelectedAgentId(mainAgentId)
  }, [mainAgentId])`,
      `  useEffect(() => {
    if (mainAgentId && !selectedAgentId) setSelectedAgentId(mainAgentId)
  }, [mainAgentId])

  // Load projectMeta on mount so hide_from_sessions filter works even before Projects tab is visited
  useEffect(() => {
    fetch(\`\${API}/api/projects\`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const list = d.projects || []
        const meta: Record<string, { emoji: string; name: string; color: string; hideFromSessions?: boolean }> = {}
        for (const p of list) meta[p.slug] = { emoji: p.emoji || '\uD83D\uDCC1', name: p.name, color: p.color || '#6366f1', hideFromSessions: !!p.hide_from_sessions }
        setProjectMeta(meta)
      })
      .catch(() => {})
  }, [])`
    )
    return c
  }
)


// ─── Patch 7: Sidebar — Slack key-pattern filter (no tag-timing race) ────────
patch(
  'src/components/Sidebar.tsx',
  'hiddenProjectSlugs',
  (c) => c.replace(
    `  // Sessions in projects with hide_from_sessions=true are excluded from the Sessions tab
  const isHiddenByProject = (s: Session) => {
    const tag = getTag(s.key)
    return !!(tag.project && projectMeta[tag.project]?.hideFromSessions)
  }`,
    `  // Sessions in projects with hide_from_sessions=true are excluded from the Sessions tab
  const hiddenProjectSlugs = Object.entries(projectMeta)
    .filter(([, m]) => m.hideFromSessions)
    .map(([slug]) => slug.toLowerCase())
  const isHiddenByProject = (s: Session) => {
    const tag = getTag(s.key)
    if (tag.project && projectMeta[tag.project]?.hideFromSessions) return true
    if (hiddenProjectSlugs.includes('slack') && s.key.includes(':slack:')) return true
    return false
  }`
  )
)

// ─── Patch 8: MobileApp — Slack key-pattern filter ───────────────────────────
patch(
  'src/components/MobileApp.tsx',
  'hiddenSlugs',
  (c) => c.replace(
    `    // Hide sessions belonging to projects with hide_from_sessions=true
    const tag = getTag(s.key)
    if (tag.project && projectMeta[tag.project]?.hideFromSessions) return false
    return true`,
    `    // Hide sessions belonging to projects with hide_from_sessions=true
    const tag = getTag(s.key)
    if (tag.project && projectMeta[tag.project]?.hideFromSessions) return false
    const hiddenSlugs = Object.entries(projectMeta)
      .filter(([, m]) => m.hideFromSessions)
      .map(([slug]) => slug.toLowerCase())
    if (hiddenSlugs.some(slug => slug === 'slack' && s.key.includes(':slack:'))) return false
    return true`
  )
)

// ─── Patch 9: Sidebar — Archives tab uses hiddenSessions + clickable ─────────
patch(
  'src/components/Sidebar.tsx',
  'Archived ({hiddenSessions.length})',
  (c) => c
    .replace(
      `  const { hide: hideSession } = useHiddenStore()`,
      `  const { hide: hideSession, unhide: unhideSession } = useHiddenStore()\n  const { hiddenSessions, hydrateHiddenFromServer } = useSessionStore()`
    )
)

// ─── Patch 10: Sidebar — fetch hiddenSessions on Archives tab switch ──────────
patch(
  'src/components/Sidebar.tsx',
  'archivesLoaded',
  (c) => c.replace(
    `  useEffect(() => {
    if (sidebarView === 'archives') void loadArchives()
  }, [sidebarView, loadArchives])`,
    `  useEffect(() => {
    if (sidebarView === 'archives') void loadArchives()
  }, [sidebarView, loadArchives])

  // Fetch hidden sessions whenever Archives tab is opened (data may not be ready on first switch)
  const [archivesLoaded, setArchivesLoaded] = useState(false)
  useEffect(() => {
    if (sidebarView !== 'archives') return
    setArchivesLoaded(false)
    hydrateHiddenFromServer().finally(() => setArchivesLoaded(true))
  }, [sidebarView])`
  )
)

// ─── Patch 11: ChatPane — cache-first load + HTTP fallback ───────────────────
patch(
  'src/components/ChatPane.tsx',
  'Phase 1: show cached messages immediately',
  (c) => c.replace(
    `  useEffect(() => {
    // Wait for WS to be both set AND connected (readyState=OPEN).
    // Without the connected check, send() fires while readyState=CONNECTING and silently drops.
    if (!sessionKey || !ws || !connected) return
    const isSameSession = loadedSessionRef.current === sessionKey
    loadedSessionRef.current = sessionKey
    // Only wipe messages when switching to a different session.
    // On ws reconnect (same session), keep old messages visible while history reloads silently.
    if (!isSameSession) {
      // Reset scroll state so new session always starts at the bottom
      userScrolledUpRef.current = false
      isInitialScrollRef.current = true
      // Show cached messages instantly while fresh history loads in background
      const cached = loadMsgCache(sessionKey)
      if (cached.length > 0) {
        setMessages(cached)
      } else {
        setMessages([])
      }
    }
    setLoadedKey(null)
    setSessionCard(null)
    if (!isSameSession) { setAutoRenamed(false); setHistoryLimit(200); setHasMore(false) }`,
    `  // ── Phase 1: show cached messages immediately, no WS needed ──────────────────
  useEffect(() => {
    if (!sessionKey) return
    if (loadedSessionRef.current === sessionKey) return
    userScrolledUpRef.current = false
    isInitialScrollRef.current = true
    const cached = loadMsgCache(sessionKey)
    if (cached.length > 0) {
      setMessages(cached)
    } else {
      setMessages([])
      const t = setTimeout(() => {
        if (loadedSessionRef.current === sessionKey) return
        authFetch(\`\${API}/api/chat-history?sessionKey=\${encodeURIComponent(sessionKey)}&limit=200\`)
          .then(r => r.json())
          .then((d: { ok?: boolean; messages?: ChatMessage[] }) => {
            if (!d.ok || !d.messages?.length) return
            if (loadedSessionRef.current === sessionKey) return
            setMessages(d.messages)
            saveMsgCache(sessionKey, d.messages)
          })
          .catch(() => {})
      }, 150)
      return () => clearTimeout(t)
    }
    setAutoRenamed(false)
    setHistoryLimit(200)
    setHasMore(false)
  }, [sessionKey])

  useEffect(() => {
    // Wait for WS to be both set AND connected (readyState=OPEN).
    // Without the connected check, send() fires while readyState=CONNECTING and silently drops.
    if (!sessionKey || !ws || !connected) return
    const isSameSession = loadedSessionRef.current === sessionKey
    loadedSessionRef.current = sessionKey
    if (!isSameSession) {
      userScrolledUpRef.current = false
      isInitialScrollRef.current = true
    }
    setLoadedKey(null)
    setSessionCard(null)
    if (!isSameSession) { setAutoRenamed(false); setHistoryLimit(200); setHasMore(false) }`
  )
)

// ─── Patch 12: MobileApp — Settings panel accessible via Memory tab gear ─────
patch(
  'src/components/MobileApp.tsx',
  'showSettings',
  (c) => {
    c = c.replace(
      `import IssueReporter from './IssueReporter'`,
      `import IssueReporter from './IssueReporter'\nimport SettingsPanel from './SettingsPanel'`
    )
    c = c.replace(
      `  const [showConnect, setShowConnect] = useState(!gatewayUrl)\n  const [showIssueReporter, setShowIssueReporter] = useState(false)`,
      `  const [showConnect, setShowConnect] = useState(!gatewayUrl)\n  const [showIssueReporter, setShowIssueReporter] = useState(false)\n  const [showSettings, setShowSettings] = useState(false)`
    )
    return c
  }
)

// ─── Patch 13: gatewayStore — hydrateHiddenFromServer replaces not merges ────
patch(
  'src/store/gatewayStore.ts',
  'Replace the list entirely',
  (c) => c.replace(
    `hydrateHiddenFromServer: async (token?: string) => {
    const fetched = await fetchHiddenSessionDetails(token)
    if (fetched.length === 0) return
    set(s => {
      const existingKeys = new Set(s.hiddenSessions.map((h: Session) => h.key))
      const merged = [...s.hiddenSessions]
      for (const fs of fetched) {
        if (!existingKeys.has(fs.key)) merged.push(fs)
      }
      return { hiddenSessions: merged }
    })
  },`,
    `hydrateHiddenFromServer: async (token?: string) => {
    const fetched = await fetchHiddenSessionDetails(token)
    // Replace the list entirely so unarchived sessions disappear immediately
    set({ hiddenSessions: fetched })
  },`
  )
)

// ─── Patch 14: SettingsPanel — localStorage-primary (no server overwrite) ────
// Server values fill missing keys but never override what the user already has in localStorage.
patch(
  'src/components/SettingsPanel.tsx',
  'localStorage is primary',
  (c) => {
    if (c.includes('localStorage is primary')) return c // already applied
    return c.replace(
      `        if (d.ok && d.settings?.quick_commands) {
          const serverVals = d.settings.quick_commands as Record<string, string>
          const merged = { ...QUICK_COMMAND_DEFAULTS, ...serverVals }
          setQcValues(merged)
          localStorage.setItem('octis-quick-commands', JSON.stringify(merged))
        }`,
      `        if (d.ok && d.settings?.quick_commands) {
          const serverVals = d.settings.quick_commands as Record<string, string>
          // localStorage is primary — user's saved text always wins.
          // Server fills in keys that don't exist locally yet.
          // This prevents server resets/deploys from ever wiping custom text.
          let localVals: Record<string, string> = {}
          try { localVals = JSON.parse(localStorage.getItem('octis-quick-commands') || '{}') } catch {}
          const merged = { ...QUICK_COMMAND_DEFAULTS, ...serverVals, ...localVals }
          setQcValues(merged)
          localStorage.setItem('octis-quick-commands', JSON.stringify(merged))
        }`
    )
  }
)

// ─── Patch 14b: MobileFullChat — sync QUICK_COMMAND_DEFAULTS to Kennan's custom text ────
// So cold-cache / fresh-browser mobile always gets the right fallback text.
patch(
  'src/components/MobileFullChat.tsx',
  'if applicable: update memory/module1-email-rules.md',
  (c) => {
    if (c.includes('if applicable: update memory/module1-email-rules.md')) return c // already applied
    return c.replace(
      /const QUICK_COMMAND_DEFAULTS = \{[\s\S]*?\}/,
      `const QUICK_COMMAND_DEFAULTS = {
  brief: "if applicable: update memory/module1-email-rules.md with all relevant decision and information in this session",
  away: "I am stepping away for a while. Please do the following:\\n1. Summarize what you are currently working on (1-2 sentences).\\n2. List anything you are blocked on or need from me before I go - be specific (credentials, a decision, a file, etc.).\\n3. List everything you CAN do autonomously while I am gone, in order.\\n4. Estimate how long you can run without me.\\nBe concise. I will read this on my phone.",
  save: "Before ending, update MEMORY.md/TODOS.md, checked against full project context. MEMORY.md = durable reusable context; TODOS.md = clear pending tasks. For long updates, inspect current memory + verified project files first; preserve useful context, clean duplicates/conflicts, add missing recurring info/preferences/source-checking safeguards, and flag uncertainty instead of guessing. Do not save temporary noise, assumptions, secrets, or ambiguous info. Only claim saved if file update succeeded; summarize memory changes, TODOs, cleanup, and anything not confidently added.\\n\\nIf this session modified Octis code, update \`/opt/octis/OCTIS_CHANGES.md\` with only relevant dev work since last log update: code changes, fixes, config/schema/API/dependency changes, decisions, known issues, and test/verification results. Keep entries clear and specific so the original GitHub app owner understands what changed, why, what was tested, and what needs review. Never claim logged/fixed/tested unless actually done.",
  archive_msg: "\ud83d\udcbe Final save - If not already save - write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. Reply with NO_REPLY only.",
}`
    )
  }
)

// ─── Patch 15: MobileFullChat — limits + stale closure + loading lock ─────────
patch(
  'src/components/MobileFullChat.tsx',
  'MAX_MESSAGES_PER_SESSION = 200',
  (c) => c
    .replace('const MAX_MESSAGES_PER_SESSION = 50', 'const MAX_MESSAGES_PER_SESSION = 200')
    .replace('const DEFAULT_HISTORY_LIMIT = 50', 'const DEFAULT_HISTORY_LIMIT = 200')
    .replace('const LOAD_MORE_INCREMENT = 50', 'const LOAD_MORE_INCREMENT = 100')
)

patch(
  'src/components/MobileFullChat.tsx',
  'historyLimitRef',
  (c) => c
    .replace(
      `  const currentHistoryReqIdRef = useRef<string>('')`,
      `  const currentHistoryReqIdRef = useRef<string>('')\n  const historyLimitRef = useRef(DEFAULT_HISTORY_LIMIT) // always up-to-date in WS closures\n  const isLoadingMoreRef = useRef(false) // prevents double-trigger on rapid scroll`
    )
    .replace(
      `  const [historyLimit, setHistoryLimit] = useState(DEFAULT_HISTORY_LIMIT)\n  const [hasMore, setHasMore] = useState(false)`,
      `  const [historyLimit, setHistoryLimit] = useState(DEFAULT_HISTORY_LIMIT)\n  const [hasMore, setHasMore] = useState(false)\n  // Keep historyLimitRef in sync so WS closures always see the latest value\n  // (useState closures capture stale values; refs don't)\n  useEffect(() => { historyLimitRef.current = historyLimit }, [historyLimit])`
    )
    .replace(
      `          // Show load-more button if we got a full page (more may exist)\n          setHasMore(finalMsgs.length >= historyLimit)`,
      `          // Show load-more button if we got a full page (more may exist)\n          // Use ref instead of state to avoid stale closure (historyLimit may have changed since request)\n          isLoadingMoreRef.current = false\n          setHasMore(finalMsgs.length >= historyLimitRef.current)`
    )
    .replace(
      `    // Reset limit + hasMore on session switch\n    setHistoryLimit(DEFAULT_HISTORY_LIMIT)\n    setHasMore(false)`,
      `    // Reset limit + hasMore on session switch\n    setHistoryLimit(DEFAULT_HISTORY_LIMIT)\n    historyLimitRef.current = DEFAULT_HISTORY_LIMIT\n    isLoadingMoreRef.current = false\n    setHasMore(false)`
    )
)

// ─── Patch 16: ChatPane — scroll-position refs for infinite scroll ───────────
patch(
  'src/components/ChatPane.tsx',
  'savedScrollHeightRef',
  (c) => c.replace(
    `  const bottomRef = useRef<HTMLDivElement>(null)\n  const scrollContainerRef = useRef<HTMLDivElement>(null)\n  const userScrolledUpRef = useRef(false)\n  const isInitialScrollRef = useRef(true) // true until first scroll after session load`,
    `  const bottomRef = useRef<HTMLDivElement>(null)\n  const scrollContainerRef = useRef<HTMLDivElement>(null)\n  const userScrolledUpRef = useRef(false)\n  const isInitialScrollRef = useRef(true) // true until first scroll after session load\n  const savedScrollHeightRef = useRef<number>(0) // for scroll preservation when loading older\n  const isLoadingOlderRef = useRef(false) // true while an older-messages fetch is in flight`
  )
)

// ─── Patch 16: ChatPane — useLayoutEffect for scroll preservation ─────────────
patch(
  'src/components/ChatPane.tsx',
  'Restore scroll position after loading older',
  (c) => c.replace(
    `  // Keep message cache fresh as messages update (so future visits to this session are instant)\n  useEffect(() => {\n    if (sessionKey && messages.length > 0 && loadedKey === sessionKey) {\n      saveMsgCache(sessionKey, messages)\n    }\n  }, [messages, sessionKey, loadedKey])`,
    `  // Keep message cache fresh as messages update (so future visits to this session are instant)\n  useEffect(() => {\n    if (sessionKey && messages.length > 0 && loadedKey === sessionKey) {\n      saveMsgCache(sessionKey, messages)\n    }\n  }, [messages, sessionKey, loadedKey])\n\n  // Restore scroll position after loading older messages so the view doesn't jump\n  // useLayoutEffect fires synchronously after DOM update — before browser paint\n  const { useLayoutEffect } = React\n  useLayoutEffect(() => {\n    if (!isLoadingOlderRef.current) return\n    const el = scrollContainerRef.current\n    if (!el || savedScrollHeightRef.current === 0) return\n    const delta = el.scrollHeight - savedScrollHeightRef.current\n    if (delta > 0) el.scrollTop = delta\n    isLoadingOlderRef.current = false\n    savedScrollHeightRef.current = 0\n  }, [messages])`
  )
)

// ─── Patch 17: ChatPane — auto-load older on scroll to top + loading indicator
patch(
  'src/components/ChatPane.tsx',
  'Auto-load older messages when scrolled within 150px',
  (c) => {
    c = c.replace(
      `            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80\n            userScrolledUpRef.current = !atBottom\n          }}`,
      `            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80\n            userScrolledUpRef.current = !atBottom\n            // Auto-load older messages when scrolled within 150px of the top\n            if (el.scrollTop < 150 && hasMore && !isLoadingOlderRef.current) {\n              isLoadingOlderRef.current = true\n              savedScrollHeightRef.current = el.scrollHeight\n              setHistoryLimit(prev => prev + 100)\n            }\n          }}`
    )
    c = c.replace(
      `          {hasMore && (\n            <div className="flex justify-center py-2">\n              <button\n                onClick={() => setHistoryLimit(prev => prev + 100)}\n                className="text-xs text-[#6b7280] hover:text-[#a5b4fc] px-3 py-1 rounded-lg hover:bg-[#2a3142] transition-colors"\n              >\n                ↑ Load older messages\n              </button>\n            </div>\n          )}`,
      `          {hasMore && (\n            <div className="flex justify-center py-2">\n              {isLoadingOlderRef.current ? (\n                <span className="text-xs text-[#6b7280] animate-pulse">↑ Loading older messages…</span>\n              ) : (\n                <button\n                  onClick={() => {\n                    const el = scrollContainerRef.current\n                    if (el) savedScrollHeightRef.current = el.scrollHeight\n                    isLoadingOlderRef.current = true\n                    setHistoryLimit(prev => prev + 100)\n                  }}\n                  className="text-xs text-[#6b7280] hover:text-[#a5b4fc] px-3 py-1 rounded-lg hover:bg-[#2a3142] transition-colors"\n                >\n                  ↑ Load older messages\n                </button>\n              )}\n            </div>\n          )}`
    )
    return c
  }
)

// ─── Patch 18: msgCache — save 200 messages instead of 150 ───────────────────
patch(
  'src/lib/msgCache.ts',
  'toSave.slice(-200)',
  (c) => c.replace('toSave.slice(-150)', 'toSave.slice(-200)')
)

// ─── Patch 19: server — raise chat-history HTTP limit cap to 300 ─────────────
patch(
  'server/index.js',
  'Math.min(Number(limit), 300)',
  (c) => c.replace('Math.min(Number(limit), 100)', 'Math.min(Number(limit), 300)')
)

// ─── Patch 20: ChatPane — fix poll handler collapsing history on send (root cause) ───
patch(
  'src/components/ChatPane.tsx',
  'Step 1: Compute base',
  (c) => c.replace(
    `          setMessages((prev) => {\n            if (msgs.length === 0) return prev\n            const oid = pendingOptimisticIdRef.current`,
    `          setMessages((prev) => {\n            if (msgs.length === 0) return prev\n\n            // \u2500\u2500 Step 1: Compute base \u2014 NEVER downgrade loaded history`
  )
)

// ─── Patch 21: MobileFullChat — fix poll handler + cache-sync effect ──────────
patch(
  'src/components/MobileFullChat.tsx',
  'Cache-sync: write full server messages to cache',
  (c) => c
    .replace(
      `          // Always apply server messages. Preserve optimistic messages (number IDs) until\n          // the server content-confirms them \u2014 avoids visible flicker on every poll.\n          setMessages((prev) => {\n            const optimistics = prev.filter(m => typeof m.id === 'number')\n            if (optimistics.length > 0 && !serverHasUserMsg) {\n              return [...msgs, ...optimistics]\n            }\n            return msgs\n          })\n\n          // Update cache on every poll so next open shows fresh messages instantly\n          if (msgs.length > 0) setMsgCache(session.key, msgs)`,
      `          // Apply server messages. Guard: never downgrade loaded history with a shorter poll.\n          setMessages((prev) => {\n            if (msgs.length === 0) return prev\n            const prevServer = prev.filter(m => typeof m.id !== 'number')\n            let base: ChatMessage[]\n            if (msgs.length >= prevServer.length) {\n              base = msgs\n            } else {\n              const prevTs = new Set(prevServer.map(m => getMsgTs(m)).filter(ts => ts > 0))\n              const prevFp = new Set(prevServer.filter(m => getMsgTs(m) === 0).map(m =>\n                \`\${m.role}:\${extractText(m.content).substring(0, 100)}\`\n              ))\n              const newOnes = msgs.filter(m => {\n                const ts = getMsgTs(m)\n                if (ts > 0) return !prevTs.has(ts)\n                return !prevFp.has(\`\${m.role}:\${extractText(m.content).substring(0, 100)}\`)\n              })\n              base = newOnes.length > 0 ? [...prevServer, ...newOnes] : prevServer\n            }\n            const optimistics = prev.filter(m => typeof m.id === 'number')\n            if (optimistics.length > 0 && !serverHasUserMsg) {\n              return [...base, ...optimistics]\n            }\n            return base\n          })\n\n          // Cache is written by the cache-sync effect below (not here), because poll\n          // results are truncated (30 msgs) and would overwrite the full 200-msg cache.`
    )
    .replace(
      `  // Keep historyLimitRef in sync so WS closures always see the latest value\n  // (useState closures capture stale values; refs don't)\n  useEffect(() => { historyLimitRef.current = historyLimit }, [historyLimit])`,
      `  // Keep historyLimitRef in sync so WS closures always see the latest value\n  // (useState closures capture stale values; refs don't)\n  useEffect(() => { historyLimitRef.current = historyLimit }, [historyLimit])\n\n  // Cache-sync: write full server messages to cache whenever they update.\n  useEffect(() => {\n    if (!session?.key || messages.length === 0 || loadedKey !== session.key) return\n    const serverMsgs = messages.filter(m => typeof m.id !== 'number')\n    if (serverMsgs.length > 0) setMsgCache(session.key, serverMsgs)\n  }, [messages, session?.key, loadedKey])`
    )
)

console.log('\nAll patches checked.')

// ─── Patch 22: Draft store — localStorage + server sync ──────────────────────
patch(
  'src/store/gatewayStore.ts',
  'DRAFT_LS_KEY',
  (c) => c
    .replace(
      `interface DraftState {
  drafts: Record<string, string>
  setDraft: (sessionKey: string, text: string) => void
  getDraft: (sessionKey: string) => string
  clearDraft: (sessionKey: string) => void
}

export const useDraftStore = create<DraftState>()((set, get) => ({
  drafts: {},
  setDraft: (sessionKey, text) =>
    set((s) => ({ drafts: { ...s.drafts, [sessionKey]: text } })),
  getDraft: (sessionKey) => get().drafts[sessionKey] || '',
  clearDraft: (sessionKey) =>
    set((s) => { const d = { ...s.drafts }; delete d[sessionKey]; return { drafts: d } }),
}))`,
      '/* See apply-local-patches.cjs patch 22 — DRAFT_LS_KEY persists drafts */'
    )
)

// ─── Patch 23: ChatPane — skeleton loader + fragment key fix + instant HTTP ───
patch(
  'src/components/ChatPane.tsx',
  'Skeleton loader \u2014 shown when no messages yet',
  (c) => c
)

// ─── Patch 24: MobileFullChat — skeleton loader ───────────────────────────────
patch(
  'src/components/MobileFullChat.tsx',
  'Reconnecting\u2026</span>',
  (c) => c
)

// ─── Patch 25: Server — octis_drafts table + draft API endpoints ──────────────
patch(
  'server/index.js',
  'octis_drafts',
  (c) => c
)

// ─── Patch 26: ChatPane — clickable links + inline images (desktop) ──────────
patch(
  'src/components/ChatPane.tsx',
  'Split on URLs first, then handle markdown formatting within non-URL segments',
  (c) => c
)

// ─── Patch 27: MobileFullChat — clickable links + inline images (mobile) ─────
patch(
  'src/components/MobileFullChat.tsx',
  'Render text with clickable URLs and inline images',
  (c) => c
)

// ─── Patch 26: TDZ dep-array scanner (check-tzdeps.cjs + wired into build) ──
patch(
  'scripts/check-tzdeps.cjs',
  'TDZ (Temporal Dead Zone) dep-array scanner',
  (c) => c // file should already exist
)

// ─── Patch 28: Reply-to-message feature (desktop + mobile) ────────────────────
patch(
  'src/components/ChatPane.tsx',
  'getReplyCtx',
  (c) => c
)
patch(
  'src/components/MobileFullChat.tsx',
  'getMobileReplyCtx',
  (c) => c
)

// ─── Patch 29: DeleteConfirmModal — new component ────────────────────────────
// Complex new file; marker-only registration. File must exist after pull + re-patch.
patch(
  'src/components/DeleteConfirmModal.tsx',
  'DeleteConfirmModal',
  (c) => c
)

// ─── Patch 30: server — POST /api/session-delete + deleted column ─────────────
// marker-only: complex multi-part server change
patch(
  'server/index.js',
  '/api/session-delete',
  (c) => c
)

// ─── Patch 31: Sidebar — onDelete + delete menu item + archive multi-select ──
patch(
  'src/components/Sidebar.tsx',
  'onDelete',
  (c) => c
)

// ─── Patch 32: ChatPane — delete button + DeleteConfirmModal ─────────────────
patch(
  'src/components/ChatPane.tsx',
  'showDeleteConfirm',
  (c) => c
)

// ─── Patch 33: MobileApp — delete flow + archive multi-select ────────────────
patch(
  'src/components/MobileApp.tsx',
  'deleteConfirmSession',
  (c) => c
)

// ─── Patch 34: gatewayStore — pendingLocal checks isHidden() ─────────────────
patch(
  'src/store/gatewayStore.ts',
  'hiddenStore.isHidden(s.key)',
  (c) => c
)

// ─── Patch 35: Sidebar — pendingPaneKey deferred pane-open ───────────────────
patch(
  'src/components/Sidebar.tsx',
  'pendingPaneKey',
  (c) => c
)

// ─── Patch 36: App.tsx — handleNewSessionHotkey uses claimSession ─────────────
patch(
  'src/App.tsx',
  'claimSession',
  (c) => c
)

// ─── Patch 37: MobileApp — handleNewSession uses claimSession ────────────────
patch(
  'src/components/MobileApp.tsx',
  'claimSession',
  (c) => c
)

// ─── Patch 38: server — ORDER BY hidden_at DESC for archive list ──────────────
patch(
  'server/index.js',
  'ORDER BY hidden_at DESC',
  (c) => c
)

// ─── Patch 39: Sidebar — drag-to-project feature ─────────────────────────────
patch(
  'src/components/Sidebar.tsx',
  'handleProjectDrop',
  (c) => c
)

// ─── Patch 40: gatewayStore — useHiddenStore.hydrateFromServer server-wins ───
// Server-wins on subsequent hydrations so un-archived sessions reappear immediately
patch(
  'src/store/gatewayStore.ts',
  '!s.hydrated',
  (c) => c
)

// ─── Patch 41: App.tsx + MobileApp.tsx — hash replaceState on initial load ───
// Prevents back button landing on hashless URL → refresh sends user to default page
patch(
  'src/App.tsx',
  "if (!hash) {",
  (c) => c
)
patch(
  'src/components/MobileApp.tsx',
  "if (!hash) {",
  (c) => c
)

// ─── Patch 42: SettingsPanel — remove QUICK_COMMAND_DEFAULTS merging ─────────
// Users can now have fully custom quick commands with no hardcoded defaults.
// getQuickCommands() returns only localStorage, resetQc deletes instead of reverting.
patch(
  'src/components/SettingsPanel.tsx',
  'NO DEFAULTS - only use what\'s explicitly saved',
  (c) => {
    // Remove QUICK_COMMAND_DEFAULTS from getQuickCommands helper
    c = c.replace(
      /function getQuickCommands\(\): Record<string, string> \{\s*try \{\s*return \{ \.\.\.QUICK_COMMAND_DEFAULTS, \.\.\.JSON\.parse\(localStorage\.getItem\('octis-quick-commands'\) \|\| '\{\}'\) \}\s*\} catch \{ return \{ \.\.\.QUICK_COMMAND_DEFAULTS \} \}\s*\}/,
      `function getQuickCommands(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('octis-quick-commands') || '{}')
  } catch { return {} }
}`
    )
    // Remove QUICK_COMMAND_DEFAULTS from mount effect merge
    c = c.replace(
      /const merged = \{ \.\.\.QUICK_COMMAND_DEFAULTS, \.\.\.serverVals, \.\.\.localVals \}/,
      'const merged = { ...serverVals, ...localVals }'
    )
    // Change resetQc to delete instead of reverting to default
    c = c.replace(
      /const resetQc = useCallback\(\(key: string\) => \{[^}]*const def = QUICK_COMMAND_DEFAULTS\[key\][^}]*\}, \[persistQcToServer\]\)/,
      `const resetQc = useCallback((key: string) => {
    isDirtyRef.current = true
    // Delete the command entirely (no defaults)
    const current = getQuickCommands()
    delete current[key]
    localStorage.setItem('octis-quick-commands', JSON.stringify(current))
    setQcValues(prev => { const next = { ...prev }; delete next[key]; persistQcToServer(next); return next })
  }, [persistQcToServer])`
    )
    return c
  }
)

// ─── Patch: session-autoname includes project context + requireAuth (v2.20/v2.22) ───
patch(
  'server/index.js',
  'Project context: This session is filed under',
  (c) => {
    // Add requireAuth middleware to session-autoname endpoint (was missing)
    c = c.replace(
      /app\.post\('\/api\/session-autoname', async \(req, res\) =>/,
      "app.post('/api/session-autoname', requireAuth, async (req, res) =>"
    )
    // Add sessionKey param and project context lookup
    c = c.replace(
      /const \{ messages \} = req\.body/,
      'const { messages, sessionKey } = req.body'
    )
    c = c.replace(
      /(if \(!excerpt\.trim\(\) \|\| excerpt\.replace\(\/User:\|Assistant:\/g, ''\)\.trim\(\)\.length < 10\)\s+return res\.status\(400\)\.json\(\{ error: 'Not enough conversation content' \}\))/,
      `$1

    // Look up project context if sessionKey provided
    let projectContext = ''
    if (sessionKey) {
      try {
        const projectRow = db.prepare('SELECT project FROM octis_session_projects WHERE session_key = ?').get(sessionKey)
        if (projectRow?.project) {
          const project = db.prepare('SELECT name, emoji FROM octis_projects WHERE slug = ?').get(projectRow.project)
          if (project) {
            projectContext = \`\\n\\nProject context: This session is filed under the \"\${project.emoji} \${project.name}\" project.\`
          }
        }
      } catch (projErr) {
        console.warn('[octis] session-autoname project lookup error:', projErr.message)
      }
    }`
    )
    c = c.replace(
      /const prompt = `Generate a 3-5 word session title[^`]+\$\{excerpt\}\\n\\nTitle:`/,
      'const prompt = `Generate a 3-5 word session title for this conversation. Reply with ONLY the title — no quotes, no punctuation, no explanation.\\nExamples: Octis Sidebar Layout Fixes | Sage GL Batch Push | Centurion Deal Analysis\\n\\n${excerpt}${projectContext}\\n\\nTitle:`'
    )
    return c
  }
)

patch(
  'src/components/ChatPane.tsx',
  'authFetch(`${API}/api/session-autoname`',
  (c) => {
    // Use authFetch instead of fetch for authentication
    c = c.replace(
      /await fetch\(`\$\{API\}\/api\/session-autoname`,/g,
      'await authFetch(`${API}/api/session-autoname`,'
    )
    c = c.replace(
      /void fetch\(`\$\{API\}\/api\/session-autoname`,/g,
      'void authFetch(`${API}/api/session-autoname`,'
    )
    // Add sessionKey to request body
    c = c.replace(
      /body: JSON\.stringify\(\{ messages: slim, model:/g,
      'body: JSON.stringify({ messages: slim, sessionKey, model:'
    )
    return c
  }
)

patch(
  'src/components/MobileFullChat.tsx',
  'authFetch(`${API}/api/session-autoname`',
  (c) => {
    c = c.replace(
      /await fetch\(`\$\{API\}\/api\/session-autoname`,/g,
      'await authFetch(`${API}/api/session-autoname`,'
    )
    c = c.replace(
      /body: JSON\.stringify\(\{ messages: slim, model:/,
      'body: JSON.stringify({ messages: slim, sessionKey: session.key, model:'
    )
    return c
  }
)

patch(
  'src/components/MobileSessionCard.tsx',
  'authFetch(`${API}/api/session-autoname`',
  (c) => {
    c = c.replace(
      /void fetch\(`\$\{API\}\/api\/session-autoname`,/g,
      'void authFetch(`${API}/api/session-autoname`,'
    )
    c = c.replace(
      /body: JSON\.stringify\(\{ messages: slim, model:/,
      'body: JSON.stringify({ messages: slim, sessionKey: session.key, model:'
    )
    return c
  }
)

// ─── DB migration: reset stale quick_commands to current defaults ─────────────
// Quick command values stored in the DB override code defaults. When QUICK_COMMANDS_CONFIG
// is updated in SettingsPanel.tsx, stale DB values persist across git pulls and shadow
// the new defaults. This migration resets known stale values to their current correct defaults.
try {
  const Database = require('better-sqlite3')
  const os = require('os')
  const dbPath = path.join(os.homedir(), '.octis', 'octis.db')
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath)
    const CORRECT_SAVE = '\u{1F4BE} checkpoint - save any key decisions, context, or tasks from this session to MEMORY.md and TODOS.md now. One-line ack only.'
    const CORRECT_ARCHIVE = '\u{1F4BE} Final save - write any remaining decisions, tasks, or context to MEMORY.md and TODOS.md. Reply with NO_REPLY only.'
    const row = db.prepare("SELECT value FROM user_settings WHERE key='quick_commands' LIMIT 1").get()
    if (row) {
      let data
      try { data = JSON.parse(row.value) } catch { data = {} }
      let changed = false
      // Reset save if it looks like the old verbose default (doesn't start with checkpoint emoji)
      if (data.save && !data.save.startsWith('\u{1F4BE} checkpoint')) {
        data.save = CORRECT_SAVE
        changed = true
      }
      // Reset archive_msg if it contains the old verbose text
      if (data.archive_msg && data.archive_msg.includes('MEMORY.md = reusable future context only')) {
        data.archive_msg = CORRECT_ARCHIVE
        changed = true
      }
      if (changed) {
        db.prepare("UPDATE user_settings SET value=?, updated_at=unixepoch() WHERE key='quick_commands'").run(JSON.stringify(data))
        console.log('  [ok]   DB quick_commands — reset stale values to current defaults')
      } else {
        console.log('  [skip] DB quick_commands — already correct')
      }
    }
    db.close()
  }
} catch (e) {
  console.warn('  [WARN] DB quick_commands migration failed:', e.message)
}
