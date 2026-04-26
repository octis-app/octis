#!/bin/bash
# Octis deploy — VM only
# Usage: ./deploy.sh
# That's it.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[octis] Fixing permissions for nginx (pre-build)..."
chmod o+x /root /root/.openclaw /root/.openclaw/workspace /root/.openclaw/workspace/octis

echo "[octis] Building frontend..."
npm run build

echo "[octis] Fixing permissions for nginx (post-build)..."
chmod o+x /root/.openclaw/workspace/octis/dist
chmod -R o+r /root/.openclaw/workspace/octis/dist

echo "[octis] Restarting API server..."
systemctl restart octis-api

echo "[octis] Reloading nginx..."
systemctl reload nginx

echo ""
echo "✅ Deployed. Live at https://octis.duckdns.org"
curl -s https://octis.duckdns.org/api/health && echo ""

echo "[octis] Running QA..."
node /root/.openclaw/workspace/scripts/octis-qa.js --no-slack || echo "⚠️  QA found issues"
