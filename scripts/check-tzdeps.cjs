#!/usr/bin/env node
/**
 * check-tzdeps.js — TDZ (Temporal Dead Zone) dep-array scanner
 *
 * React's useEffect/useCallback/useMemo dep arrays are EVALUATED DURING RENDER.
 * If a dep array references a variable declared AFTER the hook call in the component body,
 * that variable is in TDZ → runtime crash (e.g. "Cannot access 'X' before initialization").
 *
 * This script scans all .tsx/.ts files and reports any hooks whose dep arrays
 * reference identifiers declared later in the same file scope.
 *
 * Usage:
 *   node scripts/check-tzdeps.js [file-glob]
 *   node scripts/check-tzdeps.js src/**\/*.tsx
 */

const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')

const ROOT = path.join(__dirname, '..')

// Hooks whose LAST argument is a dep array
const HOOKS_WITH_DEPS = new Set(['useEffect', 'useCallback', 'useMemo', 'useLayoutEffect'])

let errors = 0

function scanFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8')
  const lines = src.split('\n')

  // Simple line-by-line tracking of:
  // 1. Variable declarations (const/let/type)
  // 2. useEffect/useCallback/useMemo calls and their dep arrays

  // Map: identifier → first line it's declared on (1-indexed)
  const declarations = new Map()
  // Collect hooks: { line, hook, depLine, deps }
  const hookCalls = []

  let inComponent = false // rough heuristic: after "export default function" or "function XxxYyy("

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i]

    // Track component scope (rough — just track all const/let at any indent)
    // Look for variable declarations
    const declMatch = line.match(/^\s+(?:const|let)\s+(?:\[([^\]]+)\]|\{([^}]+)\}|(\w+))\s*[=:,]/)
    if (declMatch) {
      const destructure = declMatch[1] || declMatch[2]
      const single = declMatch[3]
      if (single && !declarations.has(single)) {
        declarations.set(single, lineNo)
      }
      if (destructure) {
        // Parse destructured names: [a, b, c] or {x, y: z, ...}
        const names = destructure.split(',').map(s => {
          // Handle {a: b} → b is the local name; [a, b] → a, b
          const colon = s.indexOf(':')
          if (colon >= 0) return s.slice(colon + 1).trim().split(' ')[0]
          return s.trim().split(' ')[0].replace(/^\[/, '').replace(/\]$/, '')
        }).filter(n => n && /^\w+$/.test(n))
        for (const name of names) {
          if (!declarations.has(name)) declarations.set(name, lineNo)
        }
      }
    }

    // Find useEffect/useCallback/useMemo with dep arrays
    // Pattern: hookName(callback, [dep1, dep2, ...]) — possibly multiline but dep array usually on last line
    const hookMatch = line.match(/\b(useEffect|useCallback|useMemo|useLayoutEffect)\s*\(/)
    if (hookMatch) {
      const hookName = hookMatch[1]
      // Scan forward to find the closing ], [dep1, dep2] pattern
      // We look for }, [...] or , [...] at the end of any line in the next 20 lines
      for (let j = i; j < Math.min(i + 30, lines.length); j++) {
        const depLine = lines[j]
        // Match dep array: }, [x, y]) or , [x, y]) — closing the hook call
        const depMatch = depLine.match(/[,}]\s*\[([^\]]*)\]\s*\)/)
        if (depMatch) {
          const depContent = depMatch[1].trim()
          if (depContent === '') break // empty deps — safe
          // Extract identifiers from dep array
          const deps = depContent.split(',').map(d => {
            // Handle: sessionKey, ws, connected, send?.thing, session?.key, etc.
            return d.trim().split(/[?.[\s]/)[0]
          }).filter(d => d && /^\w+$/.test(d) && d !== 'null' && d !== 'undefined' && d !== 'true' && d !== 'false')
          hookCalls.push({ line: lineNo, hook: hookName, depLine: j + 1, deps })
          break
        }
        // If we hit the closing paren without a dep array, skip
        if (depLine.match(/^\s*\}\s*\)\s*$/) || depLine.match(/^\s*\)\s*$/)) break
      }
    }
  }

  // Now cross-reference: for each hook, check if any dep is declared AFTER the hook call
  const fileErrors = []
  for (const { line: hookLine, hook, depLine, deps } of hookCalls) {
    for (const dep of deps) {
      const declLine = declarations.get(dep)
      if (declLine && declLine > hookLine) {
        fileErrors.push(
          `  TDZ: ${hook} at line ${hookLine} dep array (line ${depLine}) references "${dep}" ` +
          `declared at line ${declLine} (${declLine - hookLine} lines later)`
        )
        errors++
      }
    }
  }

  if (fileErrors.length > 0) {
    console.error(`\n❌ ${path.relative(ROOT, filePath)}`)
    for (const e of fileErrors) console.error(e)
  }
}

// Resolve files
const patterns = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['src/**/*.tsx', 'src/**/*.ts', 'src/**/*.jsx', 'src/**/*.js']

const files = patterns.flatMap(p =>
  globSync(p, { cwd: ROOT, absolute: true, ignore: ['**/node_modules/**', '**/dist/**'] })
)

if (files.length === 0) {
  console.log('No files matched.')
  process.exit(0)
}

console.log(`Scanning ${files.length} files for TDZ dep-array risks…`)
for (const f of files) scanFile(f)

if (errors > 0) {
  console.error(`\n✖ Found ${errors} TDZ risk(s). Fix before shipping.\n`)
  process.exit(1)
} else {
  console.log(`✓ No TDZ dep-array risks found in ${files.length} files.`)
  process.exit(0)
}
