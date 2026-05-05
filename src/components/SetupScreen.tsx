import { useState } from 'react'
import { useGatewayStore } from '../store/gatewayStore'

const API = (import.meta.env.VITE_API_URL as string) || ''

interface SetupScreenProps {
  getToken: () => Promise<string | null>
  onComplete: (role: string) => void
}

export default function SetupScreen({ getToken, onComplete }: SetupScreenProps) {
  const { setCredentials, connect } = useGatewayStore()
  const [url, setUrl] = useState('wss://')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'error' | 'success'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const handleSave = async () => {
    if (!url.trim() || url === 'wss://') {
      setErrorMsg('Gateway URL is required')
      setStatus('error')
      return
    }
    if (!token.trim()) {
      setErrorMsg('Token is required')
      setStatus('error')
      return
    }
    setStatus('saving')
    setErrorMsg('')
    try {
      const authToken = await getToken()
      const res = await fetch(`${API}/api/gateway-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ url: url.trim(), token: token.trim() }),
      })
      const data = await res.json() as { ok?: boolean; error?: string; role?: string }
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save')
      // Connect immediately
      setCredentials(url.trim(), token.trim(), '')
      connect()
      setStatus('success')
      onComplete(data.role || 'member')
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to save gateway config')
      setStatus('error')
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[#0f1117]">
      <div className="w-full max-w-md px-4">
        <div className="flex flex-col items-center gap-2 mb-8">
          <span className="text-4xl">🐙</span>
          <h1 className="text-2xl font-bold text-white tracking-tight">Octis</h1>
          <p className="text-sm text-[#6b7280]">Connect your OpenClaw gateway to get started</p>
        </div>

        <div className="bg-[#181c24] border border-[#2a3142] rounded-2xl p-6 shadow-2xl">
          <h2 className="text-base font-semibold text-white mb-1">Connect your gateway</h2>
          <p className="text-sm text-[#6b7280] mb-5">
            You'll need your OpenClaw gateway URL and token. Find them in your OpenClaw config or dashboard.
          </p>

          <label className="block text-xs text-[#6b7280] uppercase tracking-wider mb-1">Gateway URL</label>
          <input
            className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white mb-4 outline-none focus:border-[#6366f1] transition-colors"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="wss://your-server.example.com/ws"
            disabled={status === 'saving' || status === 'success'}
            autoFocus
          />

          <label className="block text-xs text-[#6b7280] uppercase tracking-wider mb-1">Token</label>
          <input
            className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white mb-4 outline-none focus:border-[#6366f1] transition-colors"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Your gateway auth token"
            disabled={status === 'saving' || status === 'success'}
            onKeyDown={(e) => e.key === 'Enter' && status === 'idle' && void handleSave()}
          />

          {status === 'error' && (
            <div className="text-red-400 text-sm mb-4 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              ❌ {errorMsg}
            </div>
          )}

          {status === 'success' && (
            <div className="text-green-400 text-sm mb-4 bg-green-400/10 border border-green-400/20 rounded-lg px-3 py-2">
              ✅ Connected! Loading your sessions…
            </div>
          )}

          <button
            onClick={() => void handleSave()}
            disabled={status === 'saving' || status === 'success'}
            className="w-full bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
          >
            {status === 'saving' ? 'Connecting…' : status === 'success' ? 'Connected!' : 'Connect'}
          </button>

          <p className="text-xs text-[#4b5563] mt-4 text-center">
            Your gateway URL and token are stored securely on this server, tied to your account.
          </p>
        </div>
      </div>
    </div>
  )
}
