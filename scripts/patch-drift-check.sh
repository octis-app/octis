#!/bin/bash
# patch-drift-check.sh — verify all local patches are still present in source files.
# Run via cron daily. Alerts if any patch has gone missing.

cd "$(dirname "$0")/.."
FAIL=0

check() {
  local file="$1" marker="$2" desc="$3"
  if ! grep -q "$marker" "$file" 2>/dev/null; then
    echo "❌ DRIFT: $desc"
    echo "   File: $file"
    echo "   Missing marker: $marker"
    FAIL=1
  fi
}

check "src/components/SettingsPanel.tsx"  "AutoResizeTextarea"          "Quick commands textarea"
check "src/components/SettingsPanel.tsx"  "localStorage is primary"      "Settings localStorage-primary"
check "src/components/SettingsPanel.tsx"  "qcSaveStatus"                "Settings save indicator"
check "src/components/Sidebar.tsx"        "hiddenProjectSlugs"          "Slack filter (desktop)"
check "src/components/Sidebar.tsx"        'name="Untagged"'             "Untagged collapsible"
check "src/components/Sidebar.tsx"        "Load projectMeta on mount"   "projectMeta on mount"
check "src/components/Sidebar.tsx"        "archivesLoaded"              "Archives fetch on switch"
check "src/components/Sidebar.tsx"        "Archived ({hiddenSessions"   "Archives uses hiddenSessions"
check "src/components/MobileApp.tsx"      "hiddenSlugs"                 "Slack filter (mobile)"
check "src/components/MobileApp.tsx"      "showSettings"                "Settings on mobile"
check "src/components/ChatPane.tsx"       "Phase 1: show cached"        "ChatPane cache-first"
check "src/store/gatewayStore.ts"         "Replace the list entirely"   "hydrateHiddenFromServer"
check "server/index.js"                   "UUID_RE"                     "Archive label fix"
check "server/index.js"                   "app.get('/api/settings'"     "User settings endpoint"
check "db/schema.sql"                     "user_settings"               "user_settings table"
check "src/components/DeleteConfirmModal.tsx" "DeleteConfirmModal"       "Delete confirm modal"
check "server/index.js"                   "/api/session-delete"         "Session delete endpoint"
check "src/components/Sidebar.tsx"        "onDelete"                    "Sidebar delete menu item"
check "src/components/ChatPane.tsx"       "showDeleteConfirm"           "ChatPane delete button"
check "src/components/MobileApp.tsx"      "deleteConfirmSession"        "Mobile delete flow"
check "src/store/gatewayStore.ts"         "hiddenStore.isHidden(s.key)" "pendingLocal isHidden guard"
check "src/components/Sidebar.tsx"        "pendingPaneKey"              "Session creation deferred pane open"
check "src/App.tsx"                       "claimSession"                "N-key hotkey claimSession"
check "src/components/MobileApp.tsx"      "claimSession"                "Mobile new session claimSession"
check "server/index.js"                   "ORDER BY hidden_at DESC"     "Archive sort by hidden_at"
check "src/components/Sidebar.tsx"        "handleProjectDrop"           "Sidebar drag-to-project"
check "src/store/gatewayStore.ts"         '!s.hydrated'                 "hydrateFromServer server-wins"
check "src/App.tsx"                       'if (!hash)'                  "Hash replaceState on initial load"
check "src/components/MobileApp.tsx"      'if (!hash)'                  "Mobile hash replaceState on initial load"

if [ $FAIL -eq 0 ]; then
  echo "✅ All $(grep -c "^check" "$0") patches present"
  exit 0
else
  echo ""
  echo "⚠️  Patch drift detected. Run: node scripts/apply-local-patches.cjs"
  exit 1
fi
