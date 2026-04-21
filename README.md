# 🐙 Octis

**Your AI command center.** Octis is a self-hosted web UI for [OpenClaw](https://github.com/openclaw/openclaw) that turns a wall of chat sessions into something you can actually manage.

> Built for people running AI agents all day — the kind who have 10+ active sessions, lose track of which one is blocked, and waste 20 minutes re-orienting before they can reply.

---

## What it does

**Desktop:** Multi-pane layout — watch up to 8 sessions side by side. Labels, project tags, status indicators. Drag panes to rearrange. Hotkeys to jump between them.

**Mobile:** Swipe between sessions like cards. Full chat in a tap. Push notifications when your agent needs you. Installable as a PWA — no App Store required.

**Projects:** Sessions grouped by project. Open "Octis" → see only Octis sessions. Open "Infra" → only infra work. Context auto-injected on first message.

**Costs:** 30-day daily spend chart, today's delta, top sessions by cost. Optional — requires a Postgres connection to OpenClaw cost tables.

---

## Requirements

- Node.js 18+
- A running [OpenClaw](https://github.com/openclaw/openclaw) gateway
- That's it. No external auth service, no database required.

---

## Quick start

```bash
git clone https://github.com/octis-app/octis
cd octis
npm install
```

Create an env file:

```bash
# Required
GATEWAY_URL=wss://your-openclaw-host/gateway
GATEWAY_TOKEN=your-gateway-token

# Optional — set a password, or skip for single-user auto-auth
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=yourpassword

# Optional — enable push notifications
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_CONTACT=mailto:you@example.com

# Optional — enable costs panel (requires OpenClaw Postgres)
COSTS_DB_URL=postgresql://user:pass@host:5432/db
```

Build and run:

```bash
npm run build
GATEWAY_TOKEN=your-token node server/index.js
```

Open `http://localhost:3747`. Log in with your `ADMIN_EMAIL` + `ADMIN_PASSWORD`.

> **Single-user mode:** If you don't set `ADMIN_PASSWORD`, Octis skips the login screen entirely — anyone with network access can use it. Fine for local use or a private VPN. Not for public exposure.

---

## Onboarding

There are two ways to use Octis:

### Option A — Own instance (you have OpenClaw)

You run your own OpenClaw gateway. Octis connects to it and shows your sessions.

```bash
git clone https://github.com/octis-app/octis
cd octis
npm install
npm run build
```

Create `/etc/octis.env`:
```bash
GATEWAY_URL=wss://your-openclaw-host/gateway
GATEWAY_TOKEN=your-gateway-token
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=yourpassword
```

Start the server:
```bash
GATEWAY_TOKEN=your-token node server/index.js
```

Open `http://localhost:3747`, log in, done. See [Deployment](#deployment-nginx--systemd) for a production setup with nginx + systemd.

---

### Option B — Shared instance (join someone else's Octis)

The Octis owner adds you as a user. You get a login — no setup required on your end.

**For the owner** — add the user from Settings (⚙️ → Users) or via CLI:

```bash
node scripts/create-user.js add colleague@example.com password123 viewer
```

Send them the Octis URL + their credentials. That's it.

**For the new user** — open the URL, log in. You'll see an empty session list at first. Start a new session and it gets associated with your account automatically. You won't see the owner's sessions and they won't see yours.

---

## Auth & users

Octis uses local email/password auth. No Clerk, no OAuth.

**Add users** from the Settings panel (⚙️ → Users section, owner only) or via CLI:

```bash
# Add a user
node scripts/create-user.js add colleague@example.com password123 viewer

# List users
node scripts/create-user.js list

# Reset password
node scripts/create-user.js reset-password colleague@example.com newpassword

# Remove
node scripts/create-user.js delete colleague@example.com
```

Roles:
- `admin` — full access, can manage users
- `viewer` — read + reply, sees only their own sessions

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GATEWAY_URL` | ✅ | WebSocket URL of your OpenClaw gateway |
| `GATEWAY_TOKEN` | ✅ | Gateway auth token |
| `ADMIN_EMAIL` | | First admin account email (created on first run) |
| `ADMIN_PASSWORD` | | First admin account password. Omit for auto-auth (single-user, no login) |
| `PORT` / `OCTIS_API_PORT` | | API server port (default: 3747) |
| `OCTIS_WORKSPACE` | | Path to OpenClaw workspace (default: `~/.openclaw/workspace`) |
| `COSTS_DB_URL` | | Postgres connection string — enables costs panel |
| `VAPID_PUBLIC_KEY` | | Web Push public key |
| `VAPID_PRIVATE_KEY` | | Web Push private key |
| `VAPID_CONTACT` | | Push contact, e.g. `mailto:you@example.com` |

Generate VAPID keys: `npx web-push generate-vapid-keys`

---

## Deployment (nginx + systemd)

**Build:**
```bash
npm run build
# dist/ is now ready to be served
```

**Systemd service** (`/etc/systemd/system/octis.service`):
```ini
[Unit]
Description=Octis API Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/octis
EnvironmentFile=/etc/octis.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Nginx** (add to your server block):
```nginx
# Serve frontend
location / {
    root /path/to/octis/dist;
    try_files $uri $uri/ /index.html;
}

# Proxy API
location /api/ {
    proxy_pass http://127.0.0.1:3747;
    proxy_http_version 1.1;
}

# Proxy WebSocket to OpenClaw gateway
location /ws {
    proxy_pass http://127.0.0.1:18789;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

---

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS |
| State | Zustand |
| API server | Express (Node.js) |
| Auth | Local bcrypt + JWT (httpOnly cookie) |
| Storage | SQLite (`better-sqlite3`, WAL mode) |
| Push | Web Push (VAPID) |
| PWA | vite-plugin-pwa + Workbox |
| Gateway | OpenClaw WebSocket API |

---

## Roadmap

- [ ] Project-first session orchestration (auto-spawn/prune/handoff sessions per project)
- [ ] Model router (classify task → pick right model automatically)
- [ ] Session templates — pre-loaded briefs for recurring project types
- [ ] Export session transcript

---

## License

MIT
