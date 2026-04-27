import { useEffect, useRef } from 'react'

interface Props {
  sessionLabel: string
  onConfirm: () => void
  onCancel: () => void
}

export function DeleteConfirmModal({ sessionLabel, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { confirmRef.current?.focus() }, [])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div
        className="relative bg-[#1a1d2e] border border-[#3a4152] rounded-2xl shadow-2xl w-[340px] max-w-[90vw] p-6 flex flex-col gap-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">🗑️</span>
          <h2 className="text-white font-semibold text-base leading-tight">Delete session?</h2>
        </div>
        <div className="text-[13px] text-[#9ca3af] leading-relaxed">
          <span className="text-white font-medium break-words">{sessionLabel}</span>
          {' '}will be permanently deleted. All history will be removed. This cannot be undone.
        </div>
        <div className="flex gap-2 justify-end mt-1">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-[#9ca3af] hover:text-white hover:bg-[#2a3142] transition-colors"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            Delete forever
          </button>
        </div>
      </div>
    </div>
  )
}
