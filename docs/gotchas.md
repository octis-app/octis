# Octis — Sharp Edges & Gotchas

A running list of non-obvious bugs, root causes, and lessons. Read this before touching anything.

---

## WS & Reconnect

### `visibilitychange` triggers ghost reconnect → wipes chat
**Root cause:** `visibilitychange` handler called `connect()` unconditionally. Each `connect()` creates a new WS object → ChatPane history effect re-ran → `setMessages([])`. Messages wiped every time tab was backgrounded.  
**Fix:** Only reconnect if WS is actually dead (`CLOSED` or `CLOSING` state). Also: ChatPane doesn't wipe messages on WS reconnect for the same session — reloads silently.

### WS doesn't connect in headless (QA)
Gateway WS requires an interactive session context. In Playwright headless, the WS upgrade is accepted but no events flow. Gateway connection check in QA is therefore a soft warning only.

---

## Status Bar

### Bar goes green before reply renders
**Root cause:** Zustand `setLastRole()` (called in poll handler) zeroed `isStreaming` before React batched `setMessages`. Bar turned green while user was still staring at a blank pane.  
**Fix:** `awaitingRender` guard in `showWorking` — if `isWorking` + `globalStreaming` both false but last visible message is still from the user and was sent within 2 minutes, bar stays purple until reply actually renders.

### Bar goes green during long tool calls (was: 4s timeout)
**Root cause:** `markStreaming` fallback timeout was 4s. Tool calls (exec, web search, etc.) can take 30s+. Bar went green mid-tool, then back to purple when next token arrived.  
**Fix:** Fallback timeout raised to 90s. WS lifecycle events (`phase: start/end`) now drive `isWorking` — poll no longer clears it.

---

## Mobile

### iOS keyboard causes layout jump
**Root cause:** React was re-applying `height: 100dvh` as an inline style on every keystroke (it was in the style prop). This overrode the JS-set visual viewport height, causing the keyboard to push the layout.  
**Fix:** Removed `height: 100dvh` from inline style. Used `position: fixed; top: 0; left: 0; right: 0` on outer container. Visual viewport listener updates `height` and `top` directly on DOM ref via `useRef`.

### iOS auto-zoom on textarea focus
**Fix:** `font-size: 16px` on mobile textarea. iOS only zooms when font-size < 16px.

### Enter sends on mobile (was: swallowed by keyboard)
Removed `onKeyDown` send-on-Enter handler from mobile chat. Send button only. Desktop keeps Enter=send.

---

## Session State

### Sessions tab leaking into ProjectView panes
**Root cause:** ProjectView was using the shared `activePanes` Zustand store. Sessions opened in Sessions tab persisted into ProjectView when switching tabs.  
**Fix:** ProjectView uses local `localPanes` state. Completely isolated from Sessions tab.

### agentId filter bypassed on every poll
**Root cause:** `sessions.list` polls in Sidebar, MobileProjectView, ChatPane were all passing `params: {}` — no `agentId`. Gateway returned all sessions → Zustand store got flooded with Nexus/heartbeat/cron sessions every 30s.  
**Fix:** All poll calls now pass `{ agentId }`. Belt-and-suspenders: `setSessions` has a client-side guard that filters by agentId too.

### Session opened twice in same pane
**Fix:** `openInNextPane` scans all 8 slots. If session already in a pane: click blocked, "open" badge shown.

---

## Drag & Drop

### HTML5 DnD doesn't work well in multi-pane layout
**Root cause:** HTML5 drag events have inconsistent behavior with overflow containers and cross-pane drag targets. `dragover` events don't fire reliably on flex children.  
**Fix:** Replaced with pointer-event DnD. `onPointerDown` → `setPointerCapture` → `onPointerMove` on the pane container, `elementFromPoint` + `data-pane-index` attribute for drop target detection → `onPointerUp` swaps. Custom ghost via fixed-position element.

---

## Project Context Injection

### Inject note showing in chat
The session init note (starts with `📁 **`) is filtered from chat display. If it ever appears, check `stripBootstrapNoise()` and the filter condition in ChatPane/MobileFullChat.

### Double-injection on fast send
Injection is guarded by `pendingProjectInits` in `useSessionStore`. Consumed on first send. If session key changes before send completes, the guard may not clear. Don't open the same session in two panes simultaneously for first-send edge cases.

---

## PDF Attachments

### Gateway silently drops non-image attachments
The OpenClaw gateway only passes through `image/*` MIME types as attachments. PDFs sent directly disappear without error.  
**Fix:** `POST /api/extract-pdf` server-side. Base64 PDF in → text + page count out. Injected as a text block prefixed with `📄 **PDF: filename** (N pages)`. Send button is disabled while extraction is in progress.

---

## Auth

### `clerk.verifyToken is not a function`
Clerk SDK v3 moved `verifyToken` to a standalone export. Import it as:
```js
import { verifyToken } from '@clerk/backend';
```
Not from the Clerk client instance.

### Gateway token drift
The gateway token is **never** hardcoded in Octis or its env. It's read live from `/root/.openclaw/openclaw.json` at each API request. If the token rotates in openclaw.json, Octis picks it up automatically — no redeploy needed.

---

## Postgres

### octis_todos out of sync with TODOS.md
The sync runs when `GET /api/todos` is called. It reads TODOS.md, diffs against `octis_todos`, and upserts. If TODOS.md was edited while the server was down, the next request will sync.

### Postgres tables created on first start
All `octis_*` tables are created by the API server on startup (`CREATE TABLE IF NOT EXISTS`). No manual migration needed.
