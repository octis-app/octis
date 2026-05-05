import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// One-time migration: old code stored raw 'true'/'false' under 'octis-noise-hidden'.
// Read it once before Zustand takes over, then remove it.
function migrateNoiseHidden(): boolean {
  try {
    const raw = localStorage.getItem('octis-noise-hidden')
    if (raw === 'true' || raw === 'false') {
      localStorage.removeItem('octis-noise-hidden')
      return raw !== 'false'
    }
  } catch { /* ignore */ }
  return true // default: chat only
}

interface UIState {
  noiseHidden: boolean
  setNoiseHidden: (v: boolean) => void
  toggleNoise: () => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      noiseHidden: migrateNoiseHidden(),
      setNoiseHidden: (v) => set({ noiseHidden: v }),
      toggleNoise: () => set({ noiseHidden: !get().noiseHidden }),
    }),
    {
      name: 'octis-ui-prefs',
      partialize: (state) => ({ noiseHidden: state.noiseHidden }),
    }
  )
)
