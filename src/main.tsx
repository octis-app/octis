import { createRoot } from 'react-dom/client'
import { useRegisterSW } from 'virtual:pwa-register/react'
import './index.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'

// SW registration — autoUpdate mode.
// controllerchange reload removed: with multiple rapid deploys it caused a reload loop
// (each pending SW update triggered a page reload, which found the next pending update).
// autoUpdate + skipWaiting + clientsClaim handles SW activation without a reload loop.
// Users get fresh code on next natural app open/tab load.
function SWRegistrar() {
  useRegisterSW({
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
