import { useState, useEffect, useRef } from 'react'
import { useGatewayStore } from '../store/gatewayStore'

interface ConnectModalProps {
  onClose: () => void
}

export default function ConnectModal({ onClose }: ConnectModalProps) {
  const { gatewayUrl, gatewayToken, setCredentials, connect, connected } = useGatewayStore()
  const [url, setUrl] = useState(
    gatewayUrl || (import.meta.env.VITE_GATEWAY_URL as string) || ''
  )
  const [token, setToken] = useState(
    gatewayToken || (import.meta.env.VITE_GATEWAY_TOKEN as string) || ''
  )
  const [status, setStatus] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (status === 'connecting' && connected) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      setStatus('idle')
      onClose()
    }
  }, [connected, status, onClose])

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  const handleConnect = () => {
    if (!url.trim()) {
      setErrorMsg('Gateway URL is required')
      setStatus('error')
      return
    }
    if (!token.trim()) {
      setErrorMsg('Token is required')
      setStatus('error')
      return
    }
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setStatus('connecting')
    setErrorMsg('')
    setCredentials(url, token)
    connect()

    timeoutRef.current = setTimeout(() => {
      if (!useGatewayStore.getState().connected) {
        setStatus('error')
        setErrorMsg('Connection timed out. Check the URL and token.')
      }
    }, 10000)
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-6 w-full max-w-md shadow-2xl">
        <h2 className="text-lg font-semibold text-white mb-1">Connect to Gateway</h2>
        <p className="text-sm text-[#6b7280] mb-5">Enter your OpenClaw gateway URL and token.</p>

        <label className="block text-xs text-[#6b7280] uppercase tracking-wider mb-1">
          Gateway URL
        </label>
        <input
          className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white mb-4 outline-none focus:border-[#6366f1]"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="wss://your-openclaw-host/ws"
          disabled={status === 'connecting'}
        />

        <label className="block text-xs text-[#6b7280] uppercase tracking-wider mb-1">Token</label>
        <input
          className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white mb-4 outline-none focus:border-[#6366f1]"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Your gateway token"
          disabled={status === 'connecting'}
          onKeyDown={(e) => e.key === 'Enter' && status !== 'connecting' && handleConnect()}
        />

        {status === 'error' && (
          <div className="text-red-400 text-sm mb-4 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
            ❌ {errorMsg}
          </div>
        )}

        {status === 'connecting' && (
          <div className="text-[#6366f1] text-sm mb-4 bg-[#6366f1]/10 border border-[#6366f1]/20 rounded-lg px-3 py-2 flex items-center gap-2">
            <span className="animate-spin inline-block">⟳</span> Connecting…
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleConnect}
            disabled={status === 'connecting'}
            className="flex-1 bg-[#6366f1] hover:bg-[#818cf8] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg py-2 text-sm font-medium transition-colors"
          >
            {status === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
          <button
            onClick={onClose}
            className="px-4 bg-[#2a3142] hover:bg-[#3a4152] text-[#6b7280] rounded-lg py-2 text-sm transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
