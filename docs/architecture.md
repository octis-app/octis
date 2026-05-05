# Octis — Architecture

## Overview

Octis is a split-process app:

- **Frontend** — React + Vite SPA (TypeScript/JSX, Tailwind CSS). Served by nginx.
- **API server** — Express on port 3747. Handles auth, file reads, Postgres queries, PDF extraction.
- **OpenClaw gateway** — WebSocket on port 18789. All chat, session management, and streaming go through it. Octis connects as a client — it doesn't own the gateway.

```
Browser
  └── nginx (80/443)
        ├── /         → dist/          (static frontend)
        ├── /api/*    → localhost:3747  (Express API)
        └── /ws       → localhost:18789 (OpenClaw gateway WS)
```

---

## Infrastructure (canonical)

| Component        | Location                                           |
|------------------|----------------------------------------------------|
| Live URL         | https://octis.duckdns.org                          |
| Source           | /root/.openclaw/workspace/octis/                   |
| Frontend (built) | /root/.openclaw/workspace/octis/dist/              |
| API server       | systemd: `octis-api` (port 3747)                  |
| Gateway          | OpenClaw managed (port 18789)                      |
| Hosting          | VM (openclaw-nexus, GCP)                           |
| Cloud Run        | **DELETED** 2026-04-09 — URL gone permanently      |

Deploy: `cd /root/.openclaw/workspace/octis && ./deploy.sh`  
(Builds frontend, restarts API, reloads nginx. QA runs automatically after.)

---

## Auth Flow

1. User hits `https://octis.duckdns.org` → nginx serves `dist/index.html`
2. Clerk JS SDK initializes — checks for session cookie
3. If not signed in → `AuthGate.tsx` renders Clerk's sign-in widget
4. After sign-in → Clerk session JWT available client-side
5. Frontend calls `POST /api/gateway-config` with JWT in Authorization header
6. Express verifies JWT with Clerk SDK (`verifyToken`), looks up user in `USER_CONFIG`
7. Returns `{ gatewayUrl, gatewayToken, agentId, role }` — token is never in the frontend build
8. `gatewayStore` connects WS to gateway with the token

**USER_CONFIG** lives in `server/index.js`. Each entry maps `clerkUserId` → `{ role, agentId }`.  
- `agentId: 'main'` → sees only Byte (main agent) sessions  
- Add new colleagues here when onboarding.

---

## State Management

### `src/store/gatewayStore.ts`
Central Zustand store. Owns:
- WS connection (connect / reconnect / teardown)
- `sessions` — filtered list (by agentId, hide archived, hide subagents)
- `messages` — per-session message arrays
- `lastExchangeCost` — cost delta captured per reply (drives health circles + cost badge)
- `isWorking / globalStreaming` — drives status bar color
- Session CRUD helpers (rename, tag, archive, hide)

WS events handled:
- `chat` — streaming tokens, lifecycle (start/end), tool phases
- `sessions.list` — session refresh (polling every 30s)
- `sessions.patch` — session metadata updates

### `src/store/projectStore.ts`
Tags and project assignments, backed by Postgres (`octis_session_projects`). Synced cross-device.

### `src/store/useSessionStore.ts`
Per-session UI state: pending project inits, focused pane, pane layout.

---

## Key API Endpoints (Express)

| Method | Path                   | What it does                                          |
|--------|------------------------|-------------------------------------------------------|
| POST   | `/api/gateway-config`  | Auth + return gateway creds (Clerk verify)            |
| GET    | `/api/costs`           | Daily costs from `raw_nexus.claw_user_daily_costs`    |
| GET    | `/api/memory`          | Reads MEMORY.md, TODOS.md, memory/*.md                |
| GET    | `/api/todos`           | Reads TODOS.md, returns structured todos + projects   |
| GET    | `/api/projects`        | Returns projects with session tags                    |
| POST   | `/api/session-init`    | Injects project context into a new session via gateway admin WS |
| POST   | `/api/extract-pdf`     | Extracts text from base64 PDF (pdf-parse)             |
| GET    | `/api/labels`          | Session labels from `octis_session_labels`            |
| PATCH  | `/api/labels/:key`     | Rename a session (persisted to Postgres)              |
| GET    | `/api/hidden`          | Archived session keys                                 |
| POST   | `/api/hidden`          | Archive a session                                     |
| DELETE | `/api/hidden/:key`     | Un-archive                                            |

---

## Postgres Tables (Octis-owned)

| Table                          | Purpose                                              |
|--------------------------------|------------------------------------------------------|
| `octis_session_labels`         | Custom session names, synced cross-device            |
| `octis_session_projects`       | Session → project tag mapping                        |
| `octis_hidden_sessions`        | Archived session keys                                |
| `octis_todos`                  | Synced from TODOS.md, with project + done state      |
| `octis_push_subscriptions`     | Web Push VAPID subscriptions                         |

Read-only (owned by OpenClaw/Nexus):
- `raw_nexus.claw_user_daily_costs` — daily cost rollup per user
- `raw_nexus.claw_session_costs` — per-session cost tracking

---

## Session Init / Project Context Injection

Triggered on the first message send in a new session (lazy, not on session creation).

1. Frontend has `pendingProjectInits` set when a new session is opened from a project
2. On `handleSend`, if init is pending: `POST /api/session-init` with `{ sessionKey, projectName }`
3. Server opens an admin WS, sequences `sessions.patch` (context load note) + `chat.inject` (project brief)
4. The injected note starts with `📁 **` — Octis filters this from chat display

---

## Status Bar Logic

The status bar (top of ChatPane) drives the "is something happening?" signal:

- **Purple** — working (WS `chat` event with `phase: start`)
- **Purple + tool name** — tool call in progress (`stream: tool, phase: start`)
- **Green** — last reply was assistant
- **Amber pulse** — message sent, awaiting first token (`awaitingRender` guard)
- **Gray** — idle

Important: polling does NOT drive `isWorking`. Only WS lifecycle events do.  
`markStreaming` fallback timeout: 90s (was 4s — caused premature green on long tool calls).

---

## Push Notifications

- VAPID keys generated at server start (stored in Postgres on first run)
- `POST /api/push/subscribe` — saves subscription
- `POST /api/push/send` — sends to all subscriptions for a user
- Settings panel has a toggle. Requires HTTPS (works on octis.duckdns.org).

---

## PWA

- `vite-plugin-pwa` in `vite.config.js`
- Service worker with offline cache for shell + static assets
- Auto-update banner shown when new version is deployed
- Installable to home screen on iOS/Android/desktop Chrome

---

## Deployment Notes

- Gateway token is read live from `/root/.openclaw/openclaw.json` at request time — never hardcoded, never drifts
- Clerk secret key is in systemd service env (not in repo)
- nginx proxies `/ws` to `ws://127.0.0.1:18789` with `Upgrade` headers
- `deploy.sh`: `npm run build` → copy dist → `systemctl restart octis-api` → `nginx -s reload` → QA runs
