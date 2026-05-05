# Octis — Component Reference

## App.tsx
Root component. Handles:
- Gateway WS connection on mount (reads config from `/api/gateway-config`)
- `visibilitychange` listener — reconnects only if WS is dead (CLOSED/CLOSING), not on every focus
- Desktop vs mobile detection → renders `<Desktop>` or `<MobileApp>`
- Desktop tab navigation: Projects | Sessions | Memory | Costs | Settings

---

## Desktop Layout

### Sidebar.tsx
Left panel. Renders the session list.

- Sessions filtered by: agentId, archived, subagents (`:subagent:` / `:acp:` keys), heartbeat sessions
- Sorted: needs-you first → tagged+active → rest
- Per-session row: health circle, status badge, label, project tag, relative timestamp
- **Health circle** — colored dot driven by `lastExchangeCost`:
  - Green: < $0.05 | Yellow: $0.05–$0.15 | Red: > $0.15
- Rename: click label → inline edit (persisted to Postgres)
- `R` hotkey on focused pane → AI auto-rename (Haiku)

### ProjectsGrid.tsx
Projects overview. Shows all projects as tiles with session count + todo badges.  
Click a project → opens `ProjectView`.

"Others" tile is a virtual catch-all for untagged sessions (no DB backing).

### ProjectView.tsx
Per-project layout. Left mini-sidebar (session list for that project) + 1–8 chat panes.

Key behaviors:
- Uses **local `localPanes` state** (not shared store) — prevents Sessions view leaking in
- Sessions already open in a pane: click shows "open" badge instead of duplicating
- Pane count: `−` / `N panes` / `+` controls in header
- Drag-and-drop reorder: `⠿` grip on pane title bar (pointer-event based, not HTML5 DnD)
- CSS `hidden` wrapper keeps ProjectView mounted when switching tabs — preserves WS/chat state

### ChatPane.tsx
Full chat panel. One per open session.

Key behaviors:
- **Message cache** — `messageCacheRef` Map<sessionKey, messages[]>. Session switch shows cached instantly; fresh load is silent.
- **Optimistic send** — message appears immediately; poll skips setMessages while in-flight
- **PDF attachments** — `POST /api/extract-pdf` → "Extracting…" spinner → injected as text + metadata
- **Enter = send**, `Shift+Enter` = newline
- **Bootstrap strip** — `stripBootstrapNoise()` removes `[Bootstrap truncation warning]` block before render
- **Async system msg filter** — "System (untrusted):" exec completion notices hidden always
- **Project context injection** — consumes `pendingProjectInits` on first send

Hotkeys (when pane is focused):
- `R` → AI auto-rename
- `E` → archive (with undo toast)

### CostsPanel.tsx
Daily cost breakdown. Reads `/api/costs` → `raw_nexus.claw_user_daily_costs`.  
Shows: daily total, 7-day chart, top sessions by cost.

### MemoryPanel.tsx
Renders workspace files: MEMORY.md, TODOS.md, memory/*.md, project files.  
Read-only display — no edits through Octis.

### SettingsPanel.tsx
User preferences: push notification toggle, subagent session visibility, tool message display.

---

## Mobile Layout

### MobileApp.tsx
Root mobile component. Bottom tab nav: Projects | Sessions | Memory | Costs | Settings.

### MobileProjectView.tsx
Project screen on mobile. Session rows in a scrollable list.
- Per-row: status badge, label, timestamp, 🗑 archive button
- `min-w-0` + `overflow-hidden` on label — prevents trash icon from being pushed off-screen by long names
- Tap row → `MobileFullChat`

### MobileFullChat.tsx
Full-screen chat on mobile. Key behaviors:
- **iOS keyboard jump fix** — visual viewport listener updates `height` + `top` directly on DOM ref; `position: fixed; top: 0` outer container; no `height: 100dvh` (React was re-applying it on every keystroke)
- **Enter = newline** (send button only on mobile)
- **Font size 16px** on textarea — prevents iOS auto-zoom
- **3s poll fallback** — ensures replies appear without needing a refresh
- **WS reconnect on visibilitychange** — force reconnect when returning from background
- Tool message toggle: "chat only" / "+ tools" in header (localStorage shared with desktop)
- ✨ button → AI auto-rename | ⋯ menu → Archive → jumps to next session (doesn't go back to list)
- Double-tap label → manual rename

### MobileSessionCard.tsx
Swipeable session card for the Sessions tab (all sessions view).

---

## Auth Components

### AuthGate.tsx
Wraps the app. Renders Clerk sign-in UI if no session; renders children if authenticated.

### ConnectModal.tsx
Legacy — was used for manual gateway token entry. Now auto-connects after Clerk auth.  
Kept for fallback.

---

## Utility Components

### ErrorBoundary.tsx
React error boundary wrapping the app. Catches render crashes, shows recovery UI.

### IssueReporter.tsx
Dev tool for reporting bugs from within Octis. Posts to GitHub issues or a local log.

### SetupScreen.tsx
First-run setup wizard. Shown if gateway config is missing or auth fails.
