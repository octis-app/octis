# Octis 🐙

> One brain. Many arms.

**Octis** is an open-source AI command center. You work on *projects* — not sessions. Sessions are invisible plumbing.

Built for [OpenClaw](https://github.com/openclaw/openclaw) users. Protocol-agnostic by design.

---

## The problem

If you run AI agents heavily, you know the pain:

- 10+ sessions open across multiple projects
- You have no idea which ones are active, waiting, or silently dead
- Every context switch costs you 2-5 minutes of re-orientation
- Context windows bloat → quality degrades → you start over
- You're locked to one model per session, even when the task changes

Octis fixes all of this.

---

## The vision

### Projects, not sessions
You open a project. Octis manages the sessions underneath — spawning, pruning, and handing off context automatically. Sessions hit a token/cost threshold? Octis summarizes state, kills it, and opens a fresh one with a structured handoff. You never notice.

### Model routing
A lightweight router classifies each task and picks the right model: cheap fast models for lookups and summaries, stronger models for reasoning and code, the best available for high-stakes decisions. The router costs cents. The savings are significant.

### Never go dumb
Handoffs use a structured contract — goal, decisions, current state, relevant memory — not a raw conversation dump. Context noise is the enemy. Tight summarization keeps quality consistent across session boundaries.

### Always know what's happening
Every session shows last activity timestamp, status (working / needs you / idle / dead), and a one-line summary of what it's doing. You stop wondering. You stop polling. You look when it matters.

---

## Features (current)

- **Multi-pane chat** — 1 to 5 sessions visible simultaneously
- **Session status** — active / needs-you / idle / dead, color-coded, sorted by urgency
- **Costs panel** — daily spend, 7-day history, top sessions by cost
- **Memory panel** — TODOS.md, MEMORY.md, recent daily logs, project files
- **Session filtering** — heartbeat/cron sessions hidden by default
- **Auth** — Clerk-based login, persistent session

---

## Roadmap

### v0 (current — MVP)
- [x] Multi-pane chat
- [x] Session list with status indicators
- [x] Costs panel (Postgres)
- [x] Memory panel (workspace files)
- [x] Clerk auth

### v1 — Project layer
- [ ] Project abstraction (group sessions under a project)
- [ ] Session orchestration (auto-prune + handoff)
- [ ] Model router (classify → route → spawn right model)
- [ ] Keepalive / stuck detection (no activity 3min → warn, 5min → surface)
- [ ] Quick-action buttons (Brief me / Save / Pause / Continue)
- [ ] Mobile PWA (swipeable cards, inline reply)

### v2 — Collaboration
- [ ] Workspace members + session sharing
- [ ] Per-agent visibility controls
- [ ] Push notifications ("agent needs your input")
- [ ] Session templates (quick-start a project with a pre-filled brief)
- [ ] Export session transcript

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

npm install
npm run dev          # Frontend on http://localhost:5173
npm run server       # API server on http://localhost:3747
```

### Environment variables

```env
# Frontend (.env)
VITE_GATEWAY_URL=ws://127.0.0.1:18789
VITE_GATEWAY_TOKEN=your-gateway-token-here
VITE_API_URL=http://localhost:3747

# API server
PG_HOST=localhost
PG_DB=your_database
PG_USER=postgres
PG_PASSWORD=your-pg-password
OCTIS_WORKSPACE=/home/user/.openclaw/workspace
OCTIS_API_PORT=3747
```

---

## Session card protocol

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

## Contributing

Early stage. The core ideas are still being shaped. Issues and discussions welcome.

---

## License

MIT
