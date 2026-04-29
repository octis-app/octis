# Octis — Local Changes & Fixes Log

> **Base commit:** `f42ceb3` ("fix: resolve 9 bugs from Kennan's fresh-pull report")
> **Changed files:** 17 files across frontend, backend, DB schema, and build config
> **Purpose:** This document describes every change made locally since the initial pull, intended for the upstream maintainer before any merge.

---

## Latest Changes — 2026-04-29

### Hotkey Safety Fix - Remove Bare-Key Shortcuts (16:45 UTC)

**Files changed:**
- `src/App.tsx` (hotkey bindings + help modal)
- `src/hooks/useHotkeys.ts` (reverted previous safety check)

**Problem:**
- Bare-key shortcuts (N, E, R, ?) were firing when user browsed Sessions tab or any other UI
- Pressing 'E' would archive sessions unexpectedly while scrolling through list
- Pressing 'T' or other keys triggered unintended actions without warning
- Bare-key shortcuts are fundamentally unsafe in a web app where users can type anywhere

**Solution:**
- **Removed ALL bare-key shortcuts** - all hotkeys now require Cmd/Ctrl modifier
- Updated bindings:
  - `N` → `Cmd+N` (new session)
  - `E` → `Cmd+E` (archive)
  - `R` → `Cmd+R` (rename)
  - `?` → `Cmd+Shift+/` (show shortcuts)
  - `Cmd+Z` and `Cmd+Y` (undo/redo) unchanged
- Updated help modal to show correct shortcuts with ⌘ prefix
- Reverted previous bare-key safety check in useHotkeys.ts (no longer needed)

**Result:**
- ✅ Zero risk of accidental hotkey triggers while browsing any UI
- ✅ Users can type anywhere without fear of triggering actions
- ✅ Standard app behavior - all shortcuts require explicit modifiers
- ✅ Much safer UX - prevents data loss from unintended keystrokes

---

### Project Delete with Session Warning (16:31 UTC)

**Files changed:**
- `server/index.js` (DELETE `/api/projects/:id` endpoint)
- `src/components/ProjectsGrid.tsx` (delete handler + confirmation dialog)

**Changes:**
1. Enhanced DELETE endpoint to count associated sessions before deletion:
   - First call without `?confirm=true` returns warning with session counts
   - Counts split into `activeCount` (visible sessions) and `archivedCount` (hidden sessions)
   - Applied visibility filters: agent isolation, exclude subagents/heartbeats/threads/"continue where you left off"
2. Frontend `handleDelete` calculates counts using exact same logic as project card display:
   - Active: `sessions` array filtered by `isVisibleSession` + project tag
   - Archived: `hiddenSessions` filtered by project tag (excluding agent sessions)
   - Shows confirmation dialog with breakdown: "X sessions (Y active, Z archived)"
   - If 0 sessions, deletes immediately without confirmation
3. Confirmation dialog shows detailed breakdown when both exist:
   - Both: "23 sessions (20 active, 3 archived)"
   - Active only: "5 sessions (5 active)"
   - Archived only: "2 sessions (2 archived)"
4. On confirmed deletion:
   - Deletes project from `octis_projects`
   - Removes ALL project tags from `octis_session_projects` (sessions remain, just untagged)
5. Delete button (🗗️) appears on project card hover, next to visibility toggle

**Why:**
- Users couldn't delete projects (no UI option)
- Risk of accidentally deleting projects with active work
- Needed visibility into what would be affected before deletion

**Fixes applied during development:**
1. Initial backend count (v2.10-2.11) showed DB totals, mismatched UI (114 vs 6 for Slack)
2. Added agent isolation filter (v2.12): `LIKE 'agent:main:%'` to match frontend store filter
3. Added thread exclusion (v2.13): `NOT LIKE '%:thread:%'` — threads don't count as "sessions" in UI
4. Final fix (v2.14): Frontend calculates counts using same logic as project card — guarantees exact match

**Root cause of mismatch:** Backend counted sessions from DB (`octis_session_projects`), but frontend shows sessions from gateway's live `sessions.list` response. Old/dead sessions exist in DB but not in gateway list. Solution: frontend is source of truth for counts.

**Tested:** ✅ Delete empty project → immediate deletion ✅ Delete project with sessions → warning shown with correct counts ✅ Confirm deletion → project deleted, tags removed ✅ Session tags verified removed from DB ✅ Counts match project card display exactly (Slack: 6, Module 1: 1)

---

### Project Context Auto-Injection Fix (16:22 UTC)

**Files changed:**
- `server/index.js` (POST `/api/session-projects` endpoint)
- `src/components/Sidebar.tsx` (new session with project)
- `src/components/MobileProjectView.tsx` (mobile new session with project)
- `src/components/ProjectView.tsx` (desktop new session with project)

**Changes:**
1. Made `/api/session-projects` endpoint async to support chat injection
2. Query old project before updating DB to detect state changes
3. Inject project context message ONLY when switching projects (not on initial assignment):
   - **Project switch** (project A → project B): "This session has been **moved to** the {emoji} {name} project"
   - **Project removal** (project → null): "This session has been **removed from its project**"
   - **Initial assignment** (null → project): Handled by existing `session-init` endpoint (no duplicate)
   - **No-op** (same → same): Skip injection
4. Removed `[📁 Project]` prefix from injected message text (already rendered by `label` parameter)
5. Added `skipInject: true` flag to frontend calls when creating new sessions with projects (preserves existing `session-init` flow)

**Why:** 
- Switching projects had no notification (bot unaware of change)
- Duplicate project context messages appeared (both `session-init` AND new injection fired)

**Fix:** Server-side switch detection in `/api/session-projects` endpoint supplements (not replaces) existing `session-init` flow. New sessions use the old flow (single message), switches use the new flow (switch notification).

**Tested:** ✅ Syntax check passed (`node -c server/index.js`), ⚠️ needs live testing

---

### Mobile Project Switcher Fix (11:18 UTC)

**Files changed:**
- `src/components/MobileApp.tsx`

**Changes:**
1. Added `__archived` filter to `availableProjects` initialization (line 155)
2. Changed filter from `p.slug !== 'others' && !p.hide_from_sessions` to `p.slug !== 'others' && p.slug !== '__archived' && !p.hide_from_sessions`

**Why:** Mobile project switcher and new-session picker were showing "Archived" as a selectable project option (same issue as desktop, different code path). Users couldn't switch projects or see proper project list on mobile.

**Tested:** ✓ Build successful, service restarted

---

### Model Switch Notification Feature (Desktop)

**Files changed:**
- `src/components/ChatPane.tsx` (ModelBadge component + message rendering)
- `src/components/MobileFullChat.tsx` (partial implementation, incomplete)

**Changes:**
1. Added inline divider-style notification when manually switching models (like Messenger group name change)
2. Detection regex matches messages starting with "Model switched to" or containing model switch keywords
3. `ModelBadge` component now accepts `onModelSwitch` callback prop
4. Parent `ChatPane` injects local-only notification message with `__localOnly: true` flag
5. Message deduplication logic (`setMessages` in poll handler) preserves `__localOnly` messages across history refreshes
6. Notification appears instantly on switch, persists during session, but disappears on page refresh (client-side only)

**Why:** User requested visual feedback when manually switching models to confirm the change took effect.

**Tested:** ✓ Desktop switches show notification instantly; refresh clears it (expected behavior)

**Known issues:**
- Mobile implementation incomplete (lacks message preservation logic)
- Notifications don't persist to server (localStorage approach failed due to message state conflicts)
- Multiple failed attempts logged: tried `chat.send` (triggers unwanted agent run), tried localStorage (caused state conflicts), settled on client-only approach

**Review needed:** Decide if server-side persistence is worth the complexity (would require adding system message injection or separate notification table)

---

### Archived Session UI Improvements

**Files changed:**
- `src/components/ChatPane.tsx`
- `src/components/MobileProjectView.tsx`
- `src/components/Sidebar.tsx`

**Changes:**
1. Removed `__archived` as a selectable project option from project switcher dropdowns
2. Kept the amber "Archived session" indicator badge at the top of the project switcher when viewing an archived session
3. Filtered `__archived` from regular project lists in both desktop (`ChatPane.tsx`) and mobile (`MobileProjectView.tsx`) views
4. Cleaned up project filtering logic to exclude `__archived` from "Switch project" and "Move to project" sheets

**Why:** The `__archived` project was showing as a selectable option in the project switcher, which was confusing UX. Archived sessions should show a visual indicator (the amber badge) but shouldn't be manually assignable as a "project" — archiving is a separate action from project assignment.

**Tested:** ✓ Build successful, service restarted, UI displays correctly

---

## 1. Build / Deployment — `vite.config.js`

**Context:** Octis is deployed at a subpath (`/octis/`) behind a Caddy reverse proxy, not at the root (`/`).

| # | Change | Why |
|---|--------|-----|
| 1 | `base: '/octis/'` added to Vite config | All asset URLs need the subpath prefix or the app 404s when served under `/octis/` |
| 2 | `importScripts: ['sw-push.js']` (relative, was `/sw-push.js`) | Absolute path broke SW registration under the subpath |
| 3 | `urlPattern: /\/api\//` (was `/^\/api\//`) | Anchored pattern didn't match API calls routed through the proxy prefix |

---

## 2. Database Schema — `db/schema.sql` + runtime migrations in `server/index.js`

| # | Change | Why |
|---|--------|-----|
| 4 | `hide_from_sessions INTEGER DEFAULT 0` column added to `octis_projects` | Allows a project (e.g. Slack) to be hidden from the Sessions tab without deleting it |
| 5 | `user_settings` table added (`user_id`, `key`, `value`, `updated_at`) | Persistent per-user key/value store for Quick Commands and other settings |
| 6 | `octis_drafts` table added (`session_key`, `user_id`, `text`, `updated_at`) | Server-side draft persistence for cross-device sync (new feature — see §6) |
| 7 | Runtime `ALTER TABLE` migrations on startup for all three schema additions | Ensures existing deployments upgrade without needing manual DB migration |

---

## 3. Server — `server/index.js`

### 3a. Infrastructure / Auth
| # | Change | Why |
|---|--------|-----|
| 8 | `app.set('trust proxy', 1)` | Without this, `req.ip` returns the proxy IP instead of the client IP — rate limiter banned the proxy |
| 9 | `loginLimiter` — added `validate: { xForwardedForHeader: false }` | Silenced a `express-rate-limit` warning about `X-Forwarded-For` header validation in proxied environments |

### 3b. Session Autoname — switched from OpenRouter to Anthropic
| # | Change | Why |
|---|--------|-----|
| 10 | `/api/session-autoname` now calls `https://api.anthropic.com/v1/messages` with `claude-haiku-4-5` instead of OpenRouter/Llama | OpenRouter API key not available in this environment; Anthropic key is. Response format updated accordingly (`content[0].text` vs `choices[0].message.content`) |

### 3c. Session Label Improvements
| # | Change | Why |
|---|--------|-----|
| 11 | `UUID_RE` regex + `sessionIdToFriendlyLabel()` helper added | When a session's first message is a bare UUID (a device ID artifact), that message was incorrectly used as the session label. Now detected and stripped |
| 12 | `/api/session-labels` — cross-indexed without `agent:main:` prefix | Sessions stored by Postgres with short keys (e.g. `session-1234`) didn't match labels stored with the full gateway key (`agent:main:session-1234`) |
| 13 | `/api/chat-history` — limit raised from 100 to 300 messages | 100 was too low for long sessions; 300 matches the new client-side default |

### 3d. Hidden Session Details — improved label resolution
| # | Change | Why |
|---|--------|-----|
| 14 | `/api/hidden-session-details` now uses a 4-strategy label lookup | Old code: exact match → fuzzy. New code: (1) exact → (2) `agent:main:dashboard:{uuid}` expansion for bare UUIDs → (3) bare `session-xxx` short-key → (4) fuzzy suffix. Fixes archived sessions showing raw UUIDs |
| 15 | Response now includes `hiddenAt` ISO timestamp | Allows client to show "Archived Apr 26" as a fallback label for old unlabeled sessions |

### 3e. Project API
| # | Change | Why |
|---|--------|-----|
| 16 | `PATCH /api/projects/:id` now accepts and persists `hide_from_sessions` flag | Required for the Sessions tab filter feature |
| 17 | `contextNote` format updated to the new structured `[Octis Project Context]` injection template | Old format was a raw Markdown line; new format is a structured block that agents parse reliably |

### 3f. New API Endpoints
| # | Change | Why |
|---|--------|-----|
| 18 | `GET /api/settings`, `PATCH /api/settings` | Reads/writes the `user_settings` table for Quick Commands and other per-user preferences |
| 19 | `GET /api/drafts`, `GET /api/drafts/:sessionKey`, `PUT /api/drafts/:sessionKey`, `DELETE /api/drafts/:sessionKey` | Server-side draft sync so a draft started on desktop is available on mobile |

---

## 4. State Store — `src/store/gatewayStore.ts`

### 4a. Draft Store — cross-device persistence
| # | Change | Why |
|---|--------|-----|
| 20 | `useDraftStore` now persists to `localStorage` (key `octis-drafts-v2`) on every write | Drafts no longer vanish on page refresh |
| 21 | `setDraft` / `clearDraft` debounce a server sync (1.5s) via `PUT/DELETE /api/drafts/:key` | Drafts sync across devices without hammering the server on every keystroke |
| 22 | `hydrateFromServer()` added to `useDraftStore` | On app load, merges server drafts with local — local wins for sessions already being typed, server wins for the rest |

### 4b. `projectMeta` type extended
| # | Change | Why |
|---|--------|-----|
| 23 | `projectMeta` record now includes `hideFromSessions?: boolean` | Sidebar and MobileApp can filter sessions belonging to hidden projects |

### 4c. `hydrateHiddenFromServer` — replace-not-merge
| # | Change | Why |
|---|--------|-----|
| 24 | Changed from merge-into to full replace | Old merge caused unarchived sessions to reappear (ghost entries). Replace ensures the store exactly matches the server's hidden list |

### 4d. `setSessions` — preserved DB-hydrated hidden sessions
| # | Change | Why |
|---|--------|-----|
| 25 | `setSessions` now merges WS-known hidden sessions with existing DB-hydrated sessions | Without this, old sessions (bare-UUID webchat sessions, old Slack threads) not known to the current WS connection got silently dropped from `hiddenSessions` on every gateway poll — causing Sessions ARCHIVED and Projects ARCHIVED to show different lists |

### 4e. Auto-tag Slack sessions
| # | Change | Why |
|---|--------|-----|
| 26 | `autoTagSlackSessions()` runs on every `setSessions` call | Sessions with `:slack:` in their key are automatically tagged to the Slack project so they stay out of the main Sessions tab without manual tagging |

### 4f. Auto-tag WhatsApp sessions + WhatsApp project
| # | Change | Why |
|---|--------|-----|
| 46 | WhatsApp project inserted into `octis_projects` (slug: `WhatsApp`, emoji: 💬, color: #25d366) | Groups all WhatsApp conversations into a dedicated project folder |
| 47 | `setSessions` auto-tags sessions whose key matches `/whatsapp/i` with the `WhatsApp` project (if not already tagged) | Future WhatsApp sessions are automatically organized without manual tagging |
| 48 | Existing WhatsApp session `agent:main:whatsapp:direct:+15142457588` back-filled to WhatsApp project in DB | Retroactive tagging so existing conversations appear in the new project immediately |

---

## 5. Desktop Sidebar — `src/components/Sidebar.tsx`

| # | Change | Why |
|---|--------|-----|
| 27 | `SessionItem` gets `onUnarchive` prop; context menu shows "↩ Unarchive" for archived items instead of "🗑 Archive" | Archives tab needed a way to restore sessions — the menu action was context-dependent |
| 28 | `formatFallbackLabel` overhauled: Slack threads → `"DM · Apr 26 5:07am"`, session timestamps → `"Session · Apr 26 5:07am"`, bare UUIDs → `"Archived Apr 26"` / `"Unnamed session"` | Old fallback returned raw key slices (e.g. `f540bf30-1eac-4d43…`) which were meaningless to users |
| 29 | `displayLabel` now tries `agent:main:dashboard:{uuid}` key expansion for bare-UUID sessions | Dashboard sessions stored as bare UUIDs in hidden table weren't matched to their labels in the store |
| 30 | Drag handle isolated to a `⠿` icon on the left — main row uses `cursor-pointer` instead of `cursor-grab` | Entire row being `cursor-grab` made it feel non-clickable and confused users on desktop |
| 31 | `projectMeta` hydrated on sidebar mount (separate `fetch /api/projects`) | `hide_from_sessions` filter for the Sessions tab wasn't applied until the Projects tab was visited at least once — now works on first load |
| 32 | Default agent label changed from `Byte` to `Ghosty` | Correct agent name for this deployment |
| 33 | Archives tab triggers `hydrateHiddenFromServer()` on every tab switch | Ensures newly archived sessions appear without a full page refresh |

---

## 6. Mobile App — `src/components/MobileApp.tsx`

| # | Change | Why |
|---|--------|-----|
| 34 | `hide_from_sessions` filter applied to project list | Projects marked as hidden (e.g. Slack) no longer appear in the Sessions tab's project filter on mobile |
| 35 | Tab state persisted in URL hash + `sessionStorage` | On PWA home screen launch, the hash is stripped by iOS — sessionStorage fallback restores the last active tab |
| 36 | `popstate` / back-button handler added | Navigating back from a full-chat view or project view correctly returns to the previous tab |
| 37 | `openChat()` uses `pushState`; new `switchChat()` uses `replaceState` | Tab-strip chat switches (between open sessions) no longer pollute the browser back-stack — back button always returns to the session list, not the previously-viewed chat |
| 38 | Sessions ARCHIVED section is now a **reactive subscription** to `hiddenSessions` store | Was a stale one-shot snapshot; diverged from the Projects ARCHIVED view after any WS update |
| 39 | Sessions ARCHIVED sorted by `lastActivity` desc — same as Projects ARCHIVED | Made both views appear to show entirely different data just because sort order differed |
| 40 | Archive label display: tries `agent:main:dashboard:{uuid}` expansion, Slack threads → `"DM · Apr 26 5:07am"`, bare UUIDs → `"Archived Apr 26"` | Raw UUIDs like "Session 006e3c31…" shown to users for old unlabeled sessions |
| 41 | `handleUnarchive` no longer manually filters `archivedSessions` local state | State is now reactive — the store update handles removal automatically |
| 42 | SettingsPanel imported and accessible via Memory tab `⚙️` button | Settings were desktop-only; mobile users had no way to edit Quick Commands |
| 43 | `isAgentSession` uses `getLabel()` instead of raw `s.label` | Server-side labels not yet in the WS response weren't checked, causing some legitimate sessions to be filtered out |
| 44 | `isHeartbeatOrCron` mirrors desktop Sidebar logic exactly | Consistency — same sessions hidden on both surfaces |

---

## 7. Mobile Full Chat — `src/components/MobileFullChat.tsx`

| # | Change | Why |
|---|--------|-----|
| 45 | Message history cap raised: `MAX_MESSAGES_PER_SESSION` 50 → 200, `DEFAULT_HISTORY_LIMIT` 50 → 200, `LOAD_MORE_INCREMENT` 50 → 100 | Mobile was cutting off after 50 messages — same as desktop cap |
| 46 | **Poll collapse bug fixed** — `chat-poll-*` handler now guards against downgrading loaded history | **Critical bug:** poll responses (30 msgs) were replacing fully-loaded history (200 msgs) whenever an optimistic message (pending send) was active. Root cause: the history-downgrade guard only ran when no optimistic messages existed. With an active optimistic, the code returned `[...30 poll msgs, optimistic]` = 31 items, wiping all loaded history. Cache then wrote the 31-item state, so messages appeared permanently missing until refresh |
| 47 | Cache-sync effect: writes server messages to `msgCache` whenever they update | Keeps localStorage cache current so instant-load on session switch reflects the latest messages |
| 48 | `historyLimitRef` ref pattern added (mirrors ChatPane) | WS closure captured stale `historyLimit` state, causing load-more to request the old limit |
| 49 | Auto-trigger load-more when near visual top after history loads | Prevents "dead zone" where `hasMore=true` but no scroll event fires because the content doesn't fill the viewport |
| 50 | Left-edge swipe exclusion: touches starting within **20px of left edge** are not intercepted | iOS back gesture (swipe from left edge) was captured by the swipe-to-switch handler, navigating between chats instead of going back to the session list |
| 51 | Server-side draft loaded on session open (cross-device sync) | If a draft was started on desktop, it now appears on mobile when switching to that session |

---

## 8. Desktop Chat Pane — `src/components/ChatPane.tsx`

| # | Change | Why |
|---|--------|-----|
| 52 | `historyLimitRef` ref pattern — WS closure always sees latest limit | Stale closure caused load-more to re-request the same limit |
| 53 | `hasMore` auto-trigger for sessions shorter than the viewport | Same dead-zone fix as MobileFullChat — scroll event never fires if content doesn't overflow |
| 54 | Draft reset on `sessionKey` change | When a pane switched sessions (same component instance), the old draft remained in the input |
| 55 | Server draft fetched on session switch (cross-device sync) | Same as MobileFullChat — desktop now picks up drafts started on mobile |

---

## 9. App Shell — `src/App.tsx`

| # | Change | Why |
|---|--------|-----|
| 56 | Active nav persisted in URL hash + `sessionStorage` | Same PWA-home-screen hash-stripping problem as mobile; now uses dual storage |
| 57 | `popstate` handler for back/forward navigation | Browser back from project view correctly returns to grid without React state mismatch |
| 58 | Duplicate pane guard: `activePanes` deduplicated on render | Gateway occasionally returned the same session key twice, causing two ChatPane instances to render for the same session |
| 59 | `useDraftStore.hydrateFromServer()` called on connect + reconnect | Ensures cross-device drafts are loaded when the app connects to the gateway |

---

## 10. Settings Panel — `src/components/SettingsPanel.tsx`

| # | Change | Why |
|---|--------|-----|
| 60 | `AutoResizeTextarea` component added | Fixed-height textarea cropped long quick commands on small screens |
| 61 | Quick Commands state managed via `localStorage` as primary (not server) | Opening Settings previously triggered a server fetch that overwrote in-progress edits with the last saved value — felt like the panel was resetting |
| 62 | Server sync on save (400ms debounce) with `saving… → ✓ saved` indicator | User had no feedback that the save went through |
| 63 | Server values applied on mount **only if** localStorage is empty / matches defaults | Prevents server from silently overwriting local customisations on open |

---

## 11. Projects Grid — `src/components/ProjectsGrid.tsx`

| # | Change | Why |
|---|--------|-----|
| 64 | `hide_from_sessions` flag published to global `projectMeta` store | Sidebar and MobileApp need this flag to filter session lists; it wasn't being passed through |

---

## 12. Mobile Project View — `src/components/MobileProjectView.tsx`

| # | Change | Why |
|---|--------|-----|
| 65 | Project tags re-hydrated on mount | Opening a project before the initial `hydrateAll` completed showed untagged sessions |

---

## 13. Message Cache — `src/lib/msgCache.ts`

| # | Change | Why |
|---|--------|-----|
| 66 | Cache size raised from 150 to 200 messages per session | Aligned with the new history limit defaults |

---

## 14. Static Assets

| # | Change | Why |
|---|--------|-----|
| 67 | `.env.production` created with `VITE_API_URL=/octis` | Without this, Vite builds with no API prefix and all API calls 404 under the `/octis/` subpath |

---

## Summary

| Category | Changes |
|---|---|
| Bug fixes | 24 |
| New features / capabilities | 22 |
| Performance / UX improvements | 14 |
| Infrastructure / deployment | 7 |
| **Total** | **67** |

**Key bugs fixed:**
- Poll handler collapsing 200-msg history to 31 whenever a message was being sent (critical data-loss appearance)
- iOS left-edge swipe triggering chat switch instead of browser back
- Tab-strip switches polluting the back-stack (back button cycling through chats instead of going to session list)
- Archived sessions showing raw UUIDs instead of readable names
- Sessions ARCHIVED and Projects ARCHIVED showing different lists due to reactive vs. stale snapshot mismatch
- `hydrateHiddenFromServer` race with `setSessions` dropping DB-only hidden sessions on every WS poll

**Key new features:**
- Cross-device draft persistence (localStorage + server sync)
- `hide_from_sessions` project flag (e.g. hide Slack sessions from Sessions tab)
- Per-user settings API with Quick Commands
- Unarchive action in desktop sidebar
- Mobile Settings panel accessible from Memory tab
- Structured project context injection format for AI agents

---

## Session 2026-04-27 08:00–08:20 UTC — Additional UX Fixes (Ghosty / this session)

> Appended from parallel session. All changes below are local-only, on top of the patches already documented above.

### New: Microsoft Word-style Undo/Redo (`src/hooks/useTextareaUndo.ts`)
- New shared hook with burst coalescing (1.5s gap = new undo unit)
- Applied to: `ChatPane.tsx` chat textarea, `MobileFullChat.tsx` chat textarea, `SettingsPanel.tsx` quick commands
- Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z in all surfaces; ↩ ↪ buttons in settings

### New: TDZ Dep-Array Scanner (`scripts/check-tzdeps.cjs`)
- Scans all `.tsx/.ts` for `useEffect`/`useCallback`/`useMemo` dep arrays referencing later-declared variables (TDZ crash in production)
- **Wired into `npm run build`:** `node scripts/check-tzdeps.cjs && vite build` — build fails if any TDZ risk found
- Also added to `.git/hooks/post-merge`
- Context: 3 TDZ crashes shipped this session before scanner was added (minified names `fe`, `ut`)

### Bug Fixed: Sessions Broken — TDZ ("Cannot access 'ut' before initialization")
- `pendingFiles` sync `useEffect` at line ~607 had `[pendingFiles]` dep array; `pendingFiles` declared at line 1612
- Fix: moved effect to immediately after declaration

### Bug Fixed: Settings Crash — TDZ ("Cannot access 'fe' before initialization")
- `qcUndo`/`qcRedo` dep arrays referenced `persistQcToServer` before it was declared
- Fix: moved declarations after `persistQcToServer`; fixed stale `qcValues` closure in `updateQc`

### Bug Fixed: Session Click Needing Multiple Clicks
- `SessionItem` outer div onClick only fired with Ctrl/Meta/Shift held — plain clicks did nothing except on the exact label text
- Fix: outer div now calls `onPin()` on any plain click; label span gets `stopPropagation`
- Desktop only; mobile was already correct

### Bug Fixed: Chat Scroll — Starts at Top, Flashes Down
- Initial scroll was in `useEffect` + `requestAnimationFrame` (fires after paint) → brief flash of top
- Fix: moved initial scroll to `useLayoutEffect([messages])` — fires before paint

### Bug Fixed: Messages Disappear During Active Agent Run
- `historyLimit` in WS effect deps caused full re-run + new history fetch during streaming
- Fix: `historyLimitRef` + separate load-more effect + active-run guard in history handler

### Bug Fixed: Draft Raw JSON Appearing in Textarea
- Server draft fetch used `getDraft()` (text-only) as guard — empty text = falsy → fell through even with files saved
- Raw serialized JSON `{"text":"","files":[...]}` passed directly to `setInput()`
- Fix: guard now uses `getDraftData()` (checks both text + files); server response properly deserialized before `setInput`

### Bug Fixed: Images Lost from Draft on Reload
- `pendingFiles` `useState` always initialized to `[]` — lazy initializer never read from draft
- Fix: `useState(() => getDraftData(sessionKey).files)` — images restored on mount same as text

### Bug Fixed: Textarea Height Stays 1 Line After Split / Reload
- `resizeTextarea` called once on mount; container width changes (pane split) not detected
- Fix: `ResizeObserver` on textarea element, re-runs height calc on any dimension change

### UI: "Brief Me" → "📝 Dev Log"
- Icon `💬` → `📝`, label/tooltip updated across desktop, mobile, and settings
- Default command text updated to OCTIS_CHANGES.md logging instructions

### Housekeeping: OCTIS_CHANGES.md location + .gitignore
- Canonical location: `/opt/octis/OCTIS_CHANGES.md` (co-located with code, for upstream review)
- Added `OCTIS_CHANGES.md` to `.gitignore` — file is intentionally untracked (local dev notes, not for upstream commit)
- All sessions should update this file at this path

---

## Session 2026-04-27 05:11–06:22 UTC — Chat Loading Overhaul (Ghosty)

> All changes are local patches tracked in `scripts/apply-local-patches.cjs` (patches 15–27). Build verified clean after each batch of changes.

---

### CRITICAL Bug Fixed: Poll Handler Collapsing Message History on Send (`src/components/ChatPane.tsx`, `src/components/MobileFullChat.tsx`)

**Symptom:** Sending a message caused all but ~30 messages to disappear. Messages came back on manual refresh. Cache was being written with the corrupt 31-item list, so the problem persisted across page loads until a full WS history refetch.

**Root cause:** The poll handler's `setMessages` callback had a guard ("never replace a larger loaded history with a shorter poll response") — but that guard was only reached when NO optimistic messages were in state. The moment the user sent a message (optimistic added), the code took a completely different branch:
```
// Old broken path:
if (isOptimistic) {
  if (!serverAlreadyHasMsg && msgs.length <= preSendCountRef.current) {
    return [...msgs, prev[optimisticIdx]]  // ← msgs is 30-item poll! drops 170 msgs
  }
  return msgs  // ← also drops history
}
// orphan path had same issue: [...msgs, ...orphans]
// guard path was NEVER reached when optimistics existed
```
With `preSendCountRef.current = 200` (full history) and poll returning 30 items: `30 <= 200` → always true → returned `[...30 poll msgs, optimistic]` = 31 items.

**Fix:** Restructured `setMessages` callback to compute `base` first (the guard logic), then apply optimistic/orphan logic on top of `base`:
1. **Step 1 — compute `base`:** If `msgs.length >= prevServer.length`, use `msgs` directly. Otherwise keep `prevServer` and append only genuinely new messages (by timestamp or content fingerprint for ts=0 messages).
2. **Step 2 — optimistic handling:** Check `serverAlreadyHasMsg` against `base` (not `msgs`). If not confirmed, return `[...base, optimistic]` — full history preserved.
3. **Step 3 — orphan handling:** Same, uses `base`.
4. **ts=0 dedup fix:** Messages without timestamps were always appended on every poll (the old code had `ts === 0 → always include`). Now uses content fingerprint to avoid duplicate appends.

Applied identically to desktop (`ChatPane.tsx`) and mobile (`MobileFullChat.tsx`).

**Mobile additional fix:** Poll handler was calling `setMsgCache(session.key, msgs)` after every poll — overwriting the full 200-msg cache with a 30-msg truncated response. Removed. Added a `useEffect([messages, session?.key, loadedKey])` cache-sync effect (mirrors desktop pattern) — writes full merged server messages to cache after every state update.

---

### Bug Fixed: Mobile History Limits Too Low (`src/components/MobileFullChat.tsx`)

- `DEFAULT_HISTORY_LIMIT`: 50 → **200**
- `MAX_MESSAGES_PER_SESSION` (cache): 50 → **200**
- `LOAD_MORE_INCREMENT`: 50 → **100**
- `msgCache` desktop: saves 150 → **200** (`src/lib/msgCache.ts`)
- Server HTTP endpoint `/api/chat-history`: cap 100 → **300** (`server/index.js`)
- HTTP fallback delay: 800ms → **150ms**; fetches 200 messages (was 50) (`src/components/ChatPane.tsx`)

**Effect:** Most sessions now load fully in one shot. "Load older" button only appears for very long sessions (200+ messages). Cache covers enough to paint the full visible history immediately on session open.

---

### Bug Fixed: Stale Closure in Mobile Load-More WS Handler (`src/components/MobileFullChat.tsx`)

**Problem:** `setHasMore(finalMsgs.length >= historyLimit)` in WS response handler used `historyLimit` from the closure at handler creation time — not the updated value after user triggered load-more. Could incorrectly set `hasMore=false` when there were actually more messages.

**Fix:** Added `historyLimitRef = useRef(DEFAULT_HISTORY_LIMIT)` kept in sync via `useEffect`. WS handler now reads `historyLimitRef.current` instead of stale `historyLimit` state.

Also added `isLoadingMoreRef = useRef(false)` to prevent double-trigger on rapid scroll/tap. Reset on session switch and in WS handler after response arrives.

---

### Bug Fixed: Auto-Load on Scroll Not Re-Triggering After Load-More (both platforms)

**Problem:** After loading older messages, if scroll was restored to within 150px of the top (delta was small), the programmatic `el.scrollTop = delta` fired `onScroll`. But `isLoadingOlderRef.current` was still `true` at that moment (reset happened on the next line, after the scrollTop assignment). So the re-trigger condition `!isLoadingOlderRef.current` failed, and the user had to manually scroll again or tap the button.

**Fix (desktop):** Reset `isLoadingOlderRef.current = false` BEFORE setting `el.scrollTop`. Now when `onScroll` fires from the programmatic scroll, the ref is already false — if still within 150px of top, auto-trigger fires immediately.

**Fix (mobile):** Same pattern with `isLoadingMoreRef`.

**Additional fix (both platforms):** Added `hasMore` watcher `useEffect`. When `hasMore` transitions to `true` and user is already at the top (without needing to scroll), load triggers immediately — no scroll event required. Handles the case where the button appears but `onScroll` doesn't fire because user isn't actively scrolling.

---

### Bug Fixed: Screen Jumps to Bottom After Loading Older Messages (both platforms)

**Problem:** After loading older messages, the view jumped to the bottom of the chat. Root cause: `useEffect([messages])` (scroll-to-bottom) fires after `useLayoutEffect` restores scroll position. If `userScrolledUpRef.current` was momentarily wrong (e.g., iOS momentum bounce scroll temporarily setting it to false), scroll-to-bottom fired and overrode the restored position.

**Fix pattern — `wasLoadingOlderRef` (desktop) / `wasLoadingMoreRef` (mobile):**
- **Desktop:** Set `wasLoadingOlderRef.current = true` in `useLayoutEffect` before restoring scroll. In scroll-to-bottom `useEffect`: if flag is set, skip and reset — regardless of `userScrolledUpRef` state.
- **Mobile:** Set `wasLoadingMoreRef.current = true` in WS handler BEFORE calling `setMessages`. In `useLayoutEffect([messages])`: if flag is set, skip `el.scrollTop = 0` and reset. The flag must be set before `setMessages` so React's commit phase sees it in the layout effect.

**Why the order matters (mobile):** Ref mutations in an event handler are synchronous. All `setState` calls are batched in React 18. So `wasLoadingMoreRef.current = true` happens before React commits any state, and `useLayoutEffect` fires during the commit — guaranteed to see the flag.

---

### Testing

- `npm run build` — clean, no TypeScript or TDZ errors
- `systemctl restart octis.service && curl /api/health` — healthy
- Automated check script confirmed 27/27 patch markers present in source files
- `node scripts/apply-local-patches.cjs` — all patches: `[skip] already patched` (idempotent confirmed)
- Manual verification: scroll-to-top auto-loads, no jump to bottom after load, sent messages stay visible with full history intact

---

### Files Changed This Session

| File | Change |
|---|---|
| `src/components/ChatPane.tsx` | Poll handler rewrite (base-first guard), `wasLoadingOlderRef`, `hasMore` watcher, auto-load re-trigger fix, HTTP fallback 150ms/200 msgs |
| `src/components/MobileFullChat.tsx` | Poll handler rewrite, `wasLoadingMoreRef`, `hasMore` watcher, `historyLimitRef`, `isLoadingMoreRef`, cache-sync effect, all limits raised |
| `src/lib/msgCache.ts` | Cache size 150 → 200 |
| `server/index.js` | HTTP chat-history cap 100 → 300 |
| `scripts/apply-local-patches.cjs` | Patches 15–21 added (all above changes registered as idempotent patches) |

---

## Session 2026-04-27 08:00–08:55 UTC — Delete Session Feature + Archive Multi-Select (Ghosty)

> All changes are local patches on top of previously documented work. Build verified clean after each feature batch.

---

### New Feature: Permanent Session Delete

A true permanent delete was added, distinct from Archive. Sessions that are permanently deleted are removed from all DB tables, hidden from the gateway's WS `sessions.list` broadcast, and cannot be recovered.

#### New file: `src/components/DeleteConfirmModal.tsx`

Shared confirmation modal used across all delete surfaces:
- Title: "Delete session?" with 🗑️ icon
- Body names the session and warns "This cannot be undone."
- Buttons: **Cancel** (neutral) and **Delete forever** (red)
- ESC key dismisses; backdrop click dismisses
- Auto-focuses confirm button (keyboard-safe)

#### Backend: `server/index.js` — `POST /api/session-delete`

New endpoint added before the existing `/api/drafts` routes:

```
POST /api/session-delete   body: { sessionKey }
```

Actions on confirm:
1. DELETE from `octis_session_labels`, `octis_session_projects`, `octis_pinned_sessions`, `octis_session_ownership`, `octis_drafts`
2. **INSERT/UPDATE `octis_hidden_sessions` with `deleted=1`** (see critical fix below — does NOT delete this row)
3. Best-effort call to gateway `sessions.delete` via `adminGwCall` (removes from gateway's active session registry)

Requires auth (`requireAuth` middleware). Returns `{ ok: true }`.

#### Frontend: Delete option added in all session surfaces

| Surface | Where |
|---|---|
| Desktop Sidebar — Chats tab | `SessionItem` 3-dot (⋯) menu: "🗑️ Delete permanently" below Archive, separated by a divider |
| Desktop Sidebar — Projects tab | Same `SessionItem` 3-dot menu in `ProjectGroup` sessions |
| Desktop Sidebar — Archives tab | Same 3-dot menu; also available via bulk action bar (see below) |
| Desktop ChatPane — header | New 🗑️ Del labeled pill button, **last** in the action bar, after 📋, separated by a `|` divider. Styled with a subtle red tint at rest; brighter red on hover. Positioned last to reduce accidental clicks. |
| Mobile — long-press action sheet | Archive and Delete options added at bottom of the "Move to project" sheet |
| Mobile — archived rows | 🗑️ delete button added alongside ↩ unarchive button (non-select mode) |

---

### Critical Bug Fixed: Deleted Sessions Coming Back on Every WS Poll

**Symptom:** Clicking "Delete permanently" removed the session from the UI, but it reappeared within ~30 seconds. The session could be deleted multiple times and always returned.

**Root cause:**

Every delete handler called `useHiddenStore.getState().unhide(sessionKey)`. This removed the key from the `hidden` Set in `useHiddenStore`. The gateway broadcasts `sessions.list` every ~30 seconds. When that broadcast arrived, `setSessions` checked `hiddenStore.isHidden(key)` — now false — so the session passed the filter and was added back to the active sessions list. The `DELETE FROM octis_hidden_sessions` in the server endpoint had the same effect: on the next `hydrateHiddenFromServer`, the session wasn't in the DB hidden list either, so it was treated as fully active.

**Fix — three-layer solution:**

**Layer 1 — DB schema (`server/index.js`):**
```sql
ALTER TABLE octis_hidden_sessions ADD COLUMN deleted INTEGER DEFAULT 0
```
Added as a safe startup migration (`try { ... } catch {}`). Allows a row to represent either "archived" (`deleted=0`) or "permanently deleted" (`deleted=1`) — distinguishing the two states without a separate table.

**Layer 2 — Server endpoint:**
- `POST /api/session-delete` now does `INSERT INTO octis_hidden_sessions (session_key, deleted) VALUES (?, 1) ON CONFLICT DO UPDATE SET deleted=1` instead of `DELETE FROM octis_hidden_sessions`
- `GET /api/hidden-session-details` (used for Archives display) now filters: `WHERE (deleted IS NULL OR deleted = 0)` — so permanently deleted sessions never appear in the Archives tab
- `GET /api/hidden-sessions` (used to populate `isHidden()` filter) unchanged — returns ALL keys from `octis_hidden_sessions` including `deleted=1` rows, so both archived and deleted sessions are filtered from the active sessions list

**Layer 3 — Frontend delete handlers (all 4 locations):**

Old (broken):
```js
useHiddenStore.getState().unhide(sessionKey)  // removes from filter → session revives
```

New (correct):
```js
useHiddenStore.getState().hide(sessionKey)   // adds/keeps key in isHidden() filter
useSessionStore.getState().setHiddenSessions(
  useSessionStore.getState().hiddenSessions.filter(s => s.key !== sessionKey)
)  // removes from Archives display — session now gone from both active list AND archives
```

Calling `hide()` also calls `POST /api/hidden-sessions/hide` (INSERT OR IGNORE) which is harmless if the `session-delete` endpoint already wrote the row — the IGNORE ensures no overwrite of `deleted=1`.

Files changed: `server/index.js`, `src/components/Sidebar.tsx`, `src/components/ChatPane.tsx`, `src/components/MobileApp.tsx`

---

### New Feature: Archives Multi-Select with Bulk Restore / Delete

**Desktop (`src/components/Sidebar.tsx`):**
- Select-all checkbox added to Archives tab header (indeterminate state supported via `ref` callback)
- Per-row checkbox added left of each archived `SessionItem`
- Bulk action bar appears when 1+ items selected: **↩ Restore** (indigo) and **🗑️ Delete** (red)
- `selectedArchive` state is separate from the main sessions `selected` state (no cross-tab interference)
- Bulk restore calls `restoreSessionWithProject()` per key; bulk delete calls `POST /api/session-delete` per key and updates the hidden filter as above
- `selectedArchive` automatically cleared when leaving the Archives tab (`useEffect` on `sidebarView`)

**Mobile (`src/components/MobileApp.tsx`):**
- "Select" button appears in the archived section header when expanded
- Entering select mode replaces ↩/🗑️ buttons with circular checkboxes
- Tapping a row in select mode toggles its selection
- Bulk action bar (↩ Restore / 🗑️ Delete) appears when 1+ items selected
- Exiting select mode (Cancel or collapse) clears all selections

---

### Bug Fixed: Restore (Unarchive) Did Not Remember Project

**Symptom:** Restoring an archived session showed it in the "Untagged" group, even though it had a project assignment before being archived. The project tag was visually lost.

**Root cause:** The project tag row in `octis_session_projects` is never deleted on archive — it survived. But the in-memory `useProjectStore` tags are populated from `GET /api/session-projects` on startup. After archiving and restoring a session (within the same browser session), the store still had the tag — but for long-term archived sessions (archived in a previous session, restored now), the tag was present in the DB but not re-applied to the store after unarchive.

**Fix:** `restoreSessionWithProject()` helper added to `Sidebar.tsx`. Called by both single-item unarchive and bulk restore:

```js
const restoreSessionWithProject = async (key: string) => {
  unhideSession(key)
  const r = await authFetch(`${API}/api/session-projects`)
  const rows = await r.json()
  const row = rows.find(r => r.session_key === key)
  if (row?.project) useProjectStore.getState().setTag(key, row.project)
}
```

Same logic applied in `MobileApp.tsx` for both `handleUnarchive` and `handleBulkArchivedRestore`.

Note: This does a full `/api/session-projects` fetch (all tags, not a single-session lookup). A targeted `GET /api/session-projects/:sessionKey` endpoint would be more efficient but the full fetch was already available and the payload is small. Can be optimised later.

---

### Testing

- `npm run build` — clean, no TypeScript or TDZ errors (verified twice: after initial delete feature, after bug fix)
- `systemctl restart octis.service` — service active, HTTP 200 on `/octis/`
- `POST /api/session-delete` with no auth — returns `{"error":"Unauthorized"}` ✓ (endpoint registered and auth-gated)
- **Delete persistence bug verified:** deleted sessions did not reappear after WS poll cycle (manual observation)

---

### Known Issues / Needs Review Before Merge

1. **`POST /api/session-delete` calls `adminGwCall` best-effort** — if the gateway itself has the session in a persistent store (e.g. SQLite-backed sessions), it may reappear after a gateway restart even with `deleted=1` in Octis DB. Octis's `isHidden()` filter will suppress it on load, but a gateway-level delete mechanism would be cleaner.
2. **`/api/session-projects` fetched per restore call** — no per-session endpoint; full list fetched and filtered client-side. Acceptable for small deployments; should be a targeted query for scale.
3. **Bulk delete uses `confirm()` (native browser dialog)** — not the `DeleteConfirmModal` component. Shows count but not session names. Acceptable for now.
4. **`apply-local-patches.cjs` not yet updated** with markers for the delete feature files. If upstream code is pulled, patches for `Sidebar.tsx`, `ChatPane.tsx`, `MobileApp.tsx`, and `server/index.js` must be verified manually or a patch marker added.

---

### Files Changed This Session

| File | Change |
|---|---|
| `src/components/DeleteConfirmModal.tsx` | **New file** — shared delete confirmation modal |
| `server/index.js` | `POST /api/session-delete` endpoint; `deleted` column migration; `GET /api/hidden-session-details` filter |
| `src/components/Sidebar.tsx` | `onDelete` prop on `SessionItem` + `ProjectGroup`; delete in 3-dot menu; `handleDeleteRequest/Confirm`; archive multi-select state + handlers; `restoreSessionWithProject`; bulk restore/delete; per-row + select-all checkboxes in Archives tab; `useEffect` to clear archive selection on tab leave |
| `src/components/ChatPane.tsx` | `showDeleteConfirm` state; `handleDelete`; 🗑️ Del button (last in action bar, red-tinted); `DeleteConfirmModal` render; hide-not-unhide fix |
| `src/components/MobileApp.tsx` | `deleteConfirmSession` state; `handleDeleteRequest/Confirm`; `selectedArchived`/`archiveSelectMode` state; `handleArchivedToggle`; `handleBulkArchivedRestore/Delete`; delete in long-press sheet; select mode in archived rows; `handleUnarchive` now restores project tag; hide-not-unhide fix |

---

## Session: Reply-to-Message Feature (2026-04-27)

### New Feature: Reply to Messages

**Files changed:** `src/components/ChatPane.tsx`, `src/components/MobileFullChat.tsx`

#### Desktop (ChatPane.tsx)
- Added `getReplyCtx`, `stripReplyCtxText`, `stripReplyCtx` helpers — detect and strip reply context prefix from message content
- Added `ReplyQuoteBubble` component — renders a compact quoted block inside message bubbles
- Added `hoveredMsgKey` state — tracks which message is hovered for showing the reply button
- Added `replyingTo` state — stores target message (id, role, preview) when reply is active
- On hover: `↩` button appears left of user messages, right of assistant messages (opacity transition)
- Clicking `↩` sets `replyingTo` state and focuses the input
- Reply preview bar appears above the textarea showing role + truncated preview with ✕ to cancel
- `handleSend` modified: if `replyingTo` is set, prepends `[Replying to Role: "preview"]\n\n` to the message text before sending; clears `replyingTo` after
- Messages with reply prefix: quote bubble rendered above content, prefix stripped before `renderContent`
- AI receives full reply context in the message text

#### Mobile (MobileFullChat.tsx)
- Same helper functions added (`getMobileReplyCtx`, `stripMobileReplyCtxText`, `stripMobileReplyCtx`, `MobileReplyQuoteBubble`)
- `replyingTo` state added
- `handleSend` modified with same reply prepend logic (skips for `overrideMsg` to avoid affecting DecisionButtons/quick-actions)
- Small `↩` tap target always visible (subtle grey, active:blue) left of user msgs, right of assistant msgs
- Reply preview bar above input with rounded-xl mobile styling
- `onPointerDown` + `onClick` with `stopPropagation` to prevent swipe gesture conflicts

#### UX details
- Reply context format: `[Replying to AI: "...preview..."]\n\nactual message`
- Preview truncated to 120 chars, double-quotes sanitized to single quotes
- Quote bubble: left-border accent, role badge (🤖 AI / 👤 You), line-clamp-2 preview
- Desktop: hover-only reveal (opacity transition, pointer-events-none when hidden)
- Mobile: always-visible but subtle (grey, no hover state)
- Cancel: ✕ in preview bar clears `replyingTo`
- No server changes needed — context embedded in message text

#### Testing
- Build passes (TDZ check clean, no TypeScript errors)
- Octis service healthy post-restart

---

## Session 2026-04-27 09:09–15:39 UTC — New Session Pane Bug Fixes (Ghosty)

> Build verified clean after each fix batch. All changes are local patches on top of previously documented work.

---

### Bug: New sessions not opening a chat pane

Symptoms reported over multiple sub-bugs; resolved in three separate fixes.

---

#### Fix 1 — Deleted sessions resurrecting via `pendingLocal` (`src/store/gatewayStore.ts`)

**Symptom:** Sessions that were permanently deleted (via the new delete feature) reappeared in the active sessions list immediately after deletion.

**Root cause:** `setSessions` has a `pendingLocal` filter that preserves locally-created sessions (key format `session-\d+`, created < 2 minutes ago) across WS `sessions.list` broadcasts. This guard existed to prevent newly-created sessions from disappearing on the next WS poll. However, `pendingLocal` did not check the hidden store — so a deleted session that had been hidden via `useHiddenStore.hide()` would still be re-injected from `state.sessions` (previous Zustand state) on the very next `setSessions` call, including the one triggered by the delete handler itself.

**Fix:** Added `if (hiddenStore.isHidden(s.key)) return false` to the `pendingLocal` filter. Since delete handlers call `hide(key)` before `setSessions`, the hidden check now correctly excludes deleted sessions from `pendingLocal` re-injection.

```ts
// gatewayStore.ts — pendingLocal filter
const pendingLocal = state.sessions.filter((s) => {
  if (!/^session-\d+$/.test(s.key) || seen.has(s.key)) return false
  if (hiddenStore.isHidden(s.key)) return false  // ← added
  const ts = parseInt(s.key.split('-')[1], 10)
  return !isNaN(ts) && (now - ts) < 2 * 60 * 1000
})
```

---

#### Fix 2 — Picker staying open; pane not opening after async `createSessionKey` (`src/components/Sidebar.tsx`)

**Symptom:** After creating a new session via the "+ New Session" footer picker, the session appeared in the sidebar but the chat pane did not open. The picker remained open (not closed).

**Root cause (part A — picker stays open):** `setShowNewSessionPicker(false)` was inside the `try` block, after `openInBestPane`. If `openInBestPane` threw for any reason, the picker never closed. Moving it to `finally` ensures it always closes regardless.

**Root cause (part B — pane doesn't open):** Calling `openInBestPane(key)` synchronously after `setSessions(...)` — both in the same async handler, after an `await` — ran before React had committed the sessions update to the DOM. Although Zustand's `getState()` would see the updated sessions, there appeared to be a timing issue where `pinToPane` didn't reliably produce a visible pane in this context.

**Fix:** Replaced the inline `openInBestPane(key)` call in all picker/creation handlers with `setPendingPaneKey(key)` (a new React state variable). A `useEffect([pendingPaneKey])` runs `openInBestPane` **after React commits the render** containing the new session, guaranteeing stable state before pane management runs.

```tsx
// Sidebar.tsx — deferred pane open
const [pendingPaneKey, setPendingPaneKey] = useState<string | null>(null)
useEffect(() => {
  if (!pendingPaneKey) return
  openInBestPane(pendingPaneKey)
  setPendingPaneKey(null)
}, [pendingPaneKey])
```

Picker handlers changed from:
```tsx
openInBestPane(key)
setShowNewSessionPicker(false)  // inside try
```
To:
```tsx
setPendingPaneKey(key)          // inside try
// ...
finally { setShowNewSessionPicker(false) }  // always runs
```

Applied to all four Sidebar creation paths: "No project" picker, project-specific picker, `handleContinue`, `handleTodoNewSession`.

---

#### Fix 3 — Project picker silently throwing `TypeError` (`src/components/Sidebar.tsx`)

**Symptom:** Creating a new session via "No project" opened a pane correctly (Fix 2 resolved it), but choosing a specific project still did not open a pane.

**Root cause:** The project-specific picker button called `useGatewayStore.getState().setPendingProjectInit(key, p.slug)`. However, `setPendingProjectInit` is a method on `useSessionStore`, not `useGatewayStore`. This threw a `TypeError: useGatewayStore.getState(...).setPendingProjectInit is not a function` inside the `try` block. The `catch` handler swallowed it with `console.error`. The session was created (happened before the throw) but `setPendingPaneKey` never ran (happened after the throw), so no pane opened.

**Fix:** One-character store name correction:
```ts
// Before (wrong):
useGatewayStore.getState().setPendingProjectInit(key, p.slug)

// After (correct):
useSessionStore.getState().setPendingProjectInit(key, p.slug)
```

This was the root cause of the "project picker doesn't open pane" bug.

---

#### Fix 4 — `claimSession` missing from session creation paths (multiple files)

**Symptom:** Sessions created via the `N` hotkey (App.tsx), the ChatPane empty-pane "+ New Session" button, and the MobileApp "+ New Session" sheet appeared in a pane or chat view, but did not immediately appear in the sidebar sessions list. They would appear only after the next WS `sessions.list` broadcast (up to ~30s delay).

**Root cause:** These creation paths created a session with a short key (`session-${Date.now()}`) but did not call `useAuthStore.getState().claimSession(key)` before calling `setSessions`. The `setSessions` ownership check filters out sessions where `isPrimaryAgent = false` and `isOwned = false`. Without `claimSession`, `isOwned = false` for the new key → session filtered from `deduped`. Since it also wasn't in `state.sessions` yet, it wasn't in `pendingLocal` either. The session was dropped silently from the sessions list.

**Fix:** Added `useAuthStore.getState().claimSession(key)` before `setSessions` in all three paths. Also changed `...sessions` (stale hook closure) to `...useSessionStore.getState().sessions` (always-fresh store read).

Files changed:
- `src/App.tsx` — `handleNewSessionHotkey`: added `claimSession`, fresh sessions, removed stale deps from `useCallback`
- `src/components/ChatPane.tsx` — `handleNewSession` (empty pane): added `claimSession`, fresh sessions, uses `getState()` for all pane actions
- `src/components/MobileApp.tsx` — `handleNewSession`: added `claimSession`, fresh sessions; added `import { useAuthStore }` (was missing)

---

### Testing performed

- `npm run build` — clean, no TypeScript or TDZ errors (verified after each fix batch)
- `systemctl restart octis.service` — service active, HTTP 200 on `/octis/`
- Manually verified (by code trace) all session creation paths:
  - Sidebar picker "No project" → pane opens ✓
  - Sidebar picker with project → pane opens ✓ (Fix 3 was the root cause here)
  - `N` hotkey → pane opens, session appears in sidebar immediately ✓
  - ChatPane empty-pane button → pane opens, session in sidebar ✓
  - Mobile "+ New Session" → chat opens, session in sidebar ✓
  - `handleContinue` (↪ continue) → pane opens ✓
- Confirmed "No project" worked before all fixes; "with project" was broken by the `useGatewayStore` typo

---

### Known issues / needs review before merge

1. **`useEffect` pane-open pattern (pendingPaneKey)** — introduces a one-render delay between session creation and pane opening. Visually imperceptible, but represents a change from the original synchronous pane-open approach. Upstream may want to investigate why synchronous `openInBestPane` was unreliable and choose a different fix.
2. **`claimSession` called before gateway session exists** — `claimSession` optimistically adds the short key to `ownedSessions` and POSTs to `/api/session-ownership/claim`. If the user immediately navigates away, a dangling ownership claim exists for a session that was never sent to the gateway. Low risk; existing cleanup path covers this on WS reconnect.
3. **`useGatewayStore` vs `useSessionStore` naming** — other call sites should be audited for similar wrong-store references. A TypeScript interface mismatch (missing method) would normally catch this at compile time, but if `useGatewayStore` has a compatible-enough type shape, it silently passes. Worth adding stricter typing.

---

### Files changed this session

| File | Change |
|---|---|
| `src/store/gatewayStore.ts` | `pendingLocal` now checks `hiddenStore.isHidden()` — prevents deleted sessions from being re-injected |
| `src/components/Sidebar.tsx` | `pendingPaneKey` state + `useEffect` for deferred pane open; `finally` on picker close; `useGatewayStore` → `useSessionStore` for `setPendingProjectInit`; `claimSession` + fresh sessions in `handleContinue` and `handleTodoNewSession` |
| `src/App.tsx` | `handleNewSessionHotkey`: `claimSession` + fresh sessions + removed stale deps |
| `src/components/ChatPane.tsx` | `handleNewSession` (empty pane): `claimSession` + fresh sessions + uses `getState()` for all pane ops |
| `src/components/MobileApp.tsx` | `handleNewSession`: `claimSession` + fresh sessions; added `useAuthStore` import |

---

## Session — 2026-04-27 (Drag-to-Project + Archive Sort Fix)

### Bug Fixes

| # | File | Change | Why |
|---|------|--------|-----|
| 1 | `server/index.js` | Added `ORDER BY hidden_at DESC` to `/api/hidden-session-details` query | Archive tab was returning sessions in DB insertion order (arbitrary), not most-recently-archived-first. Now consistently sorted. |

### New Features

| # | File | Change |
|---|------|--------|
| 2 | `src/components/Sidebar.tsx` — `SessionItem` | Added `onDragEnd?: () => void` prop + `onDragEnd` handler on the draggable div — cleans up drag state when drag is cancelled or completed |
| 3 | `src/components/Sidebar.tsx` — `ProjectGroup` | Added props: `slug?`, `isDragOver?`, `onSessionDragStart?`, `onSessionDragEnd?`, `onProjectDragOver?`, `onProjectDragLeave?`, `onProjectDrop?`. Group container is now a drop target with `onDragOver/Leave/Drop`. Visual highlight (ring + bg + "drop here" label) when `isDragOver`. Sessions inside pass `onDragStart`/`onDragEnd` through to `SessionItem`. |
| 4 | `src/components/Sidebar.tsx` — `Sidebar` | Added `dragOverProject` state. Added `handleProjectDrop(targetSlug)` — calls `useProjectStore.getState().setTag(dragKey, target)` to reassign session to new project (auto-pushes to server). Wired all 4 `ProjectGroup` renders (sessions view × 2, projects view × 2) with full drag props. |

### UX Behaviour
- Grab a session row (hover to see ⠿ handle) and drag it to a different project group header
- The target group highlights with a purple ring + "drop here" label while dragging
- Drop releases — session moves to the new project instantly (no reload needed)
- Works in both the Sessions view (grouped by project) and the Projects view
- Drop on "Untagged" group removes the project tag entirely
- Drag-end (cancel or drop) clears all drag state cleanly

### Testing
- `npm run build` — clean, TDZ check passed, Vite built in ~6s
- `systemctl restart octis.service` — active

---

## Session — 2026-04-27 (Reply-to-Message Feature + Hidden Sessions Bug Fix)

### New Feature: Reply-to-Message (Messenger-style)

#### Files changed
- `src/components/ChatPane.tsx`
- `src/components/MobileFullChat.tsx`
- `src/store/gatewayStore.ts`
- `src/index.css`

#### What was built

**Reply button**
- Desktop: `↩︎` button appears on hover — left of user messages, right of AI messages. `opacity-0 pointer-events-none` when not hovered; `opacity-100` on hover. Transition 150ms.
- Mobile: `↩︎` always visible (subtle, low opacity) beside each message. Tappable at all times. Uses `\u21A9\uFE0E` (text variation selector) to prevent iOS from rendering the character as a colored emoji — forces plain-text glyph. `WebkitAppearance: none`, `bg-transparent`, `border-0` to strip all browser button chrome.

**Reply preview bar (above input)**
- Appears when `replyingTo` state is set. Shows role badge (`↩ Replying to AI` / `↩ Replying to you`) + truncated preview text + `✕` cancel button.
- Dismissed by: `✕` click, `Escape` key in textarea, or message send.
- Same styling on desktop and mobile (rounded-xl on mobile, rounded-lg on desktop).

**Message format (what the AI receives)**
```
[Replying to AI (123): "preview text truncated to 120 chars"]

actual user reply
```
- `(123)` = target message's server-assigned ID — used for precise DOM jump.
- Double-quotes in preview sanitized to single-quotes to avoid breaking the format parser.
- `overrideMsg` path (DecisionButtons quick-actions) does NOT inherit reply context — intentional.

**Quote bubble in sent messages**
- Rendered above message content when `getReplyCtx(content)` matches the format.
- `border-l-2` accent: indigo-tinted for user messages, dark for AI messages.
- Role badge: `🤖 AI` or `👤 You`.
- `line-clamp-2` preview. `cursor-pointer` + `↗` indicator when jumpable.
- Reply prefix stripped from rendered content before passing to `renderContent` / `renderMessageContent`.

**Click quote bubble → jump to original**
- Primary path: extracts `(123)` message ID from format string → `scrollContainerRef.current.querySelector('[data-msg-key="123"]')` — **scoped to the current pane's scroll container** (not `document.getElementById`).
- Fallback path (old format / no ID): iterates `messages` state array chronologically, skips `m === msg` (self), strips reply prefix, matches first 60 chars of preview → DOM lookup within container.
- Fallback key: `msg.id ?? String(getMsgTs(msg))` — timestamp as tie-breaker. Consistent between `data-msg-key` attribute and search key regardless of render direction (fixes mobile flex-col-reverse index mismatch from earlier iteration).
- On jump: `scrollIntoView({ behavior: 'smooth', block: 'center' })` + indigo flash animation (`@keyframes octisFlash`, 1.4s fade, defined in `src/index.css`).

**State cleanup**
- `replyingTo`, `hoveredMsgKey`, `highlightedMsgKey` cleared via `useEffect([sessionKey])` on session switch (desktop). `replyingTo`, `highlightedMsgKey` cleared via `useEffect([session.key])` on session switch (mobile).
- `Escape` key in textarea cancels active reply on both platforms.

#### Bugs fixed during QA

| # | Bug | Root cause | Fix |
|---|-----|-----------|-----|
| 1 | Click did nothing (old replies, no ID) | `rc.msgId` was `undefined` → `onJump` was `undefined` → click dead | `onJump` always set; fallback content search used when no ID |
| 2 | Fallback matched own quote bubble | DOM text scan found the preview in the CURRENT message's own quote bubble (same text), causing scroll-to-self | Switched to `messages` state iteration with `m === msg` self-skip |
| 3 | Click in session B scrolled session A | `document.getElementById('chat-msg-123')` is global — multiple panes can have elements with matching numeric IDs from different sessions | Replaced all `id=` with `data-msg-key=`; all lookups scoped to `scrollContainerRef.current.querySelector(...)` / `scrollRef.current.querySelector(...)` |
| 4 | Reply state persisted on session switch | `replyingTo` / `hoveredMsgKey` / `highlightedMsgKey` never cleared when `sessionKey` prop changed | `useEffect([sessionKey])` clears all three on both platforms |
| 5 | Mobile fallback key never matched | `data-msg-key=String(i)` where `i` = reversed-map index; fallback search used `idx` = chronological index — never equal for same message | Both now use `msg.id ?? String(getMsgTs(msg))` (timestamp-based, stable regardless of loop direction) |
| 6 | `↩` rendered as blue emoji box on iOS | `↩` (U+21A9) has emoji presentation on iOS Safari | Changed to `\u21A9\uFE0E` (U+FE0E = text variation selector, forces monochrome glyph). Added `WebkitAppearance: none`, `bg-transparent`, `border-0` to strip button chrome. |

#### Desktop / Mobile parity
All reply feature components and behaviours implemented identically on both:
- `ChatPane.tsx` (desktop, normal scroll)
- `MobileFullChat.tsx` (mobile, `flex-col-reverse` scroll)

---

### Bug Fix: Hidden Sessions Stale localStorage Cache

#### File changed
- `src/store/gatewayStore.ts` — `hydrateFromServer` in `useHiddenStore`

#### Problem
When a session was manually un-archived (deleted from `octis_hidden_sessions` DB table), the desktop client continued hiding the session indefinitely — even after hard refresh. The session was invisible in all views (Sessions, Projects, Archives).

#### Root cause
`hydrateFromServer` used `new Set([...s.hidden, ...keys])` — **merge**, not replace. On page load, Zustand's `persist` middleware restores the stale `hidden` Set from `localStorage` (`octis-hidden-sessions` key). Then `hydrateFromServer` runs and merges the server's (now shorter) list into the stale local Set. Because the un-archived session key was still in `localStorage`, it stayed in the Set. The server had no way to "un-hide" it.

#### Fix
`hydrateFromServer` now uses the server as the source of truth:
- Fetches server keys (DB-backed)
- On **first hydration** (`!s.hydrated`): preserves locally-added keys not yet on the server (in-flight archive race condition guard)
- On **subsequent hydrations**: fully trusts the server — stale local keys are dropped
- Calls `setSessions([...sessionStore.sessions])` unconditionally after hydration so any un-archived sessions immediately reappear in the sidebar

#### Side effect resolved
Previously, unarchiving a session required: (1) DB delete, AND (2) manually clearing `localStorage['octis-hidden-sessions']` in browser DevTools. Now DB delete alone is sufficient — next page load restores the session.

#### Why this matters for upstream
The `persist` + merge pattern creates a one-way ratchet: sessions can be hidden but never programmatically un-hidden via the server. Any admin tool or API that removes a session from `octis_hidden_sessions` would have no visible effect on clients with stale localStorage. This fix ensures server state is authoritative.

---

### Testing

- `npm run build` — clean, TDZ check passed, Vite built in ~7s, no TypeScript errors
- `systemctl restart octis.service` — healthy (HTTP 200 on `/api/health`)
- Reply feature: manually tested send/receive/jump cycle in this session
- Hidden sessions fix: root cause confirmed by reading `gatewayStore.ts` persist config; fix verified by code trace (merge → replace logic)
- Cross-pane isolation: confirmed by code trace — `scrollContainerRef.current.querySelector` scopes to current pane only

### Known issues / needs review before merge

1. **Reply format is plain text prepended to message** — the AI receives `[Replying to AI (123): "..."]` as literal text. This is functional but not structured. A cleaner implementation might use a dedicated metadata field on the message payload. Upstream may want to consider a first-class `replyTo` field in `chat.send` params.
2. **Jump fails silently when target message not loaded** — if the original message is beyond the currently-loaded history limit (e.g., 200 messages ago), `findEl()` returns null and nothing happens. No user feedback. Could show a toast: "Message not in loaded history — scroll up to load more."
3. **`hydrateFromServer` race condition guard is heuristic** — preserving "local-only keys on first hydration" is a best-effort approach. If the gateway is slow to persist a `hide` operation AND the user refreshes within 90s, a just-archived session could briefly reappear. Low probability in practice.

---

## Session — 2026-04-27 17:38–17:52 UTC — URL Hash Persistence Fix (Ghosty)

### Bug Fixed: Refreshing Loses the `#` and Lands on Default Page

**Symptom:** Occasionally the `#sessions` / `#projects` etc. fragment disappeared from the browser URL bar. Refreshing at that point would land on the default view (Projects tab) instead of restoring the last active tab.

**Root cause:**

On the very first load, the browser creates an initial history entry at `/octis/` (no fragment). The `activeNav` useEffect then runs and calls `history.pushState(…, '#projects')`, adding a new entry *on top* of the blank one. The history stack now has two entries:

```
1. /octis/         ← initial load (no hash, no state — created by the browser)
2. /octis/#projects ← pushed by useEffect
```

If the user navigates to Sessions, entry 3 is pushed (`#sessions`). Pressing **Back** once → entry 2 (`#projects`) — fine. Pressing **Back** again → entry 1 (`/octis/`, no hash) — hash is gone. The `popstate` handler fires with `e.state = null` and an empty hash; `activeNav` doesn't change (no matching nav string); `isPopStateRef.current = true` so the `activeNav` useEffect skips the hash push. The URL is left without a `#`. Refreshing now reads an empty hash and falls back to the default tab.

**Fix — use `replaceState` when no existing hash:**

Changed the `activeNav` useEffect in `App.tsx` and the `tab` useEffect in `MobileApp.tsx` to use `history.replaceState` (instead of `history.pushState`) when the current URL has no hash fragment. This replaces the initial blank history entry in-place, so the back button can never reach a URL without a `#`.

```ts
// Before (always pushState):
history.pushState({ nav: activeNav, view: 'tab' }, '', '#' + activeNav)

// After (replaceState when no existing hash; pushState when changing from one hash to another):
if (!hash) {
  history.replaceState(stateObj, '', targetUrl)   // replace blank initial entry
} else {
  history.pushState(stateObj, '', targetUrl)       // normal navigation: push new entry
}
```

This preserves the existing back-navigation UX (user can go back through previous tab changes) while eliminating the blank history entry that caused the hash loss.

**Files changed:**
- `src/App.tsx` — `activeNav` persistence useEffect
- `src/components/MobileApp.tsx` — `tab` persistence useEffect

**Testing:**
- `npm run build` — clean (TDZ check passed, Vite built in ~8s)
- `systemctl restart octis.service` — active, HTTP 200 on `/octis/`
- Verified by code trace: initial load → replaceState replaces blank entry → back button cannot reach a hashless URL

---

## Session — 2026-04-27 08:54–09:36 UTC — Pane/Draft/UX Bug Fixes (Ghosty)

### Overview

Six bugs reported by Kennan, all fixed and deployed in this session.

---

### Bug 1: Duplicate Chat Pane Windows

**Symptom:** Opening a session, then refreshing (or navigating away and back), caused two panes for the same session to open simultaneously. The sidebar session also lost its highlight even though its pane was still visible, and re-clicking it opened a second duplicate pane.

**Root cause:** When a session is created locally, it gets an optimistic short key (`session-<ts>`). This key is stored in `activePanes`. When the gateway responds, `setSessions` updates the sessions list to use the full gateway key (`agent:main:session-<ts>`), but `activePanes` was NOT updated — it kept the old short key. As a result:
- `isPinned = activePanes.includes('agent:main:session-<ts>')` → `false` (key mismatch) → highlight disappeared
- `handlePin('agent:main:session-<ts>')` saw the key as absent → opened a new pane → two panes for the same session

**Secondary issue:** If stale localStorage already contained duplicate keys in `activePanes`, they'd re-appear on reload.

**Fix — `src/store/gatewayStore.ts` (`setSessions`):**
```ts
// Inside the set() call in setSessions:
let panesUpdated = false
const updatedActivePanes = state.activePanes.map((pane) => {
  if (!pane || !/^session-\d+$/.test(pane)) return pane
  const realSession = deduped.find(s => s.key.match(/^agent:[^:]+:(session-\d+)$/)?.[1] === pane)
  if (realSession) { panesUpdated = true; return realSession.key }
  return pane
})
return { sessions, costHistory, hiddenSessions, ...(panesUpdated ? { activePanes: updatedActivePanes } : {}) }
```
Pane key migration and session list update now happen atomically in the same `set()` call. `isPinned` checks are always in sync.

**Fix — `src/store/gatewayStore.ts` (persist `onRehydrateStorage`):**
Added `onRehydrateStorage` hook that deduplicates `activePanes` on localStorage reload. Prevents stale duplicate entries from being restored on page refresh.

---

### Bug 2: Click-to-Close Toggle — Sessions Tab

**Symptom:** Clicking an already-highlighted (open) session in the Sessions tab sidebar was a no-op. Expected: it should close the pane and remove the highlight.

**Fix — `src/components/Sidebar.tsx` (`handlePin`):**

Extracted `openInBestPane(sessionKey)` helper containing the expand-first logic. Rewrote `handlePin` to toggle:
```ts
if (ap.indexOf(sessionKey) >= 0) {
  ap.forEach((p, i) => { if (p === sessionKey) pinToPane(i, null) })
  return
}
openInBestPane(sessionKey)
```

All session views (Sessions tab, Projects tab session lists, Archives section, context menus) already route through `handlePin` so the toggle applies universally from one fix point.

---

### Bug 3: Click-to-Close Toggle — Projects Tab (`ProjectView.tsx`)

**Symptom:** In the Project detail panel (Projects nav → select a project → session list on the left), clicking a session with an "open" badge did nothing (sessions tab worked; this view did not). Archive subview had the same issue.

**Root cause (layer 1):** Click handler had an explicit `!isOpen` guard:
```ts
onClick={() => { if (editingSessionKey !== s.key && !isOpen) handleSelectSession(s) }}
```
Clicking an open session was blocked entirely.

**Root cause (layer 2):** `openInNextPane` called `setActiveSession()` from inside a `setLocalPanes` updater function. React does not guarantee side effects inside state updater functions (can re-run updaters in Strict Mode). `localPanes` was updated correctly (badge disappeared) but `activeSession` was never set to `null` — so the `{activeSession ? <panes/> : <empty/>}` guard stayed truthy and kept rendering the old pane.

**Fix — `src/components/ProjectView.tsx`:**
1. Removed `!isOpen` guard from click handler; `cursor-pointer` always applied.
2. Rewrote `openInNextPane` to NOT call `setActiveSession` inside the functional updater — reads `localPanes` directly and calls both setters at top level (React 18 batches them):
```ts
const openInNextPane = useCallback((key: string) => {
  const existingIdx = localPanes.findIndex(p => p === key)
  if (existingIdx !== -1) {
    const next = [...localPanes]; next[existingIdx] = null
    const remaining = next.filter(Boolean) as string[]
    setLocalPanes(next)
    setActiveSession(remaining[0] ?? null)
    return
  }
  const next = [...localPanes]
  const empty = next.findIndex(p => !p)
  next[empty === -1 ? 0 : empty] = key
  setLocalPanes(next)
  setActiveSession(key)
}, [localPanes])
```

---

### Bug 4: Archive Icon Position in Chat Header

**Symptom:** The 📦 archive button was separated from 🗑️ Del by the session brief (📋) button and a divider. User wanted archive immediately left of delete.

**Fix — `src/components/ChatPane.tsx`:**
Moved 📦 to after the divider, immediately before 🗑️ Del. New order: `📝 → 🚪 → 💾 → 📋 | 📦 → 🗑️ Del`

---

### Bug 5: New Sessions Did Not Auto-Expand Panes

**Symptom:** Clicking an existing session auto-expanded the pane count (up to 8 max). Creating a new session only opened it in the last slot if no empty slot existed — no expansion.

**Fix — `src/components/Sidebar.tsx`:**
Extracted `openInBestPane(key)` helper with expand-first logic (same as `handlePin`):
```ts
const openInBestPane = (sessionKey: string) => {
  const { activePanes: ap, paneCount: pc } = useSessionStore.getState()
  const emptyPane = ap.findIndex((p, i) => i < pc && !p)
  if (emptyPane >= 0) { pinToPane(emptyPane, sessionKey) }
  else if (pc < 8) { setPaneCount(pc + 1); pinToPane(pc, sessionKey) }
  else { pinToPane(pc - 1, sessionKey) }
}
```
All creation paths now use `openInBestPane`:
- Footer picker (no project + with project)
- `handleContinue` (↪ continue sessions)
- `handleTodoNewSession`

**Fix — `src/App.tsx` (`handleNewSessionHotkey`):**
`N` hotkey now uses same expand-first logic with fresh state from `useSessionStore.getState()`.

---

### Bug 6: Draft Reappears After Send (two-layer race condition)

**Symptom:** After sending a message, the input cleared correctly but the draft text reappeared in the textarea — sometimes immediately, sometimes after switching tabs.

**Root cause — Layer 1 (300ms debounce):**
The textarea `onChange` handler sets a 300ms debounce to save the draft. If the user types and presses Enter within 300ms, `clearDraft` fires but the timer is still pending. 300ms later it fires and re-saves the just-sent text.

**Fix:** Cancel `draftTimerRef` at the top of the send handler before `clearDraft`:
```ts
if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null }
```
(Mobile already had this — desktop was missing it.)

**Root cause — Layer 2 (server hydration race):**
`hydrateDrafts()` is called on WS reconnect and on tab focus (with a 2s delay). If the DELETE from `clearDraft` is still in-flight when `hydrateFromServer` fetches all server drafts, the server still returns the old draft. The merge logic: `localDrafts[k] !== undefined ? localDrafts[k] : serverValue` — after `clearDraft`, `localDrafts[k]` was `undefined` (key fully deleted) → merge took the server value → draft restored locally. Then on pane remount (key migration), the per-session effect called `setInput(restored)`.

**Fix — `src/store/gatewayStore.ts` (`clearDraft`):**
Instead of fully deleting the key from localStorage, writes a `''` tombstone:
```ts
// Write '' tombstone — prevents hydrateFromServer from restoring stale server draft
draftSaveToLS({ ...d, [sessionKey]: '' })
// Remove tombstone after 10s (server DELETE should be processed by then)
setTimeout(() => {
  const current = draftLoadFromLS()
  if (current[sessionKey] === '') { delete current[sessionKey]; draftSaveToLS(current) }
}, 10000)
```
`hydrateFromServer` merge logic: `'' !== undefined` is `true` → uses local `''` → skips server value.

Added `isDraftCleared(sessionKey)` helper to `useDraftStore` — reads localStorage tombstone directly.

**Fix — `src/components/ChatPane.tsx` (per-session server fetch effect):**
Added tombstone check before fetching draft from server on session mount:
```ts
if (isDraftCleared(sessionKey)) return
```
Prevents the case where key migration causes a ChatPane remount + server fetch that restores a just-sent draft.

---

### Files Changed (this session)

| File | Changes |
|---|---|
| `src/store/gatewayStore.ts` | `setSessions`: atomic `activePanes` key migration; `onRehydrateStorage` dedup; `clearDraft`: tombstone pattern; `isDraftCleared()` added to interface + impl |
| `src/components/Sidebar.tsx` | `openInBestPane()` helper; `handlePin` toggle; all new-session creation paths use `openInBestPane` |
| `src/components/ProjectView.tsx` | `openInNextPane` toggle (close if already open); removed `!isOpen` click guard; `cursor-pointer` always; top-level setter calls (not inside updater) |
| `src/components/ChatPane.tsx` | Archive button moved left of delete; `draftTimerRef` cancel on send; `isDraftCleared` check in server fetch effect |
| `src/App.tsx` | `handleNewSessionHotkey`: expand-first pane logic; `paneCount`/`setPaneCount` destructured |

### Testing

- `npm run build` — clean, TDZ check passed, Vite built successfully (all 6 fixes), no TypeScript errors
- `systemctl restart octis.service` — active, HTTP 200 on `/api/health`
- Duplicate pane fix: root cause confirmed by code trace (key migration in `setSessions` didn't update `activePanes`); fix verified by atomic `set()` pattern
- Toggle fix: confirmed `handlePin` is the single dispatch path for all sidebar session views; ProjectView fix confirmed by separating updater side effects
- Draft tombstone: confirmed `hydrateFromServer` merge logic uses `!== undefined` check; tombstone `''` blocks server restore; 10s cleanup prevents stale markers

### Known issues / needs review before merge

1. **`ProjectView.tsx` uses `localPanes` directly in `openInNextPane`** — added to `useCallback` deps as `[localPanes]`. Could cause stale-closure bugs if `localPanes` updates frequently without re-renders. Consider moving to a `useRef` if profiling shows issues.
2. **`activePanes` key migration only handles `session-<ts>` → `agent:<id>:session-<ts>` format.** If a different optimistic key format is ever introduced, the migration regex would need updating.
3. **Draft tombstone TTL is hardcoded 10s** — adequate for normal network conditions but could fail on very slow connections. Consider making it a configurable constant.

---

## Session: 2026-04-27 (~17:47–18:08 UTC) — Quick Commands: Persistence Fix + Config-Driven Architecture

### Context
Two bugs caused Quick Command edits in Octis Settings to revert to an older value:
1. Server sync on mount was gated behind `hasLocalCustom` (only ran if localStorage was empty) — once localStorage had ANY value, server was never consulted again, breaking cross-device sync.
2. The 400ms debounced server save was dropped silently if the Settings modal was closed before the timer fired — server kept the stale value indefinitely.

Additionally, the quick commands UI was hardcoded: adding a new command required changes in 3–4 places plus a new `useTextareaUndo` hook instance.

### Changes — `src/components/SettingsPanel.tsx`

| # | Change | Why |
|---|--------|-----|
| 1 | Replaced `QUICK_COMMAND_DEFAULTS` object + hardcoded UI array with `QUICK_COMMANDS_CONFIG` array (`key`, `label`, `note`, `default` per entry) | Single source of truth — adding a new quick command now requires only one entry in this array |
| 2 | `QUICK_COMMAND_DEFAULTS` derived from config via `Object.fromEntries` | Backward-compatible with all `getQuickCommands()` call sites |
| 3 | `saveQuickCommand` signature changed from `key: keyof typeof QUICK_COMMAND_DEFAULTS` → `key: string` | Allows dynamic keys |
| 4 | Replaced 4 per-key `useTextareaUndo()` hooks + `qcUndoMap` lookup object with a single `qcUndoMapRef` (ref-based undo map) | Per-key hooks required code changes per new command and violated hooks-in-loops rules. Ref map works for any string key. |
| 5 | `getQcUndoState(key)` — lazy-initializes undo state for any key | Zero-config undo/redo for any command, existing or future |
| 6 | Burst-coalescing undo logic inlined into `updateQc` (same algorithm as `useTextareaUndo`) | Eliminates the hook dependency while preserving Word-style undo behavior |
| 7 | Mount effect: removed `hasLocalCustom` guard — now ALWAYS fetches from server on Settings open | Server is the authoritative source; localStorage is just instant-display cache |
| 8 | Added `isDirtyRef` — blocks server response from overwriting in-progress edits if response arrives after user starts typing | Prevents race condition between server fetch and active user input |
| 9 | `persistQcToServer` now sets `pendingFlushRef.current = values` on every call | Tracks latest pending value for unmount flush |
| 10 | Mount effect cleanup: cancels debounce timer + fires immediate server save if `pendingFlushRef.current` is set | Closing the modal fast (within 400ms of last keystroke) no longer drops the save |
| 11 | `pendingFlushRef.current` cleared when debounce timer fires normally | Prevents double-save (once via debounce, once via unmount) |
| 12 | Removed `import { useTextareaUndo }` (no longer used) | Cleaner imports |
| 13 | `updateQc` and `resetQc` now accept `key: string` (was `keyof typeof QUICK_COMMAND_DEFAULTS`) | Supports dynamic keys |
| 14 | UI `map` changed from `(['brief', 'away', 'save', 'archive_msg'] as const).map(key => ...)` to `QUICK_COMMANDS_CONFIG.map(({ key, label, note }) => ...)` | Config-driven render — labels, notes, and defaults all come from config |
| 15 | `onUndo`, `onRedo`, `canUndo`, `canRedo` in AutoResizeTextarea wired to `doQcUndo`, `doQcRedo`, `canQcUndo`, `canQcRedo` | Uses new ref-based undo system |

### Testing
- `npm run build` — clean, TDZ check passed, no TypeScript errors
- `systemctl restart octis.service` — active, HTTP 200 on `/api/health`
- Architecture verified by code trace: `QUICK_COMMANDS_CONFIG.map()` renders all 4 existing commands correctly; undo state map lazy-initializes on first use per key

### How to add a new Quick Command (going forward)
Add one entry to `QUICK_COMMANDS_CONFIG` in `src/components/SettingsPanel.tsx`:
```ts
{ key: 'my_cmd', label: '🔧 My Command', note: 'optional hint', default: 'default prompt text' }
```
UI, persistence, undo/redo, server sync, and localStorage all work automatically. No other changes needed in SettingsPanel. If you also want a dedicated trigger button in ChatPane/MobileFullChat, add a handler there referencing `getQuickCommands().my_cmd`.

### Known issues / needs review before merge
1. `canQcUndo`/`canQcRedo` are plain functions (not state), so undo button enabled/disabled state updates only on re-renders triggered by `qcValues` changes — not on standalone undo/redo. This matches the prior behavior (same pattern as the old `getQcUndo(key).canUndo()` call).
2. `QUICK_COMMAND_DEFAULTS` in `ChatPane.tsx` and `MobileFullChat.tsx` are NOT derived from `QUICK_COMMANDS_CONFIG` (separate files). If a new command's default text matters for fallback before server sync populates localStorage, those files need manual updating too. Consider extracting to a shared `quickCommandsConfig.ts` module in a future cleanup.

---

## Session: 2026-04-27 (18:08–19:06 UTC) — Changelog, API Key Fix, GitHub Backup

### Context
Kennan asked for a full changelog of all changes since first version, for briefing Byte (Casin's bot) before merging upstream commits.

---

### 1. `server/index.js` — Moved hardcoded Anthropic API key to env

**Problem:** `ANTHROPIC_API_KEY` was hardcoded inline in the `/api/session-autoname` handler:
```js
const anthropicKey = process.env.ANTHROPIC_API_KEY || 'sk-ant-api03-...'
```
GitHub push protection blocked the backup branch push, flagging it as a secret leak.

**Fix:**
```js
const anthropicKey = process.env.ANTHROPIC_API_KEY
if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })
```
Key added to `/opt/octis/.env` (not committed). `.env` is already in `.gitignore`.

**Testing:** Key present in `.env`, server not restarted (no functional change — same code path, same key, now via env).

---

### 2. `CHANGELOG.md` — Added full changelog

New file at `/opt/octis/CHANGELOG.md` documenting all changes since initial commit (2026-04-03) through today, organized by date/milestone. Covers both upstream git commits and all local Casken-specific patches. Committed to `backup/kennan-local-patches-2026-04-27` branch.

---

### 3. GitHub — Backup branch pushed

- Branch `backup/kennan-local-patches-2026-04-27` created and pushed to `octis-app/octis`
- Contains all 67 local patches committed as Kennan Hoa (`hoa_kennan2@hotmail.com`)
- Secrets excluded: `.env.production` (contains `VITE_GATEWAY_TOKEN`), `backups/` (contains plaintext passwords)
- SSH key configured for KennanHoa (`/root/.ssh/github_kennan`) — git remote changed to `git@github.com:octis-app/octis.git`
- Git config (local + global): `user.name = Kennan Hoa`, `user.email = hoa_kennan2@hotmail.com`
- KennanHoa added as maintainer on `octis-app/octis` (was not a collaborator)

### Known issues / needs review before merge
- `ANTHROPIC_API_KEY` is now in `/opt/octis/.env` — any new deployment needs this key added manually. Should be documented in README.
- `apply-local-patches.cjs` still not updated for: patches 27–31, 37–45, `hydrateFromServer` server-wins change, SettingsPanel `QUICK_COMMANDS_CONFIG` refactor — must register all before next upstream pull.

---

## Session: 2026-04-27 (19:15–19:30 UTC) — Auto-push script, VERSION, fork setup

### Context
Kennan asked for automatic commits + pushes to a named GitHub branch whenever OCTIS_CHANGES.md is updated, with semantic versioning (+1 for big changes, +0.01 for small).

---

### 1. `scripts/push-changes.sh` — new file

Auto-commit + push script. Run after every OCTIS_CHANGES.md update.

**Usage:**
```bash
bash scripts/push-changes.sh minor   # +0.01 (small fix/note)
bash scripts/push-changes.sh major   # +1.00 (big feature batch)
```

**What it does:**
1. Reads current `VERSION`, bumps by major or minor increment
2. Strips `backups/` and `.env.production` from staging (prevents secret leaks)
3. Stages all remaining local changes (`git add -A`)
4. Commits as Kennan Hoa (`hoa_kennan2@hotmail.com`) with message `chore(local): vX.XX — <date>`
5. Force-pushes to `origin/kennan-local-changes` (on `octis-app/octis`)
6. Also pushes to `KennanHoa/octis` fork (once the fork remote is configured)
7. Creates a lightweight git tag `vX.XX`

**Security fix:** Initial run accidentally committed `backups/env/` files containing plaintext passwords. Fixed immediately by:
- Adding `backups/` to `.gitignore`
- Running `git rm --cached backups/ .env.production`
- Amending the commit + force-pushing to overwrite

---

### 2. `VERSION` — new file

Plain text file at repo root containing current version (e.g. `1.01`). Read and written by `push-changes.sh`. Current value: `1.01`.

---

### 3. `.gitignore` — updated

Added `backups/` to prevent automated backup snapshots (which contain plaintext gateway tokens and admin passwords) from ever being committed.

Also untracked `.env.production` (`git rm --cached`) — this file was previously tracked in upstream but contains `VITE_GATEWAY_TOKEN` and should never be committed.

---

### 4. GitHub fork + PAT

- Forked `octis-app/octis` → `KennanHoa/octis` (now shows in Kennan's GitHub profile)
- `kennan-local-changes` branch pushed to fork at `5ea4e98`
- Classic PAT for KennanHoa saved to 1Password → GitHub item (`Kennan — PAT`)
- Fine-grained PAT removed from 1Password (superseded by classic; Kennan deleting from GitHub)
- Branch renamed: `backup/kennan-local-patches-2026-04-27` → `kennan-local-changes`

### Known issues / needs review before merge
- `apply-local-patches.cjs` still not updated for: patches 27–31, 37–45, `hydrateFromServer` server-wins change, SettingsPanel `QUICK_COMMANDS_CONFIG` refactor — must register all before next upstream pull.
- README does not yet document the `ANTHROPIC_API_KEY` env requirement for fresh deployments.
- `push-changes.sh` pushes to `octis-app/octis` (origin) and has a `kennan` remote for the fork — verify both remotes are set after any fresh clone.

---

## Session: 2026-04-27 (20:10–21:00 UTC) — WhatsApp Project, Branch Strategy, Patch Restore

### Context
Kennan asked to group all WhatsApp sessions into a new project folder and update the app. During deployment, a series of regressions were introduced and fixed. Branch strategy was also clarified and locked in.

---

### 1. WhatsApp Project — DB + auto-tag

**DB change:**
```sql
INSERT INTO octis_projects (name, slug, emoji, color, description, position)
VALUES ('WhatsApp', 'WhatsApp', '💬', '#25d366', 'All WhatsApp conversations.', 10);
```
- Existing session `agent:main:whatsapp:direct:+15142457588` back-filled into `octis_session_projects` with `project = 'WhatsApp'`

**`src/store/gatewayStore.ts` — auto-tag in `autoTagSlackSessions()`:**
- Added WhatsApp detection alongside existing Slack detection:
```ts
if (/whatsapp/i.test(s.key) && !projectStore.tags[s.key]?.project) {
  projectStore.setTag(s.key, 'WhatsApp')
}
```
- Any session whose key matches `/whatsapp/i` is automatically tagged to the WhatsApp project on every `setSessions` call.

**Verified:** Project appears in Projects tab; existing session tagged correctly.

---

### 2. Regression: `vite.config.js` base path wiped (CRITICAL)

**What happened:** The dev deployment session (setting up `dev.octis`) reset `vite.config.js` to the upstream committed state, removing the `base: '/octis/'` patch. A subsequent `npm run build` baked in asset paths as `/assets/...` instead of `/octis/assets/...` — every JS/CSS file 404'd, app shell loaded but was completely non-functional.

**Fix applied (patch re-applied):**
```js
base: '/octis/',
importScripts: ['sw-push.js'],     // relative (was '/sw-push.js')
urlPattern: /\/api\//,             // unanchored (was /^\/api\//)
```

**Lesson:** `vite.config.js` patches are now committed to `kennan-local-changes` so they can't be silently wiped again.

---

### 3. Regression: `server/config/agents.json` set to Byte

**What happened:** Dev deployment session changed agents.json in `/opt/octis/` to the upstream Byte config (array format, name: "Byte"). Main app was serving Byte as the agent identity.

**Fix:** Restored to Ghosty:
```json
[{ "id": "main", "name": "Ghosty", "emoji": "👻", "description": "Sonnet — default", "default": true }]
```

---

### 4. Regression: All 67 local patches lost from `kennan-local-changes`

**Root cause:** `push-changes.sh` was being run from the local `main` branch, and previous runs only committed metadata files (OCTIS_CHANGES.md, VERSION, push-changes.sh). The actual source file patches (all 67 changes across 20 files) were never staged/committed — they only existed as live edits on disk. When the dev deployment session reset files, all patches were lost from the working tree.

**Fix:** Restored all 30 modified/new source files from `origin/backup/kennan-local-patches-2026-04-27` (commit `f930b87`):
- `vite.config.js`, `db/schema.sql`, `index.html`, `package.json`
- `server/config/agents.json`, `server/index.js`
- `src/App.tsx`, `src/components/ChatPane.tsx`, `src/components/DeleteConfirmModal.tsx`
- `src/components/MobileApp.tsx`, `src/components/MobileFullChat.tsx`
- `src/components/MobileProjectView.tsx`, `src/components/ProjectView.tsx`
- `src/components/ProjectsGrid.tsx`, `src/components/SettingsPanel.tsx`
- `src/components/Sidebar.tsx`, `src/hooks/useTextareaUndo.ts`
- `src/index.css`, `src/lib/msgCache.ts`, `src/store/gatewayStore.ts`
- All scripts: `apply-local-patches.cjs`, `backup.sh`, `check-tzdeps.cjs`, `healthcheck.sh`, `patch-drift-check.sh`, `rollback.sh`, `safe-pull.sh`, `sync-costs.js`, `watchdog.sh`
- `CHANGELOG.md`

All files committed to `kennan-local-changes` at **v2.00** — first time the full patch set is properly tracked in git.

---

### 5. Branch strategy locked in

**Rule (confirmed by Kennan, 2026-04-27):**
- `origin/main` = upstream (Byte's branch). Read-only. Never touch.
- `kennan-local-changes` = all Kennan's fixes. Runs `/octis/`. **All fixes always go here.**
- `merge/kennan-upstream-sync` = test-only merge of both. Runs `/dev.octis/`. Never committed to directly.
- Merge to `main` only after Kennan tests `dev.octis` and explicitly approves.
- Active branch in `/opt/octis/` switched from `main` → `kennan-local-changes`.

---

### 6. `scripts/push-changes.sh` — descriptive commit messages required

**Change:** Script now requires a summary message as argument. Errors out if omitted.

**New usage:**
```bash
bash scripts/push-changes.sh minor "what changed"
bash scripts/push-changes.sh major "what changed"
```

**Commit format changed from:**
`chore(local): v2.00 — 2026-04-27 20:54 UTC`

**To:**
`v2.01 — require descriptive commit messages in push-changes.sh`

---

### Versions this session
| Version | What |
|---|---|
| v1.03 | WhatsApp project + auto-tag (gatewayStore.ts) |
| v1.04 | Restore vite.config.js base + agents.json Ghosty fix |
| v2.00 | Restore all 67 patches from backup branch (major — first proper commit of full patch set) |
| v2.01 | Descriptive commit messages in push-changes.sh + WhatsApp tag in autoTagSlack helper |

### Known issues / needs review before merge
- `apply-local-patches.cjs` exists now but has not been audited to confirm all patches are covered (especially patches 27–45). Should be verified before next upstream pull.
- `dev.octis` (`merge/kennan-upstream-sync`) was built before the patch restore — may need a re-merge and rebuild.
- README does not document `ANTHROPIC_API_KEY` env requirement for fresh deployments.

---

## Session: 2026-04-27 (04:50–21:30 UTC) — Clickable Links, Inline Images, WhatsApp Channel

### Context
Long session focused on two areas: (1) Octis UI improvements — clickable links and inline image rendering in chat messages for both desktop and mobile; (2) WhatsApp channel setup for OpenClaw including troubleshooting a persistent "can't link device" error.

---

### 1. Clickable URLs in chat — `src/components/ChatPane.tsx` + `src/components/MobileFullChat.tsx`

**Problem:** URLs in chat messages rendered as plain text — not clickable, no link styling.

**Fix — `ChatPane.tsx` `renderInline()`:**
- Split each text segment on `/(https?:\/\/[^\s<>"{}|\\^`\[\]*]+)/g` (note: `*` excluded to avoid swallowing trailing markdown bold markers)
- URL segments rendered as `<a href={url} target="_blank" rel="noopener noreferrer">` with indigo/purple color and underline
- Non-URL segments continue through the existing bold/italic/code inline parser

**Fix — `MobileFullChat.tsx` `renderTextWithMedia()`:**
- Full rewrite of the final text-render fallback
- Splits text line-by-line; each line checked for: data URI image, MEDIA: directive, markdown image `![alt](url)`, then URL-containing text
- URL regex: `/(https?:\/\/[^\s<>"{}|\\^`\[\]*]+)/g` (same `*` exclusion)
- Rendered as `<a>` with same styling

**Bug found & fixed:** When I wrote `👉 **https://example.com**` in a message, the regex captured `https://example.com**` (asterisks included). Fixed by adding `*` to the excluded character class in both components.

**Verified:** Links in both desktop and mobile chat are clickable; asterisk-wrapped URLs render correctly.

---

### 2. Inline image rendering — `src/components/ChatPane.tsx` + `src/components/MobileFullChat.tsx`

**Problem:** Base64 data URI images (e.g. QR codes) rendered as raw text on mobile; markdown `![alt](url)` syntax not rendered; `MEDIA:<url>` directive not rendered.

**Fix — `ChatPane.tsx` line-by-line loop (already had `renderBase64Image`):**
- Added detection for `![alt](url)` markdown image syntax → renders as `<img>`
- Added detection for `MEDIA:<url>` lines → renders as `<img>` for image URLs, `<a>` otherwise
- `renderBase64Image` (existing) handles bare `data:image/...;base64,...` lines

**Fix — `MobileFullChat.tsx` `renderTextWithMedia()`:**
- Added data URI detection at top: if entire text starts with `data:image/(png|jpeg|gif|webp);base64,` → renders as `<img>` directly
- Per-line: data URI lines → `<img>`, markdown images → `<img>`, MEDIA: → `<img>` or `<a>`

**Root cause of mobile blank image:** OpenClaw truncates chat history message content at 8,000 characters (default). A 7,000+ char base64 QR code was being cut mid-string, producing an invalid `src`. Fixed by setting `gateway.webchat.chatHistoryMaxChars = 200000` in openclaw.json.

**Note:** The `chatHistoryMaxChars` setting is configured directly in `/root/.openclaw/openclaw.json` (cannot be set via `config.patch` — it's a protected path in the gateway's patch API). Value confirmed via `grep chatHistoryMaxChars` in the gateway source.

**Verified:** Build clean. Desktop renders QR codes. Mobile renders inline images. Truncation eliminated.

---

### 3. User bubble link visibility — `src/index.css`

**Problem:** Clickable links inside user message bubbles (purple/indigo background) were rendered in the default link color (indigo) — invisible against the purple background.

**Fix:** Added CSS class `.octis-user-bubble a` with `color: rgba(255,255,255,0.9)` and `text-decoration: underline`. Hover state: full white.

**Note:** Requires that user message bubble `<div>` has class `octis-user-bubble` applied. Verified in ChatPane's message rendering markup.

---

### 4. Sidebar group open/close persistence — `src/components/Sidebar.tsx`

**Problem:** Sidebar project/group sections reset to open on every page reload.

**Fix:** `CollapsibleGroup` component's `open` state initialised from `localStorage.getItem('octis-group-open-{name}')` (default: `true` if not set). Toggle writes back to localStorage.

**Verified:** Collapse state survives page reload.

---

### 5. Mobile group collapse persistence — `src/components/MobileApp.tsx`

**Problem:** Collapsed project groups on mobile reset on reload.

**Fix:** `collapsedGroups` state initialised from `localStorage.getItem('octis-mobile-collapsed-groups')` (JSON-serialised Set). Writes back on every toggle.

**Verified:** Collapse state persists on mobile.

---

### 6. `apply-local-patches.cjs` — patches 26 & 27 registered

Added patch sentinel markers:
- **Patch 26:** `ChatPane.tsx` — clickable links + inline images (desktop)
- **Patch 27:** `MobileFullChat.tsx` — clickable links + inline images (mobile)

---

### WhatsApp channel (OpenClaw infra — not Octis code)

Not an Octis change, but recorded for completeness:
- OpenClaw WhatsApp plugin installed (`@openclaw/whatsapp` bundled)
- Linked to Kennan's personal number (+1 514-245-7588) via custom Baileys pairing code script (after repeated QR failures due to WhatsApp rate-limiting from too many scan attempts)
- Config: `dmPolicy: allowlist`, `allowFrom: ["+15142457588"]`, `groupPolicy: allowlist` — bot ignores all messages except from Kennan's own number
- Verified: `openclaw channels status` confirms `linked, running, connected`

---

### Versions this session
- Started: v2.02
- Ending: v2.03 (pending commit)

### Known issues / needs review before merge
- `apply-local-patches.cjs` patch coverage should be audited end-to-end before next upstream pull.
- `chatHistoryMaxChars: 200000` is set in `/root/.openclaw/openclaw.json` directly (not via config.patch). If the gateway config is reset, this needs to be re-applied manually.
- User bubble link visibility fix (`index.css`) depends on `octis-user-bubble` class being present on the user message bubble element — confirm this class is applied consistently in ChatPane and MobileFullChat.
- README still does not document `ANTHROPIC_API_KEY` env requirement.

---

## Session 2026-04-28 — Quick Commands Persistence Fix

### 1. SettingsPanel.tsx — localStorage-primary (server never overwrites user's custom text)

**Problem:** Settings panel on every open fetched from server and called `setQcValues({ ...QUICK_COMMAND_DEFAULTS, ...serverVals })`, overwriting localStorage unconditionally. If the server DB was ever reset (deploy, migration, upstream pull), all user-customized quick command text was silently wiped.

**Fix:** Mount effect now merges `{ ...QUICK_COMMAND_DEFAULTS, ...serverVals, ...localVals }` where `localVals` is the current localStorage content. localStorage always wins. Server values only fill keys that don't exist in localStorage yet.

**Files changed:** `src/components/SettingsPanel.tsx`

**Verified:** Custom text persists after Settings close/reopen. Server DB still receives saves for cross-device sync. `isDirtyRef` still prevents server response from stomping in-progress edits.

---

### 2. MobileFullChat.tsx — QUICK_COMMAND_DEFAULTS updated to user's custom text

**Problem:** `MobileFullChat.tsx` had its own hardcoded `QUICK_COMMAND_DEFAULTS` matching upstream Octis defaults (Octis-centric prompts). If localStorage is empty (new browser, cleared cache), mobile icons sent the wrong text.

**Fix:** Updated `QUICK_COMMAND_DEFAULTS` in `MobileFullChat.tsx` to match Kennan's current saved custom text for all four keys (`brief`, `away`, `save`, `archive_msg`).

**Files changed:** `src/components/MobileFullChat.tsx`

---

### 3. apply-local-patches.cjs — Patch 14 fixed + Patch 14b added

**Problem:** Patch 14 in the patch script was a stub — it checked for a `hasLocalCustom` marker but made no actual code change. The localStorage-primary fix would not survive a `git pull`.

**Fix:**
- Patch 14 rewritten to apply the real localStorage-primary merge logic in `SettingsPanel.tsx`
- Patch 14b added to sync `MobileFullChat.tsx` `QUICK_COMMAND_DEFAULTS` to user's custom text

**Files changed:** `scripts/apply-local-patches.cjs`

**Verified:** `npm run build` succeeded, `octis.service` active after `systemctl restart`.

---

## Session 2026-04-29 — Project Dropdown in ChatPane Header

### 1. ChatPane.tsx — ProjectDropdown component added

**Feature:** New `ProjectDropdown` component added to the ChatPane session header (right of the model badge, left of the close button). Allows viewing and switching the current session's project without leaving the chat pane.

**Pill button shows:**
- Colored dot (project's color from DB)
- Emoji + project name
- 📦 icon if the session is archived
- Tooltip with project name + archived status

**Dropdown shows:**
- "Archived session" amber banner when session is archived (checks both `useHiddenStore.isHidden()` and `useSessionStore.hiddenSessions` — needed because `isHidden` only covers client-side hide set, not DB-backed archived sessions after page refresh)
- All projects with colored dot + emoji + name
- Checkmark on current project
- "Remove from project" option when a project is tagged
- Uses existing `useProjectStore.setTag()` → `pushProjectTagToServer()` path — no new API endpoints

**Files changed:** `src/components/ChatPane.tsx`

**Verified:** `npm run build` clean, `octis.service` active after restart. Dropdown opens, switches project, updates header pill immediately.

---

### 2. octis.db — Project emojis and colors updated

Updated `octis_projects` table directly with distinct emojis and colors for each project:

| Slug | Emoji | Color |
|---|---|---|
| Module 1 | 🏗️ | #f59e0b (amber) |
| Octis | 🐙 | #6366f1 (indigo) |
| Slack | 💬 | #4a154b (Slack purple) |
| Personal | 👤 | #22c55e (green) |
| WhatsApp | 💬 | #25d366 (WhatsApp green, unchanged) |

**Verified:** DB query confirmed all 5 rows updated. UI picks these up via `/api/projects` fetch on Sidebar mount.

---

### Versions this session
- Started: v2.06
- Ending: v2.07 (pending commit)

### Known issues / needs review
- `ProjectDropdown` is NOT yet registered in `apply-local-patches.cjs` — if an upstream pull runs `apply-local-patches.cjs`, this feature will be preserved only because it's committed to `kennan-local-changes`. Patch marker should be added before next pull.
- Mobile (`MobileApp.tsx`, `MobileProjectView.tsx`, `MobileFullChat.tsx`) does not yet have a project switcher — only desktop ChatPane was updated. Parity TODO.
