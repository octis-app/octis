#!/bin/bash
# watchdog.sh — ensure Octis is always running via systemd.
# Runs every 3 minutes via cron. If Octis is down (systemd dead or health fail), restarts it.

HEALTH_URL="http://localhost:3747/api/health"

# Check systemd service status
SYSTEMD_STATUS=$(systemctl is-active octis.service 2>/dev/null)

# Also check HTTP health
HTTP_OK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null)

if [ "$SYSTEMD_STATUS" = "active" ] && [ "$HTTP_OK" = "200" ]; then
  # All good — silent exit
  exit 0
fi

echo "[watchdog] $(date -u '+%Y-%m-%d %H:%M UTC') — Octis down (systemd=$SYSTEMD_STATUS, http=$HTTP_OK). Restarting..."

systemctl restart octis.service
sleep 5

HTTP_AFTER=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTH_URL" 2>/dev/null)
if [ "$HTTP_AFTER" = "200" ]; then
  echo "[watchdog] ✅ Octis recovered"
else
  echo "[watchdog] ❌ Octis still not responding after restart (http=$HTTP_AFTER)"
fi
