import { useEffect } from 'react'
import { useGatewayStore } from '../store/gatewayStore'

const DEFAULT_URL = 'ws://34.152.7.106:18789'
const DEFAULT_TOKEN = '639c6816ff74eb188727ff5ff62423be0de9b6e1f62862e1f6f6207970c284b5'

export default function ConnectModal({ onClose }) {
  const { setCredentials, connect } = useGatewayStore()

  useEffect(() => {
    setCredentials(DEFAULT_URL, DEFAULT_TOKEN)
    connect()
    const t = setTimeout(onClose, 1000)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-[#181c24] border border-[#2a3142] rounded-2xl p-8 w-full max-w-xs shadow-2xl text-center">
        <div className="text-4xl mb-4">🐙</div>
        <div className="text-white font-semibold mb-1">Connecting…</div>
        <div className="text-xs text-[#6b7280] mb-6">34.152.7.106</div>
        <div className="flex justify-center">
          <div className="w-6 h-6 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    </div>
  )
}
