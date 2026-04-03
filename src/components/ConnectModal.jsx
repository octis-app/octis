import { useState } from 'react'
import { useGatewayStore } from '../store/gatewayStore'

export default function ConnectModal({ onClose }) {
  const { gatewayUrl, gatewayToken, setCredentials, connect } = useGatewayStore()
  const [url, setUrl] = useState(gatewayUrl || 'ws://127.0.0.1:18789')
  const [token, setToken] = useState(gatewayToken || '')

  const handleConnect = () => {
    setCredentials(url, token)
    connect()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-6 w-full max-w-md shadow-2xl">
        <h2 className="text-lg font-semibold text-white mb-1">Connect to Gateway</h2>
        <p className="text-sm text-[#6b7280] mb-5">Enter your OpenClaw gateway URL and token.</p>

        <label className="block text-xs text-[#6b7280] uppercase tracking-wider mb-1">Gateway URL</label>
        <input
          className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white mb-4 outline-none focus:border-[#6366f1]"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="ws://127.0.0.1:18789"
        />

        <label className="block text-xs text-[#6b7280] uppercase tracking-wider mb-1">Token</label>
        <input
          className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2 text-sm text-white mb-6 outline-none focus:border-[#6366f1]"
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Your gateway token"
        />

        <button
          onClick={handleConnect}
          className="w-full bg-[#6366f1] hover:bg-[#818cf8] text-white rounded-lg py-2 text-sm font-medium transition-colors"
        >
          Connect
        </button>
      </div>
    </div>
  )
}
