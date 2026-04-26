#!/bin/bash
# Octis deploy — VM only
# Usage: ./deploy.sh
#
# STRUCTURE (2026-04-26 fix):
# 1. Pre-deploy sanity: QA against current live site (abort if already broken)
# 2. Build
# 3. Deploy (systemd + nginx)
# 4. Post-deploy QA (blocks "success" if fails)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════════════════════════════"
echo "[octis] DEPLOY STARTING — $(date -Iseconds)"
echo "═══════════════════════════════════════════════════════════════"

# ─── Pre-deploy sanity check ───────────────────────────────────────────────────
# If the current live site is broken, we want to know BEFORE we deploy
# (so we don't deploy on top of an already-broken state)
echo ""
echo "[octis] Pre-deploy sanity check (current live site)..."
if node /root/.openclaw/workspace/scripts/octis-qa.js --no-slack 2>/dev/null; then
  echo "[octis] ✅ Pre-deploy sanity: current live site is healthy"
else
  echo ""
  echo "⚠️  WARNING: Current live site has QA issues BEFORE your change."
  echo "    Proceeding anyway (your change might fix or break things)."
  echo ""
fi

# ─── Build ─────────────────────────────────────────────────────────────────────
echo "[octis] Fixing permissions for nginx (pre-build)..."
chmod o+x /root /root/.openclaw /root/.openclaw/workspace /root/.openclaw/workspace/octis

echo "[octis] Building frontend..."
npm run build

echo "[octis] Fixing permissions for nginx (post-build)..."
chmod o+x /root/.openclaw/workspace/octis/dist
chmod -R o+r /root/.openclaw/workspace/octis/dist

# ─── Deploy ────────────────────────────────────────────────────────────────────
echo "[octis] Restarting API server..."
systemctl restart octis-api

echo "[octis] Reloading nginx..."
systemctl reload nginx

echo ""
echo "[octis] Deployed. Live at https://octis.duckdns.org"
curl -s https://octis.duckdns.org/api/health && echo ""

# ─── Post-deploy QA (BLOCKING) ─────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "[octis] POST-DEPLOY QA (BLOCKING)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Wait for service to be fully up
sleep 2

if node /root/.openclaw/workspace/scripts/octis-qa.js --no-slack; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "✅ DEPLOY COMPLETE — ALL QA PASSED — $(date -Iseconds)"
  echo "═══════════════════════════════════════════════════════════════"
  exit 0
else
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "❌ DEPLOY FAILED QA — DO NOT DECLARE SUCCESS"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  echo "Next steps:"
  echo "  1. Check screenshots in memory/octis-qa-screenshots/"
  echo "  2. Fix the issue"
  echo "  3. Run ./deploy.sh again"
  echo "  4. Only declare done when this script exits 0"
  echo ""
  exit 1
fi
