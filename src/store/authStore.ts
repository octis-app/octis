/**
 * authStore — tracks the current user's role, owned session keys, and main agent.
 * Used to filter the session list for isolation across users.
 */
import { create } from 'zustand'
import { authFetch } from '../lib/authFetch'

const API = (import.meta as any).env?.VITE_API_URL || ''

interface AuthState {
  role: string | null
  userId: string | null
  mainAgentId: string | null
  /** null = not yet loaded; 'all' = legacy owner sees everything; Set = owned session keys */
  ownedSessions: Set<string> | 'all' | null
  setAuth: (role: string | null, userId: string | null) => void
  setMainAgentId: (id: string) => void
  fetchOwnedSessions: () => Promise<void>
  claimSession: (sessionKey: string) => void
  isOwner: () => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  role: null,
  userId: null,
  mainAgentId: null,
  ownedSessions: null,

  setAuth: (role, userId) => set({ role, userId }),

  setMainAgentId: (id) => set({ mainAgentId: id }),

  fetchOwnedSessions: async () => {
    try {
      const res = await authFetch(`${API}/api/my-sessions`)
      if (!res.ok) return
      const data = await res.json() as { all: boolean; mainAgentId?: string; sessionKeys: string[] }
      if (data.all) {
        // Legacy: old server returned all:true for owners
        set({ ownedSessions: 'all' })
      } else {
        if (data.mainAgentId) set({ mainAgentId: data.mainAgentId })
        set({ ownedSessions: new Set(data.sessionKeys) })
      }
    } catch {
      // fail open — don't block the UI
    }
  },

  claimSession: (sessionKey: string) => {
    const { ownedSessions } = get()
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
