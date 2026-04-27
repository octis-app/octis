# Octis Changelog

> All notable changes since the initial commit (2026-04-03).
> Entries marked **[local]** are Casken-specific patches applied on top of upstream via `scripts/apply-local-patches.cjs` and are not in the upstream git history.

---

## [Current] — 2026-04-27 (Local patches on top of f42ceb3)

### Added
- **[local] Reply-to-message** — Desktop (hover `↩︎` button) and mobile (always-visible tap target). Shows quote bubble above message, preview bar above textarea, Escape to cancel. Click quote jumps to original message with flash highlight. Format: `[Replying to AI: "preview"]` prepended to message.
- **[local] Delete sessions (permanent)** — Distinct from Archive. Deleted sessions are flagged in `octis_hidden_sessions` with `deleted=1` and permanently hidden from all WS broadcasts. `POST /api/session-delete` endpoint. `DeleteConfirmModal` component (shared desktop + mobile).
- **[local] Archive multi-select** — Select-all checkbox, per-row checkboxes, bulk ↩ Restore / 🗑️ Delete action bar in Archives sidebar tab.
- **[local] Drag-to-project** — Drag any session from the sidebar onto a project group to re-tag it. Visual drop-zone highlight (purple ring + animated "drop here" label). Dropping on Untagged clears the project tag.
- **[local] Archive sort** — Most-recently-archived sessions shown first (`ORDER BY hidden_at DESC` on `/api/hidden-session-details`).
- **[local] Word-style undo** in chat textarea (desktop + mobile).
- **[local] Draft image persistence** — Attached images survive draft saves and restores.
- **[local] Draft tombstone** — `clearDraft` writes an empty `''` tombstone to localStorage instead of deleting, preventing WS-reconnect `hydrateFromServer` from reviving a just-sent draft while the server DELETE is still in-flight. Auto-removes after 10s.
- **[local] `openInBestPane` helper** — Expand-first pane logic: fills empty slot → expands pane count (up to 8) → replaces last. Used by all session-opening paths (sidebar, pin, New Session, continue, todo, `N` hotkey).
- **[local] Pin toggle** — Clicking a pinned session's pin icon closes the pane instead of doing nothing.
- **[local] Session creation reliability** — `pendingPaneKey` + `useEffect` pattern ensures the new session pane opens exactly once. All creation paths (`+ New Session`, Continue, Todo new session, `N` hotkey) use `claimSession` + fresh `getState().sessions` to avoid stale closure bugs.
- **[local] Deleted session ghost fix** — `pendingLocal` filter in `gatewayStore.ts` checks `hiddenStore.isHidden()` before re-injecting sessions, preventing deleted/archived sessions from reappearing on WS broadcast.
- **[local] Hash URL routing** — `activeNav`/tab persistence uses `replaceState` on first write, `pushState` on tab change. Prevents back-button bouncing to a hashless URL that would refresh to default page.
- **[local] `[ghosty:auto-rename-request]` heartbeat hook** — Ghosty reads full session history and renames the webchat session to a topic-based title when this system event fires.
- **[local] TDZ dep checker** (`scripts/check-tzdeps.cjs`) — Scans React hook dep arrays for TDZ violations. Wired into `npm run build` as a build gate — build fails on any TDZ hit.
- **[local] Quick command undo/redo** — Per-command undo/redo stack (hook-based) in SettingsPanel. `📝 Dev Log` quick command label.
- **[local] Session key migration** — When a session key migrates from short (`session-<ts>`) to full (`agent:main:session-<ts>`), `activePanes` is patched atomically in the same Zustand `set()` call. Prevents duplicate pane + lost highlight.
- **[local] `activePanes` deduplication** — `onRehydrateStorage` hook deduplicates pane list on localStorage reload.
- **[local] ProjectView toggle** — `openInNextPane` closes pane if already open, opens if not. Cursor always `pointer`.

### Fixed
- **[local] `hydrateFromServer` server-wins** — On subsequent hydrations (WS reconnect, tab focus), server state fully replaces localStorage instead of merging. Fixes stale localStorage preventing un-archived sessions from reappearing.
- **[local] `draftTimerRef` cancel on send** — Timer cancelled at top of send handler before `clearDraft`, preventing a race that could re-save a blank draft.

---

## [2026-04-27] — Chat Loading Overhaul + UX Patches (local)

### Added
- **[local] Chat skeleton loader** — Shows animated skeleton while initial history loads instead of blank pane.
- **[local] Instant HTTP fallback** — If no cached history exists, HTTP GET `/api/chat-history` fires after 150ms (was 800ms), fetching 200 messages (was 50). WS delivery replaces it seamlessly.
- **[local] Scroll preservation on load-more** — `savedScrollHeightRef` + `isLoadingOlderRef` + `useLayoutEffect` keep reading position stable when older messages load above the viewport.
- **[local] Auto-load near top** — `onScroll` at `scrollTop < 150` and a `hasMore` watcher effect both trigger older-message loading; no manual button needed.
- **[local] Mobile history limits raised** — `DEFAULT_HISTORY_LIMIT` 50→200, `MAX_MESSAGES_PER_SESSION` 50→200, `LOAD_MORE_INCREMENT` 50→100.
- **[local] `historyLimitRef`** — Never-stale ref alongside `historyLimit` state so WS closures always read current value.
- **[local] `isLoadingMoreRef` / `wasLoadingMoreRef`** — Prevent double-trigger and post-load scroll-jump on mobile.
- **[local] Cache-sync `useEffect`** — Saves full server message array after every update; never writes truncated poll results.

### Fixed
- **[local] Poll collapse bug** — Poll handler (`chat-poll-*`) was collapsing full loaded history (200+ msgs) down to 30 when an optimistic message was active. Fix: poll `setMessages` always computes `base` (history-downgrade guard) before applying optimistic/orphan logic.
- **[local] `React.Fragment` key fix** — Removed incorrect key on Fragment in message list.
- **[local] `historyLimitRef` removed from WS dep array** — Prevented unnecessary WS reconnects.

---

## [2026-04-26] — Bug Fixes + OSS Cleanup

### Fixed
- Resolved 9 bugs from Kennan's fresh-pull report (`f42ceb3`)
- Removed hardcoded domains; added dev proxy; fixed local WS import (`ef7582e`)
- Replaced personal gateway URL with generic placeholder in ConnectModal (`402ac44`)
- Removed `.bak` directories from git tracking (`9aaf04d`)

### Changed
- **[local] Safeguard infrastructure** — Added `scripts/backup.sh`, `rollback.sh`, `healthcheck.sh`, `patch-drift-check.sh`, `watchdog.sh`, `safe-pull.sh`
- **[local] `scripts/apply-local-patches.cjs`** — Idempotent patch manager; auto-runs on git pull via post-merge hook. Single source of truth for all Casken-specific changes.
- **[local] Cron jobs** — 3-min watchdog (restarts + DMs Kennan if down), 3am daily backup, 6am daily patch-drift check.

---

## [2026-04-21] — v1: Local Auth + OSS Refactor

### Added
- **Local auth system** — Replaced Clerk with self-hosted login. Multi-user support, user management UI, session isolation per user (`132daf1`, `fb702bd`, `086841b`)
- **OSS refactor** — Cleaned up all personal/Casken-specific references for open-source friendliness

### Fixed
- Global 401 interceptor via `authFetch` — auto-shows login modal on session expiry (`eda9a2d`)
- Added `credentials: include` to all auth'd fetches post-Clerk migration (`597da3e`)

---

## [2026-04-20] — Autoname Performance + Hidden Session Fixes

### Performance
- Session autoname iterated: Gemini Flash → Haiku (direct) → Haiku (OpenRouter) → llama-3.1-8b → **llama-3.2-3b** (660ms, 25x cheaper than direct Haiku) (`f8eafc6`, `a5db3e9`, `93e76fd`, `6443c03`)
- Autoname OpenRouter call timeout raised to 8s (`f4bb525`)

### Fixed
- Merge hidden sessions on hydration instead of replace (`c74b979`)

### Changed
- **[local] `/api/session-autoname` uses `claude-haiku-4-5`** (Casken deployment uses direct Anthropic, not OpenRouter)

---

## [2026-04-19] — WebSocket Stability

### Fixed
- Keep sessions list on WS reconnect — added 25s keepalive ping, reset backoff on tab visibility change (`ff67883`)

---

## [2026-04-18] — Video, Drafts, ACP Sessions, Secrets

### Added
- Video support: frame extraction for video file attachments (`f3d23f9`)
- ACP session visibility in session list (`f3d23f9`)
- Draft persistence: drafts saved to server DB, restored on reload (`f3d23f9`)
- iOS scroll fix (`f3d23f9`)

### Fixed
- Send button crash — `onClick` was passing the event object as `overrideMsg`, causing silent failure (`8e5dbc5`)
- Moved `GITHUB_PAT` to env var; removed hardcoded secret (`90d15d7`)

### Changed
- **[local] `octis_drafts` table** + `/api/drafts/*` endpoints (server-side draft storage)
- **[local] `user_settings` table** added to `db/schema.sql`

---

## [2026-04-15] — Mobile Regressions + Session List Cleanup

### Fixed
- Filtered model-fallback sessions (Gemini Flash retry sessions) from session list (`057144c`)
- 3 mobile regressions: `normalizeContent` ReferenceError, image rendered as raw mega-string, empty streaming content (`1f85168`)

---

## [2026-04-14] — Project-First UX

### Added
- Projects grid as the default landing view (`009f723`)
- `ProjectView` (desktop) and `MobileProjectView` (mobile) — session list scoped per project
- **[local] Project context injection** — Each project injects a context note into agent sessions so the agent knows which project it's working in
- **[local] `hide_from_sessions` column** on `octis_projects` table (hides Slack project sessions from main list)
- **[local] Slack key-pattern filter** — Sessions with `:slack:` in key hidden from both `Sidebar.tsx` and `MobileApp.tsx`

---

## [2026-04-10] — Stuck Detection + TypeScript + Stepping Away

### Added
- Stuck detection: flags sessions as "needs you" when agent appears unresponsive (`d223518`)
- Needs-you sort: stuck sessions float to top of list
- Quick action buttons in session list: 📋 Brief, ⏸ Pause, ▶ Resume, 🚪 Step Away (`d223518`)
- Mobile stuck status indicator (`d223518`)
- 🚪 Stepping away button: sends away message, asks agent to note plan + blockers + autonomous work queue (`31f9488`)

### Fixed
- Stuck detection threshold: only flags sessions active within the last hour, not all stale sessions (`985168d`)
- Tailwind content glob was missing `.ts`/`.tsx` — zero styles were rendering after TSX migration (`03ac62e`)
- `index.html` pointed at stale `.jsx` entry; fixed to `main.tsx` (`029d375`)
- Missing `getLabel` import in Sidebar outer scope — was crashing on load (`46b5b55`)

### Changed
- Full TypeScript migration — zero implicit `any` errors across `MemoryPanel`, `SettingsPanel`, `Sidebar` (`33a7cd9`)

---

## [2026-04-08] — Auth, Session Filtering, Agent Config

### Added
- Clerk auth: login screen, gateway config served server-side, session filtering by authenticated user (`caf4350`)
- Filter sessions by `agentId` — multi-agent setups (e.g. Byte) see only their own sessions (`04778eb`)
- **[local] Ghosty agent** configured in `server/config/agents.json` as `id: main`

### Fixed
- Removed temp diagnostic scripts (`704a3fc`)

---

## [2026-04-07] — Heartbeats, Costs, Merge

### Added
- Heartbeat messages hidden from chat pane; ❤️ indicator shown in pane header instead (`033b747`)
- **[local] `contextNote` directive** in `server/index.js` — project context injected into agent system prompt

### Fixed
- Correct column names for `claw_user_daily_costs` and `claw_session_costs` tables (`b408194`)

---

## [2026-04-06] — Markdown, Projects, Status, Memory

### Added
- Markdown renderer in chat pane with collapsible code blocks (`1a7dca5`)
- Project view, session tagging, Continue button (`3fe8fed`)
- 5-state chat status system with live streaming detection (`97a0fdb`)
- MemoryPanel v2: proper markdown renderer, TODO badges, project-aware sorting (`d05b90f`)

### Fixed
- Used correct `req`/`res` protocol for `chat.history` and `chat.send` (`f923ad5`)

---

## [2026-04-04] — Error Recovery

### Fixed
- Added error boundary + gateway error recovery — no more black screen on bad WebSocket state (`d43a6b3`)

---

## [2026-04-03] — Initial Build

### Added
- Initial app skeleton: multi-pane layout, session sidebar, WebSocket gateway connection (`6d17007`)
- Costs panel (Postgres live cost data), Memory panel (TODOs, MEMORY.md, logs, projects), tab navigation, Express API server (`c88792f`)
- Session status tracking, shared event bus (`6ffc155`)
- Rename sessions (double-click or ⋯ menu), archive, filter by status, search, New Session button (`82d01e5`)
- **[local] `vite.config.js`** — `base: '/octis/'`, service worker `importScripts` relative path, runtime cache `urlPattern`
- **[local] `server/index.js`** — Trust proxy, `loginLimiter` with `xForwardedFor`, `UUID_RE` label fix, chat history cap raised to 300
- **[local] AutoResizeTextarea** in SettingsPanel; quick commands via localStorage-primary storage

---

## Notes

- **Local patches** are managed by `scripts/apply-local-patches.cjs` and applied automatically on every `git pull` via the post-merge hook.
- **Safe pull:** always use `bash scripts/safe-pull.sh` — never raw `git pull`.
- **Outstanding:** Patches 27–31, 37–45 and the `hydrateFromServer` change are not yet registered in `apply-local-patches.cjs` — must be added before the next upstream pull.
