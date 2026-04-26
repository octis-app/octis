// ─── Message cache (localStorage — survives pane unmount) ──────────────────────
// Shared between ChatPane and useSessionPreloader.

export const MSG_CACHE_PREFIX = 'octis-msg-cache-'
export const MSG_CACHE_TS_PREFIX = 'octis-msg-cache-ts-'

export interface CachedMessage {
  id: string | number
  role: string
  content: string
  ts?: string
  [key: string]: unknown
}

export function loadMsgCache(key: string): CachedMessage[] {
  try {
    const raw = localStorage.getItem(MSG_CACHE_PREFIX + key)
    return raw ? (JSON.parse(raw) as CachedMessage[]) : []
  } catch { return [] }
}

export function saveMsgCache(key: string, msgs: CachedMessage[]) {
  try {
    // Exclude optimistic messages (numeric ids) — they get filtered on load when
    // pendingOptimisticIdRef.current is null (fresh state), causing visible disappear.
    const toSave = msgs.filter(m => typeof m.id !== 'number')
    localStorage.setItem(MSG_CACHE_PREFIX + key, JSON.stringify(toSave.slice(-150)))
    // Track timestamp for staleness checks
    localStorage.setItem(MSG_CACHE_TS_PREFIX + key, new Date().toISOString())
  } catch {}
}

export function getMsgCacheAgeMs(key: string): number {
  try {
    const raw = localStorage.getItem(MSG_CACHE_TS_PREFIX + key)
    if (!raw) return Infinity
    return Date.now() - new Date(raw).getTime()
  } catch { return Infinity }
}