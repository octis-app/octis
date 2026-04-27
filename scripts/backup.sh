#!/bin/bash
# backup.sh — snapshot DB, dist, and .env to /opt/octis/backups/
# Run daily via cron. Keeps last 7 snapshots of each.

set -e
DATE=$(date +%Y-%m-%d_%H%M)
BACKUP_DIR="/opt/octis/backups"

# ── DB backup (sqlite3 .backup is safe even while server is running)
DB_SRC="/root/.octis/octis.db"
DB_DST="$BACKUP_DIR/db/octis_$DATE.db"
if [ -f "$DB_SRC" ]; then
  sqlite3 "$DB_SRC" ".backup '$DB_DST'"
  echo "✅ DB  → $DB_DST ($(du -sh "$DB_DST" | cut -f1))"
else
  echo "⚠️  DB not found at $DB_SRC"
fi

# ── .env backup
ENV_SRC="/opt/octis/.env"
ENV_DST="$BACKUP_DIR/env/env_$DATE"
if [ -f "$ENV_SRC" ]; then
  cp "$ENV_SRC" "$ENV_DST"
  chmod 600 "$ENV_DST"
  echo "✅ env → $ENV_DST"
fi

# ── dist backup (current build artifact = rollback point)
DIST_SRC="/opt/octis/dist"
DIST_DST="$BACKUP_DIR/dist/dist_$DATE"
if [ -d "$DIST_SRC" ]; then
  cp -r "$DIST_SRC" "$DIST_DST"
  echo "✅ dist → $DIST_DST ($(du -sh "$DIST_DST" | cut -f1))"
fi

# ── Prune: keep only last 7 of each
for dir in db env dist; do
  ls -t "$BACKUP_DIR/$dir/" 2>/dev/null | tail -n +8 | xargs -I{} rm -rf "$BACKUP_DIR/$dir/{}" 2>/dev/null || true
done

echo "── Backup complete ($DATE)"
