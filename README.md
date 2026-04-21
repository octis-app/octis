# 🐙 Octis

**Your AI command center.** Octis is a self-hosted web UI for [OpenClaw](https://openclaw.ai) that turns a wall of chat sessions into something you can actually manage.

> Built for people running AI agents all day — the kind who have 10+ active sessions, lose track of which one is blocked, and waste 20 minutes re-orienting before they can reply.

---

## What it does

AI sessions are powerful but invisible. You open a thread, the agent goes to work, and then... you lose it. Which session was handling the loan system? Is that build still running or did it die? What did we decide last Tuesday?

Octis fixes that.

**For desktop:** Multi-pane layout so you can watch 2–8 sessions side by side. Labels, project tags, status indicators — you see everything at a glance. Drag panes to rearrange. Hotkeys to jump between them. Archive the noise.

**For mobile:** Swipe between sessions like cards. Full chat in a tap. Reply from anywhere. Push notifications when your agent needs you. Installable as a PWA — no App Store required.

**For context:** Sessions are grouped into Projects. Open "Octis" → see only Octis sessions. Open "Infra" → only infra work. Todo lists sync from your workspace files. Memory panel shows what your agent has committed to long-term memory. Costs panel shows what you're spending.

---

## Features

- 🗂️ **Projects** — group sessions by topic; virtual "Others" catch-all for untagged sessions
- 💬 **Multi-pane chat** — up to 8 concurrent sessions on desktop, drag to reorder
- 📱 **Mobile PWA** — installable, swipeable, push notifications, draft persistence
- 🏷️ **Session labels** — auto-named by AI, manually renameable, synced across devices
- 🗄️ **Archive** — hide sessions without losing them; undo toast
- 📋 **Todos** — synced from your workspace `TODOS.md`, mark done from the UI
- 🧠 **Memory panel** — view what's been committed to long-term agent memory
- 💰 **Costs panel** — daily spend, per-session breakdown (optional, requires DB)
- 🔔 **Push notifications** — get pinged when the agent needs input
- 🔒 **Local auth** — email + password login, httpOnly cookie, bcrypt hashed; or auto-auth for single-user setups
- 🗃️ **SQLite storage** — zero-dependency persistence; no Postgres, no Redis, nothing to manage
- 📎 **Attachments** — images, PDFs (text extracted), video (frame extracted)
- ⌨️ **Hotkeys** — `R` to AI-rename, `⌘K` to jump sessions, `⌘Z` to undo archive

---

## Quick start

```bash
git clone https://github.com/octis-app/octis.git
cd octis
npm install

# Copy and fill in your config
cp .env.example .env
# Edit .env — at minimum set GATEWAY_URL and GATEWAY_TOKEN

npm run build
npm start
```

Then open `http://localhost:3747`.

---

## Configuration

All config lives in environment variables. Create a `.env` file (see `.env.example`):

```env
# Required — your OpenClaw gateway
GATEWAY_URL=wss://your-openclaw-instance/ws
GATEWAY_TOKEN=your_gateway_token_here

# Auth — omit for auto-auth (single-user, no login screen)
# With auto-auth, anyone who can reach the server can use it
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=a_strong_password

# Optional
PORT=3747
OCTIS_WORKSPACE=/path/to/.openclaw/workspace  # for memory/todos panels

# Costs panel (optional — needs a Postgres DB with OpenClaw cost tables)
COSTS_DB_URL=postgresql://user:pass@host/db
```

### Finding your gateway token

In your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "gateway": {
    "auth": {
      "token": "your_token_here"
    }
  }
}
```

### Auto-auth mode

If you leave `ADMIN_PASSWORD` unset, Octis skips the login screen entirely. Anyone who can reach the server gets in. Good for local-only or VPN-protected setups. **Not recommended if the server is exposed to the internet.**

---

## Adding users

Octis ships with a single admin account (set via `ADMIN_EMAIL` + `ADMIN_PASSWORD`). Multi-user support is on the roadmap. For now, share your credentials with trusted collaborators or run separate instances.

---

## Data

Everything is stored in `~/.octis/octis.db` (SQLite, WAL mode). This includes:

- Session labels and project tags
- Hidden/archived sessions
- Pinned sessions
- Projects
- Todo sync state
- Push notification subscriptions

The file is small, portable, and safe to back up or delete (non-destructive — nothing in the gateway or OpenClaw itself is touched).

---

## Self-hosting tips

- **Run behind a reverse proxy** (nginx, Caddy) with TLS. Octis has no built-in HTTPS.
- **Use Tailscale or a VPN** if you don't want the UI exposed publicly.
- **Systemd service:** see `octis.service.example` for a ready-to-use unit file.
- **Docker:** `docker build -t octis . && docker run -p 3747:3747 --env-file .env octis`

---

## Development

```bash
# Run API in dev mode
node server/index.js

# Run frontend with HMR
npm run dev

# Build for production
npm run build
```

The API server runs on port 3747. The frontend dev server proxies `/api/` and `/ws` to it.

---

## Architecture

```
Browser (React + Vite PWA)
    │
    ├── /api/*       → Express API (Node.js, port 3747)
    │                   ├── Auth: local JWT + bcrypt (SQLite)
    │                   ├── Data: SQLite (better-sqlite3)
    │                   └── Costs: Postgres (optional, read-only)
    │
    └── /ws          → OpenClaw Gateway (WebSocket)
                        └── Sessions, chat, agent control
```

Octis talks to your OpenClaw gateway over WebSocket. It never stores message content — only labels, tags, and UI state. The gateway is the source of truth for sessions and messages.

---

## Roadmap

- [ ] Multi-user accounts (admin can add users from Settings)
- [ ] Per-user session visibility (viewer role)
- [ ] Session search across history
- [ ] Export session transcript
- [ ] Keyboard command palette
- [ ] Plugin slots for custom panels

---

## OpenClaw

Octis is built for [OpenClaw](https://openclaw.ai) — a personal AI gateway that connects your agents to Slack, Discord, Signal, Telegram, and more. If you're not running OpenClaw yet, start there.

---

## License

MIT — do whatever you want with it.

---

*Made with 🦞 by the OpenClaw community.*
