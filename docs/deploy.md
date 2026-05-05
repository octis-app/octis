# Octis — Deploy Guide

## Prerequisites

- Node.js 18+
- nginx (serving the frontend + proxying /api and /ws)
- OpenClaw gateway running on port 18789
- Postgres with OpenClaw tables (`raw_nexus.*`) + Octis tables (`octis_*`)
- Clerk account with an app configured

---

## Standard Deploy

```bash
cd /root/.openclaw/workspace/octis
./deploy.sh
```

This script:
1. `npm run build` — Vite builds frontend into `dist/`
2. `systemctl restart octis-api` — restarts Express API server
3. `nginx -s reload` — picks up any nginx config changes
4. Runs QA automatically (`node /root/.openclaw/workspace/scripts/octis-qa.js`)

> ⚠️ Never deploy without QA passing. Non-negotiable.

---

## Environment Variables

### API Server (systemd service env)

| Variable            | Description                                      |
|---------------------|--------------------------------------------------|
| `CLERK_SECRET_KEY`  | Clerk secret key — verifies JWT tokens           |
| `PG_HOST`           | Postgres host                                    |
| `PG_DB`             | Database name                                    |
| `PG_USER`           | Postgres user                                    |
| `PG_PASSWORD`       | Postgres password                                |
| `OCTIS_WORKSPACE`   | Path to OpenClaw workspace (for reading files)   |
| `OCTIS_API_PORT`    | API port (default: 3747)                         |

Gateway token is **not** an env var — it's read live from `/root/.openclaw/openclaw.json` at request time.

### Frontend Build (`.env.production`)

The frontend has no secrets — it only knows the API URL (same-origin by default).

```env
VITE_API_URL=      # leave blank for same-origin
```

---

## nginx Config (key sections)

```nginx
server {
    listen 80;
    server_name octis.duckdns.org;

    root /root/.openclaw/workspace/octis/dist;
    index index.html;

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3747;
        proxy_set_header Host $host;
    }

    # Gateway WebSocket proxy
    location /ws {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

Note: nginx needs `o+x` on all parent directories of `dist/` (including `/root/`).  
Run: `chmod o+x /root /root/.openclaw /root/.openclaw/workspace /root/.openclaw/workspace/octis`

---

## Systemd Service (`octis-api.service`)

Located at `/etc/systemd/system/octis-api.service` (or `/root/.openclaw/workspace/octis/octis-api.service`).

```ini
[Unit]
Description=Octis API Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/.openclaw/workspace/octis
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
EnvironmentFile=/path/to/octis.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Reload after changes:
```bash
systemctl daemon-reload
systemctl restart octis-api
systemctl status octis-api
```

---

## QA System

### Auth
```bash
node /root/.openclaw/workspace/scripts/octis-login.js
```
Creates a Clerk session via backend API (~3s). Saves auth state to `memory/octis-auth-state.json`.  
Re-run when auth expires (Clerk sessions last ~24h in headless mode).

### Run QA
```bash
node /root/.openclaw/workspace/scripts/octis-qa.js
```

Runs two parallel Playwright checks:
- **Desktop** (1280×800): crash screen, login wall, gateway status, session count, load time
- **Mobile** (390×844, iPhone UA): same checks + session count ≤ 50

Results printed inline. Use `--slack` flag only if you want a Slack DM (not default).

### QA checks
| Check | Threshold | Why it exists |
|-------|-----------|---------------|
| No crash screen | must pass | uncaught React error |
| No login wall | must pass | auth regression |
| Session count | ≤ 50 | "200 sessions flooding mobile" regression |
| Load time | < 8s | performance baseline |
| Label format | no raw `agent:main:...` keys | label display regression |

> Known limitation: Gateway WS doesn't connect in headless context — gateway connection check is a soft warning only.

---

## Adding a New User

Edit `server/index.js`, add to `USER_CONFIG`:

```js
'clerk_user_id_here': {
  role: 'member',       // 'owner' | 'member'
  agentId: 'main',      // which agent's sessions they see
  name: 'Jane Doe'
}
```

Then `systemctl restart octis-api`. No rebuild needed.

---

## Health Check

A cron runs every hour → `/var/log/octis-health.log`.  
Check recent entries: `tail -50 /var/log/octis-health.log`
