import { useState } from 'react'
import { useAuth } from '../lib/auth'

const API = (import.meta.env.VITE_API_URL as string) || ''

const TYPES = [
  { id: 'bug',     label: '🐛 Bug',        ghLabel: 'bug' },
  { id: 'feature', label: '✨ Feature',     ghLabel: 'enhancement' },
  { id: 'ux',      label: '🎨 UX / Design', ghLabel: 'ux' },
]

interface Props {
  onClose: () => void
  context?: { view?: string; sessionKey?: string }
}

export default function IssueReporter({ onClose, context = {} }: Props) {
  const { getToken } = useAuth()
  const [type, setType]     = useState('bug')
  const [title, setTitle]   = useState('')
  const [body, setBody]     = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ url: string; number: number } | null>(null)
  const [error, setError]   = useState('')

  const handleSubmit = async () => {
    if (!title.trim()) return
    setLoading(true)
    setError('')
    try {
      const token = await getToken()

      const autoCtx = [
        context.view       ? `**View:** ${context.view}`                   : '',
        context.sessionKey ? `**Session:** \`${context.sessionKey}\``      : '',
        `**Viewport:** ${window.innerWidth}×${window.innerHeight}`,
        `**UA:** ${navigator.userAgent.slice(0, 120)}`,
      ].filter(Boolean).join('\n')

      const fullBody = [
        body.trim(),
        autoCtx ? `---\n**Context**\n${autoCtx}` : '',
      ].filter(Boolean).join('\n\n')

      const res = await fetch(`${API}/api/issues`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          credentials: 'include',
        },
        body: JSON.stringify({ type, title: title.trim(), body: fullBody }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create issue')
      setResult({ url: data.url, number: data.number })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#181c24] border border-[#2a3142] rounded-xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a3142]">
          <h2 className="text-white font-semibold text-sm">🐛 Report Issue</h2>
          <button
            onClick={onClose}
            className="text-[#6b7280] hover:text-white text-xl leading-none transition-colors"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {result ? (
            /* ── Success ── */
            <div className="text-center py-6 space-y-3">
              <div className="text-3xl">✅</div>
              <div className="text-white font-medium text-sm">Issue #{result.number} created</div>
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#6366f1] hover:underline text-sm block"
              >
                View on GitHub →
              </a>
              <button
                onClick={onClose}
                className="mt-2 text-xs text-[#6b7280] hover:text-white transition-colors"
              >
                Close
              </button>
            </div>
          ) : (
            <>
              {/* Type picker */}
              <div className="flex gap-2">
                {TYPES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => setType(t.id)}
                    className={`flex-1 py-2 px-2 rounded-lg text-xs font-medium transition-colors border ${
                      type === t.id
                        ? 'bg-[#6366f1] border-[#6366f1] text-white'
                        : 'bg-[#0f1117] border-[#2a3142] text-[#6b7280] hover:border-[#6366f1] hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Title */}
              <input
                autoFocus
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) void handleSubmit() }}
                placeholder="Short title…"
                className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4b5563] focus:outline-none focus:border-[#6366f1] transition-colors"
              />

              {/* Description */}
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Steps to reproduce, expected vs actual… (optional)"
                rows={4}
                className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white placeholder-[#4b5563] focus:outline-none focus:border-[#6366f1] transition-colors resize-none"
              />

              {error && (
                <div className="text-red-400 text-xs bg-red-400/10 rounded-lg px-3 py-2">{error}</div>
              )}

              <button
                onClick={() => void handleSubmit()}
                disabled={loading || !title.trim()}
                className="w-full bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-50 text-white text-sm rounded-lg py-2.5 font-medium transition-colors"
              >
                {loading ? 'Submitting…' : 'Submit to GitHub'}
              </button>

              <p className="text-[#4b5563] text-xs text-center">
                Creates an issue on{' '}
                <a
                  href="https://github.com/octis-app/octis/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#6366f1] hover:underline"
                >
                  octis-app/octis
                </a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
