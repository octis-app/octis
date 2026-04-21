/**
 * authStore — tracks the current user's role and owned session keys.
 * Used to filter the session list for non-owner users.
 */
import { create } from 'zustand'
import { authFetch } from '../lib/authFetch'

const API = (import.meta as any).env?.VITE_API_URL || ''

interface AuthState {
  role: string | null
  userId: string | null
  /** null = not yet loaded; 'all' = owner sees everything; Set = owned session keys */
  ownedSessions: Set<string> | 'all' | null
  setAuth: (role: string | null, userId: string | null) => void
  fetchOwnedSessions: () => Promise<void>
  claimSession: (sessionKey: string) => void
  isOwner: () => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  role: null,
  userId: null,
  ownedSessions: null,

  setAuth: (role, userId) => set({ role, userId }),

  fetchOwnedSessions: async () => {
    try {
      const res = await authFetch(`${API}/api/my-sessions`)
      if (!res.ok) return
      const data = await res.json() as { all: boolean; sessionKeys: string[] }
      if (data.all) {
        set({ ownedSessions: 'all' })
      } else {
        set({ ownedSessions: new Set(data.sessionKeys) })
      }
    } catch {
      // fail open — don't block the UI
    }
  },

  claimSession: (sessionKey: string) => {
    const { ownedSessions, role } = get()
    // Owners don't need to claim anything
    if (role === 'owner' || role === 'admin') return
    // Optimistically add to local set
    const current = ownedSessions instanceof Set ? new Set(ownedSessions) : new Set<string>()
    current.add(sessionKey)
    set({ ownedSessions: current })
    // Persist to server (fire and forget)
    authFetch(`${API}/api/session-ownership/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey }),
    }).catch(() => {})
  },

  isOwner: () => {
    const { role } = get()
    return role === 'owner' || role === 'admin'
  },
}))
