import { useEffect } from 'react'

export interface HotkeyAction {
  /** e.g. 'n', 'Backspace' */
  key: string
  /** Require Cmd (Mac) or Ctrl (Win/Linux) */
  cmdOrCtrl?: boolean
  /** Require Shift */
  shift?: boolean
  /** Require Alt/Option */
  alt?: boolean
  /** Handler to call */
  handler: (e: KeyboardEvent) => void
  /** Don't fire when focus is in an input/textarea */
  ignoreInputs?: boolean
}

export function useHotkeys(actions: HotkeyAction[]) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey

      for (const action of actions) {
        if (action.key.toLowerCase() !== e.key.toLowerCase()) continue
        if (action.cmdOrCtrl && !isMeta) continue
        if (action.shift && !e.shiftKey) continue
        if (action.alt && !e.altKey) continue

        // For bare-key shortcuts: reject if any unintended modifier is held
        // (prevents e.g. Ctrl+Shift+R triggering the bare 'R' handler)
        if (!action.cmdOrCtrl && isMeta) continue
        if (!action.shift && e.shiftKey) continue
        if (!action.alt && e.altKey) continue

        if (action.ignoreInputs) {
          const target = e.target as HTMLElement
          const tag = target.tagName.toLowerCase()
          if (tag === 'input' || tag === 'textarea' || target.isContentEditable) continue
        }

        // SAFETY: Bare-key shortcuts (no modifiers) should ONLY fire when explicitly safe.
        // Disable all bare-key shortcuts unless we're CERTAIN the user intended it.
        // This prevents accidental triggers when browsing UI elements, session lists, etc.
        const isBareKey = !action.cmdOrCtrl && !action.shift && !action.alt
        if (isBareKey) {
          // Only allow bare-key shortcuts if NOTHING has focus (document.body or null)
          // OR if explicitly focused on body (not a button, div, etc.)
          const activeEl = document.activeElement
          const isBodyOrNull = !activeEl || activeEl === document.body
          if (!isBodyOrNull) continue
        }

        e.preventDefault()
        action.handler(e)
        break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions])
}
