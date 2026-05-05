# Octis Merge Safety Checklist

**Purpose:** Prevent deployment-breaking merges. Use this before pushing any merge commit.

---

## Critical Files That Must Survive Merges

These files/settings MUST be correct after any merge from `origin/main`:

### 1. `vite.config.js`
- **Setting:** `base: '/octis/'`
- **Why critical:** Without this, built assets have wrong paths (`/assets/` instead of `/octis/assets/`), causing 404s
- **Protection:** Patch 0 in `scripts/apply-local-patches.cjs`
- **Incident:** 2026-05-04 — merge reverted to `base: '/'`, broke entire site

### 2. `ecosystem.config.cjs` (PM2 config)
- **Setting:** `GATEWAY_URL: '/gateway'`
- **Why critical:** Browser WebSocket connection path
- **Protection:** File is tracked but doesn't change in upstream
- **Status:** ✅ Currently safe (no upstream changes expected)

### 3. `.env`
- **Status:** Gitignored
- **Protection:** ✅ Never touched by git

### 4. `server/config/agents.json`
- **Setting:** Ghosty agent configuration
- **Protection:** File is tracked but doesn't change in upstream
- **Status:** ✅ Currently safe

---

## Post-Merge Validation (MANDATORY)

After ANY merge from `origin/main`, run these checks:

```bash
# 1. Apply local patches
node scripts/apply-local-patches.cjs

# 2. Verify vite base path
grep "base: '/octis/'" vite.config.js || echo "❌ VITE BASE PATH BROKEN"

# 3. Build
npm run build

# 4. Verify built asset paths
grep "/octis/assets/" dist/index.html || echo "❌ BUILT ASSETS HAVE WRONG PATHS"

# 5. Restart service
npx pm2 delete octis-server && npx pm2 start ecosystem.config.cjs

# 6. Health check
sleep 3 && curl -s http://localhost:3747/api/health

# 7. Browser test
# Open https://kennan-openclaw.duckdns.org/octis/
# Check browser console for 404 errors
```

---

## Universal Merge Rule (Kennan + Casin)

**The patch script must work for BOTH deployments:**

- **Kennan's deployment:** `/opt/octis/`, served at `/octis/` via Caddy
- **Casin's deployment:** TBD (but same codebase)

**Rule:** Any deployment-specific config MUST use:
1. `.env` (gitignored) for secrets/tokens, OR
2. `vite.config.local.js` (gitignored) for vite overrides, OR
3. `apply-local-patches.cjs` for code patches

Never hardcode deployment-specific values in tracked files unless they're in the patch script.

---

## Why This Happened (2026-05-04)

**Root cause:** `vite.config.js` base path was a LOCAL change in kennan-local-changes, but NOT registered in the patch script.

**What went wrong:**
1. Merge brought in upstream's `base: '/'`
2. Conflict resolution kept upstream's value (because it looked "clean")
3. Build succeeded but generated wrong asset paths
4. Site broke with 404s

**Fix:**
1. Added Patch 0 to `apply-local-patches.cjs`
2. Patch now runs automatically after every `git pull` via post-merge hook

---

## Future Merge Protocol

1. **Before merge:** Create backup branch
2. **After merge:** Run `node scripts/apply-local-patches.cjs`
3. **After patches:** Run full validation checklist above
4. **Before push:** Browser-test the site manually
5. **If anything breaks:** Fix it, commit fix, re-validate

**Never assume a successful build means the site works.**
