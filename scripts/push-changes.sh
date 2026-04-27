#!/usr/bin/env bash
# push-changes.sh — Commit all local changes to kennan-local-changes branch and push.
# Usage:
#   bash scripts/push-changes.sh minor "what changed"   → small fix
#   bash scripts/push-changes.sh major "what changed"   → big feature batch
#   bash scripts/push-changes.sh "what changed"         → defaults to minor
#   bash scripts/push-changes.sh                        → defaults to minor, prompts for message

set -e
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Parse args: optional bump type (major/minor) + required summary message
if [ "$1" = "major" ] || [ "$1" = "minor" ]; then
  BUMP="$1"
  SUMMARY="$2"
else
  BUMP="minor"
  SUMMARY="$1"
fi

# Require a summary message
if [ -z "$SUMMARY" ]; then
  echo "❌ Commit message required."
  echo "   Usage: bash scripts/push-changes.sh [major|minor] \"what changed\""
  exit 1
fi

BRANCH="kennan-local-changes"

# ── 1. Ensure we know about the remote branch ────────────────────────────────
git fetch origin "$BRANCH" --quiet 2>/dev/null || true

# ── 2. Read + bump version ────────────────────────────────────────────────────
CURRENT_VERSION="$(cat VERSION 2>/dev/null | tr -d '[:space:]' || echo '1.00')"
MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)
MINOR=$(echo "$CURRENT_VERSION" | cut -d. -f2 | sed 's/^0*//')
MINOR="${MINOR:-0}"

if [ "$BUMP" = "major" ]; then
  MAJOR=$((MAJOR + 1))
  MINOR=0
else
  MINOR=$((MINOR + 1))
fi

NEW_VERSION="${MAJOR}.$(printf '%02d' $MINOR)"
echo "$NEW_VERSION" > VERSION
echo "📦 Version: $CURRENT_VERSION → $NEW_VERSION"

# ── 3. Snapshot current main-branch HEAD for reference ───────────────────────
MAIN_HEAD=$(git rev-parse main 2>/dev/null || echo "unknown")

# ── 4. Stage all modified + untracked files (respects .gitignore) ────────────
# Always ensure sensitive dirs/files are untracked before staging
git rm -r --cached backups/ 2>/dev/null || true
git rm --cached .env.production 2>/dev/null || true
git add -A
# Re-exclude env.production explicitly (it may be tracked in upstream)
git reset HEAD .env.production 2>/dev/null || true

# ── 5. Check if anything to commit ───────────────────────────────────────────
if git diff --cached --quiet; then
  echo "✅ Nothing to commit — working tree clean."
  exit 0
fi

# ── 6. Build commit message ───────────────────────────────────────────────────
CHANGED_FILES=$(git diff --cached --name-only | head -20 | tr '\n' ' ')
DATE_UTC=$(date -u +"%Y-%m-%d %H:%M UTC")

MSG="v${NEW_VERSION} — ${SUMMARY}

Date: ${DATE_UTC}
Based on upstream: ${MAIN_HEAD:0:7}
Changed: ${CHANGED_FILES}"

# ── 7. Commit ────────────────────────────────────────────────────────────────
git commit -m "$MSG"
echo "✅ Committed: $MSG"

# ── 8. Push to kennan-local-changes ──────────────────────────────────────────
# We push from wherever we are using the refspec main-content → kennan-local-changes
# Always force-push since this branch is a snapshot, not a shared history branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push origin "HEAD:refs/heads/${BRANCH}" --force
echo "✅ Pushed to origin/${BRANCH}"

# ── 9. Also git-tag the version (lightweight tag on current HEAD) ─────────────
TAG="v${NEW_VERSION}"
git tag -f "$TAG"
git push origin "$TAG" --force 2>/dev/null || true
echo "🏷️  Tagged: ${TAG}"

echo ""
echo "Done. Branch origin/${BRANCH} is now at v${NEW_VERSION}."
