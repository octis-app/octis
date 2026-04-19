# Octis 🐙

> One brain. Many arms.

**Octis** is an open-source AI command center built for people who run multiple AI agent sessions daily. You work on *projects* — sessions are invisible plumbing.

Built for [OpenClaw](https://github.com/openclaw/openclaw). Protocol-agnostic by design.

---

## The problem

If you run AI agents heavily, you know the pain:

- 10+ sessions open across multiple projects
- No idea which ones are active, waiting, or silently dead
- Every context switch costs 2–5 minutes of re-orientation
- Costs are invisible until the bill arrives

Octis fixes all of this.

---

## Features

### Session management
- Multi-pane desktop layout — up to 8 sessions visible simultaneously
- Project grouping — tag sessions to projects, auto-sorted by urgency
- Status indicators — active / needs-you / idle, color-coded and sorted
- Auto-labeling — Haiku names each session from context (keyboard shortcut: `R`)
- Archive with undo toast (`E`), drag-to-reorder panes (`⠿` grip)

### Chat
- Full streaming chat in every pane
- PDF attachment — extracts text server-side, sends as context
- Status bar — purple (working) / amber pulse (queued) / green (done) / tool name shown mid-call
- Message cache — instant session switching, silent background reload
- Project context injection — Byte receives project context on first message automatically

### Mobile (PWA)
- Installable to home screen — no App Store needed
- Swipeable session list per project
- Full chat with iOS keyboard handling
- Push notifications — "needs your input" alerts even when tab is closed
- Auto-reconnect on background/foreground

### Costs
- 30-day daily spend chart with 7-day moving average
- Today vs yesterday delta (↑ / ↓ with %)
- Sessions-per-day + avg cost per session
- Top sessions by cost (today + rolling 30 days)

### Memory & todos
- Read-only view of `MEMORY.md`, `TODOS.md`, `memory/*.md`
- Todo count badges per project
- Tap todo → opens new session pre-loaded with that task

---

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS |
| State | Zustand |
| API server | Express (Node.js) |
| Auth | Clerk |
| Database | PostgreSQL |
| Push | Web Push (VAPID) |
| PWA | vite-plugin-pwa + Workbox |
| Gateway | OpenClaw WebSocket API |

---

## Quick start

### Prerequisites
- Node.js 18+
- An [OpenClaw](https://github.com/openclaw/openclaw) gateway
- PostgreSQL with OpenClaw tables (`raw_nexus.*`)
- A [Clerk](https://clerk.com) app

### Install

```bash
git clone https://github.com/octis-app/octis
cd octis
npm install
```

### Configure

```bash
# Environment variables for the API server
cp .env.example .env
# Edit .env — see Environment variables below

# User config (who can log in and what they see)
cp server/config/users.example.json server/config/users.json
# Edit users.json — add Clerk user IDs and their roles
```

### Run (development)

```bash
npm run dev       # Frontend on http://localhost:5173
npm run server    # API server on http://localhost:3747
```

### Build & deploy

```bash
npm run build     # Outputs to dist/
# Serve dist/ with nginx, proxy /api → 3747, /ws → OpenClaw gateway port
```

See [`docs/deploy.md`](docs/deploy.md) for a full nginx + systemd setup.

---

## Environment variables

### API server

| Variable | Required | Description |
|----------|----------|-------------|
| `CLERK_SECRET_KEY` | ✅ | Clerk secret key — from your Clerk dashboard |
| `PG_HOST` | ✅ | Postgres host |
| `PG_DB` | ✅ | Database name |
| `PG_USER` | ✅ | Postgres user |
| `PG_PASSWORD` | ✅ | Postgres password |
| `PG_PORT` | | Postgres port (default: 5432) |
| `VAPID_PUBLIC_KEY` | | Web Push public key (required for push notifications) |
| `VAPID_PRIVATE_KEY` | | Web Push private key |
| `VAPID_CONTACT` | | Push contact email, e.g. `mailto:you@example.com` |
| `OCTIS_WORKSPACE` | | Path to OpenClaw workspace (default: `~/.openclaw/workspace`) |
| `OCTIS_API_PORT` | | API server port (default: 3747) |
| `GATEWAY_URL` | | Override gateway WebSocket URL |

Generate VAPID keys: `npx web-push generate-vapid-keys`

### User config (`server/config/users.json`)

Maps Clerk user IDs to roles and agent visibility:

```json
{
  "clerk_user_id": {
    "role": "owner",
    "agentId": "main",
    "displayName": "Your Name"
  }
}
```

- `role: "owner"` — full access
- `role: "member"` — sees only their assigned agent's sessions
- `agentId` — which OpenClaw agent's sessions this user sees

This file is gitignored. Copy from `server/config/users.example.json`.

---

## Docs

- [`docs/architecture.md`](docs/architecture.md) — system design, data flow, state management
- [`docs/components.md`](docs/components.md) — component reference
- [`docs/deploy.md`](docs/deploy.md) — nginx, systemd, QA system
- [`docs/gotchas.md`](docs/gotchas.md) — known sharp edges and root causes

---

## Roadmap

- [ ] Project-first session orchestration (auto-spawn/prune/handoff sessions per project)
- [ ] Model router (classify task → pick right model automatically)
- [ ] Workspace sharing — invite members, per-agent visibility controls
- [ ] Session templates — pre-loaded briefs for recurring project types
- [ ] Export session transcript

---

## Contributing

Early stage. Core ideas are still being shaped. Issues and discussions welcome.

---

## License

MIT
