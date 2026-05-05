import { useRef, useCallback } from 'react'

/**
 * Microsoft Word-style undo/redo for controlled textareas.
 *
 * Burst coalescing: characters typed within BURST_MS of each other form one undo unit.
 * A pause > BURST_MS ends the burst — next keystroke starts a new unit.
 *
 * Usage:
 *   const undo = useTextareaUndo()
 *   // In onChange: undo.push(currentValue) BEFORE calling setInput(newValue)
 *   // In onKeyDown: handle Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
 */

const BURST_MS = 1500 // pause > 1.5s = new undo unit

export interface TextareaUndoHandle {
  /** Call with the value BEFORE the change (current React state) on each onChange */
  push: (valueBefore: string) => void
  /** Undo: returns the value to restore, or null if nothing to undo */
  undo: (currentValue: string) => string | null
  /** Redo: returns the value to restore, or null if nothing to redo */
  redo: (currentValue: string) => string | null
  /** True when undo stack is non-empty */
  canUndo: () => boolean
  /** True when redo stack is non-empty */
  canRedo: () => boolean
  /** Clear all history (call when session/key changes) */
  reset: () => void
  /**
   * Convenience keydown handler.
   * Pass current input value + a setter; it will call setInput and return true if handled.
   */
  handleKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
    currentValue: string,
    setValue: (v: string) => void,
    onAfterUndo?: (v: string) => void
  ) => boolean
}

export function useTextareaUndo(): TextareaUndoHandle {
  const undoStack = useRef<string[]>([])
  const redoStack = useRef<string[]>([])
  const inBurst = useRef(false)
  const lastChangeMs = useRef(0)
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const push = useCallback((valueBefore: string) => {
    const now = Date.now()
    const gap = now - lastChangeMs.current
    lastChangeMs.current = now

    if (!inBurst.current || gap > BURST_MS) {
      // New burst begins — save the value BEFORE this burst to the undo stack
      undoStack.current = [...undoStack.current.slice(-99), valueBefore]
      redoStack.current = [] // new typing always clears redo
      inBurst.current = true
    }
    // Reset burst-end timer on every keystroke
    if (burstTimer.current) clearTimeout(burstTimer.current)
    burstTimer.current = setTimeout(() => {
      inBurst.current = false
      burstTimer.current = null
    }, BURST_MS)
  }, [])

  const undo = useCallback((currentValue: string): string | null => {
    if (undoStack.current.length === 0) return null
    const prev = undoStack.current.pop()!
    redoStack.current = [currentValue, ...redoStack.current.slice(0, 99)]
    // End burst so next keystroke starts a fresh undo unit
    inBurst.current = false
    if (burstTimer.current) { clearTimeout(burstTimer.current); burstTimer.current = null }
    return prev
  }, [])

  const redo = useCallback((currentValue: string): string | null => {
    if (redoStack.current.length === 0) return null
    const next = redoStack.current.shift()!
    undoStack.current = [...undoStack.current.slice(-99), currentValue]
    inBurst.current = false
    return next
  }, [])

  const canUndo = useCallback(() => undoStack.current.length > 0, [])
  const canRedo = useCallback(() => redoStack.current.length > 0, [])

  const reset = useCallback(() => {
    undoStack.current = []
    redoStack.current = []
    inBurst.current = false
    lastChangeMs.current = 0
    if (burstTimer.current) { clearTimeout(burstTimer.current); burstTimer.current = null }
  }, [])

  const handleKeyDown = useCallback((
    e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
    currentValue: string,
    setValue: (v: string) => void,
    onAfterUndo?: (v: string) => void
  ): boolean => {
    const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z'
    const isRedo = (e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))
    if (isUndo) {
      e.preventDefault()
      const prev = undo(currentValue)
      if (prev !== null) { setValue(prev); onAfterUndo?.(prev) }
      return true
    }
    if (isRedo) {
      e.preventDefault()
      const next = redo(currentValue)
      if (next !== null) { setValue(next); onAfterUndo?.(next) }
      return true
    }
    return false
  }, [undo, redo])

  return { push, undo, redo, canUndo, canRedo, reset, handleKeyDown }
}
