# Octis 🐙

> One brain. Many arms.

**Octis** is an open-source command center for power users of AI agents. Stop losing time re-orienting between sessions — see all your active workstreams at a glance, reply from anywhere, and never lose context.

Built for [OpenClaw](https://github.com/openclaw/openclaw) users. Protocol-agnostic by design.

---

## Features

- **Multi-pane chat** — 1 to 5 sessions visible simultaneously. Click any session to open it in a pane.
- **Session sidebar** — per-session brief, auto-extracted from the session card format
- **Session status** — active (< 1h) / idle (< 24h) / dead (> 24h), color-coded
- **Costs panel** — daily spend, 7-day history, top sessions by cost (pulls from Postgres)
- **Memory panel** — TODOS.md, MEMORY.md, recent daily logs, project files
- **Tab nav** — Sessions | Costs | Memory

---

## Quick start

### Prerequisites
- Node.js 18+
- An [OpenClaw](https://github.com/openclaw/openclaw) gateway running (local or remote)
- (Optional) Postgres with `raw_nexus.claw_session_costs` for cost tracking

### Install & run

```bash
git clone https://github.com/octis-app/octis
cd octis
cp .env.example .env
# Edit .env with your gateway URL, token, and Postgres creds

NODE_ENV=development npm install
npm run dev          # Frontend on http://localhost:5173
npm run server       # API server on http://localhost:3747 (costs + memory)
```

Or run both:
```bash
npm run dev:all
```

### Environment variables

```env
# Frontend (.env)
VITE_GATEWAY_URL=ws://127.0.0.1:18789
VITE_GATEWAY_TOKEN=your-gateway-token-here
VITE_API_URL=http://localhost:3747

# API server (same .env or environment)
PG_HOST=localhost
PG_DB=beatimo_warehouse
PG_USER=postgres
PG_PASSWORD=your-pg-password
OCTIS_WORKSPACE=/home/user/.openclaw/workspace
OCTIS_API_PORT=3747
```

---

## Session cards

Octis works best when your agent posts a session card at the start of each conversation:

```
📋 **[Topic Name]**
Last decision: ...
Your next actions: ...
My next actions: ...
Status: active | blocked | waiting on [X]
```

The session sidebar auto-extracts this card so you can re-orient instantly when switching panes.

---

## Roadmap

- [x] Multi-pane chat (1-5 sessions)
- [x] Session status (active/idle/dead)
- [x] Costs panel (daily + per-session)
- [x] Memory panel (TODOS, MEMORY.md, logs, projects)
- [ ] Mobile PWA (swipeable cards)
- [ ] Workspace members + session sharing
- [ ] Push notifications
- [ ] Session templates

---

## Contributing

Early stage. Issues and discussions welcome.

---

## License

MIT
