import { useState } from 'react'

interface Props {
  API: string
  onLogin: (user: { id: number; email: string; role: string }) => void
}

export default function LoginPage({ API, onLogin }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const r = await fetch(API + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      })
      const data = await r.json()
      if (!r.ok) { setError(data.error || 'Login failed'); return }
      onLogin(data.user)
    } catch {
      setError('Network error — check your connection')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0f1117] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src={`${import.meta.env.BASE_URL}octis-logo.svg`} alt="Octis" className="w-16 h-16 mx-auto mb-3" />
          <h1 className="text-2xl font-bold text-white">Octis</h1>
          <p className="text-[#6b7280] text-sm mt-1">Your AI command center</p>
        </div>
        <form onSubmit={submit} className="bg-[#181c24] border border-[#2a3142] rounded-2xl p-6 space-y-4">
          <div>
            <label className="block text-xs text-[#9ca3af] mb-1.5">Email</label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#6366f1]"
              placeholder="admin@example.com" required autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-[#9ca3af] mb-1.5">Password</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              className="w-full bg-[#0f1117] border border-[#2a3142] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#6366f1]"
              placeholder="••••••••" required
            />
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button
            type="submit" disabled={loading}
            className="w-full bg-[#6366f1] hover:bg-[#5558e8] disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
