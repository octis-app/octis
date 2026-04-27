#!/bin/bash
# rollback.sh — restore the last known-good build and/or DB
# Usage:
#   bash scripts/rollback.sh          # roll back dist (last backup)
#   bash scripts/rollback.sh db       # roll back DB only
#   bash scripts/rollback.sh all      # roll back dist + DB

set -e
BACKUP_DIR="/opt/octis/backups"
MODE="${1:-dist}"

echo ""
echo "══════════════════════════════════════════════════"
echo "  Octis rollback ($MODE)"
echo "══════════════════════════════════════════════════"

rollback_dist() {
  LATEST_DIST=$(ls -td "$BACKUP_DIR/dist"/dist_* 2>/dev/null | head -1)
  if [ -z "$LATEST_DIST" ]; then
    echo "❌ No dist backup found."
    return 1
  fi
  echo "Rolling back dist to: $LATEST_DIST"
  rm -rf /opt/octis/dist
  cp -r "$LATEST_DIST" /opt/octis/dist
  pm2 restart octis
  echo "✅ Dist rolled back and server restarted."
}

rollback_db() {
  LATEST_DB=$(ls -t "$BACKUP_DIR/db"/octis_*.db 2>/dev/null | head -1)
  if [ -z "$LATEST_DB" ]; then
    echo "❌ No DB backup found."
    return 1
  fi
  echo "Rolling back DB to: $LATEST_DB"
  cp "$LATEST_DB" /root/.octis/octis.db
  pm2 restart octis
  echo "✅ DB rolled back and server restarted."
}

case "$MODE" in
  db)   rollback_db ;;
  all)  rollback_dist; rollback_db ;;
  *)    rollback_dist ;;
esac
