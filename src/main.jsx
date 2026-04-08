import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!PUBLISHABLE_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY')
}

// Clear stale localStorage that could cause crashes
try {
  const stored = localStorage.getItem('octis-gateway')
  if (stored) {
    const parsed = JSON.parse(stored)
    const url = parsed?.state?.gatewayUrl || ''
    if (!url || url.includes('127.0.0.1') || url.includes('localhost')) {
      localStorage.removeItem('octis-gateway')
    }
  }
} catch (e) {
  localStorage.removeItem('octis-gateway')
}

createRoot(document.getElementById('root')).render(
  <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignInUrl="/" afterSignUpUrl="/">
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </ClerkProvider>
)
