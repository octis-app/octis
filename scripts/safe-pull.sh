#!/bin/bash
# safe-pull.sh — the ONLY approved way to pull Octis upstream changes.
# Never run git pull directly. Always use this script after Kennan approves.
#
# Usage: bash scripts/safe-pull.sh
# 1. Shows what's incoming (no changes yet)
# 2. Merges upstream
# 3. Detects conflicts with local patches
# 4. Re-applies patches, choosing best version on duplicates
# 5. Builds and restarts only if everything is clean

set -e
cd "$(dirname "$0")/.."

echo ""
echo "══════════════════════════════════════════════════"
echo "  Octis safe-pull (Kennan-approved only)"
echo "══════════════════════════════════════════════════"
echo ""

# 1. Show incoming changes first
echo "── Fetching (no merge yet)..."
git fetch origin main 2>&1

INCOMING=$(git log HEAD..origin/main --oneline 2>/dev/null)
if [ -z "$INCOMING" ]; then
  echo "✅ Already up to date. Nothing to pull."
  exit 0
fi

echo ""
echo "── Incoming commits:"
echo "$INCOMING"
echo ""

# 2. Check which local-patched files are touched by upstream
CHANGED_FILES=$(git diff --name-only HEAD..origin/main 2>/dev/null)
PATCHED_FILES=(
  "src/components/SettingsPanel.tsx"
  "src/components/Sidebar.tsx"
  "src/components/MobileApp.tsx"
  "src/components/ChatPane.tsx"
  "src/store/gatewayStore.ts"
  "server/index.js"
  "db/schema.sql"
)

CONFLICTS=()
for f in "${PATCHED_FILES[@]}"; do
  if echo "$CHANGED_FILES" | grep -q "^$f$"; then
    CONFLICTS+=("$f")
  fi
done

if [ ${#CONFLICTS[@]} -gt 0 ]; then
  echo "⚠️  Upstream touches locally-patched files:"
  for f in "${CONFLICTS[@]}"; do
    echo "   - $f"
  done
  echo ""
  echo "   Patches will be re-applied after merge."
  echo "   If upstream added similar features, the patch script will"
  echo "   detect the marker and skip (idempotent). Review the output."
  echo ""
fi

# 3. Backup before merge (rollback point)
echo "── Snapshotting current state before merge..."
bash scripts/backup.sh
echo ""

# 4. Merge
echo "── Merging..."
git merge origin/main --no-edit

echo ""
echo "── Re-applying local patches..."
node scripts/apply-local-patches.cjs
echo ""
echo "   Note: patches marked [skip] mean upstream added similar behavior."
echo "   Review those files to confirm the best version is in place."
echo ""

# 4. Verify
echo "── Verifying all patches..."
FAIL=0
check() {
  if grep -q "$2" "$1" 2>/dev/null; then
    echo "   ✅ $3"
  else
    echo "   ❌ MISSING: $3"
    FAIL=1
  fi
}
check "src/components/SettingsPanel.tsx"  "AutoResizeTextarea"        "Quick commands textarea"
check "src/components/SettingsPanel.tsx"  "hasLocalCustom"            "Settings localStorage-primary"
check "src/components/Sidebar.tsx"        "hiddenProjectSlugs"        "Slack filter desktop"
check "src/components/MobileApp.tsx"      "hiddenSlugs"               "Slack filter mobile"
check "src/components/Sidebar.tsx"        "archivesLoaded"            "Archives fetch on switch"
check "src/components/MobileApp.tsx"      "showSettings"              "Settings on mobile"
check "src/components/ChatPane.tsx"       "Phase 1: show cached"      "ChatPane cache-first"
check "src/store/gatewayStore.ts"         "Replace the list entirely" "hydrateHiddenFromServer"
check "server/index.js"                   "UUID_RE"                   "Archive label fix"

if [ $FAIL -ne 0 ]; then
  echo ""
  echo "❌ Some patches didn't apply. Fix apply-local-patches.cjs, then:"
  echo "   node scripts/apply-local-patches.cjs && npm run build && pm2 restart octis"
  exit 1
fi

echo ""
echo "── Building..."
npm run build

echo "── Restarting..."
pm2 restart octis

echo ""
bash scripts/healthcheck.sh 30
echo "✅ Pull complete. All local fixes intact."
