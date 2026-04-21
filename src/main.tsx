import { createRoot } from 'react-dom/client'
import { useRegisterSW } from 'virtual:pwa-register/react'
import './index.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'

// SW registration — autoUpdate mode; check for new version every 5 min
function SWRegistrar() {
  useRegisterSW({
    onRegistered(r) { r && setInterval(() => r.update(), 5 * 60 * 1000) },
    onOfflineReady() { /* silent */ },
  })
  return null
}

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
  <ErrorBoundary>
    <App />
    <SWRegistrar />
  </ErrorBoundary>
)
