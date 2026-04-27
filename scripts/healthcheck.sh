#!/bin/bash
# healthcheck.sh — verify Octis is actually up and responding after restart
# Returns 0 if healthy, 1 if not.
# Usage: bash scripts/healthcheck.sh [max_wait_seconds]

MAX_WAIT="${1:-30}"
URL="http://localhost:3747/api/health"
ELAPSED=0

echo "── Waiting for Octis to be healthy (max ${MAX_WAIT}s)..."

while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "✅ Octis healthy (${ELAPSED}s)"
    exit 0
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo "❌ Octis not responding after ${MAX_WAIT}s (last HTTP status: $STATUS)"
echo "   pm2 status:"
pm2 list
echo "   Recent logs:"
pm2 logs octis --lines 10 --nostream
exit 1
