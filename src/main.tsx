import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import './index.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'

function UpdateBanner() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegistered(r) { r && setInterval(() => r.update(), 60 * 60 * 1000) },
  })
  if (!needRefresh) return null
  return (
    <div style={{
      position: 'fixed', bottom: '5rem', left: '50%', transform: 'translateX(-50%)',
      background: '#6366f1', color: '#fff', borderRadius: '999px',
      padding: '0.5rem 1.25rem', fontSize: '0.8rem', fontWeight: 600,
      zIndex: 9999, boxShadow: '0 4px 20px rgba(0,0,0,0.4)', cursor: 'pointer',
      whiteSpace: 'nowrap',
    }} onClick={() => updateServiceWorker(true)}>
      🔄 Update available — tap to reload
    </div>
  )
}

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string

if (!PUBLISHABLE_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY')
}

// Clear stale localStorage that could cause crashes
try {
  const stored = localStorage.getItem('octis-gateway')
  if (stored) {
    const parsed = JSON.parse(stored) as { state?: { gatewayUrl?: string } }
    const url = parsed?.state?.gatewayUrl || ''
    if (!url || url.includes('127.0.0.1') || url.includes('localhost')) {
      localStorage.removeItem('octis-gateway')
    }
  }
} catch {
  localStorage.removeItem('octis-gateway')
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('No root element')

createRoot(rootEl).render(
  <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignInUrl="/" afterSignUpUrl="/">
    <ErrorBoundary>
      <App />
      <UpdateBanner />
    </ErrorBoundary>
  </ClerkProvider>
)
