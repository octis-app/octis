import { useState, useEffect } from 'react'
import { useAuth, SignedIn, SignedOut, UserButton } from '@clerk/clerk-react'
import { useGatewayStore, useSessionStore, useLabelStore, useProjectStore, useHiddenStore, Session } from './store/gatewayStore'
import Sidebar from './components/Sidebar'
import ChatPane from './components/ChatPane'
import ConnectModal from './components/ConnectModal'
import CostsPanel from './components/CostsPanel'
import MemoryPanel from './components/MemoryPanel'
import SettingsPanel from './components/SettingsPanel'
import MobileApp from './components/MobileApp'
import AuthGate from './components/AuthGate'
import SetupScreen from './components/SetupScreen'
import ProjectsGrid, { type Project } from './components/ProjectsGrid'
import ProjectView from './components/ProjectView'

// Detect mobile: screen width <768px or touch device
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const handler = () => setMobile(window.innerWidth < 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return mobile
}

const NAV_ALL = [
  { id: 'projects', label: '🐙 Projects' },
  { id: 'sessions', label: '💬 Sessions' },
  { id: 'costs', label: '💰 Costs', ownerOnly: true },
  { id: 'memory', label: '🧠 Memory', ownerOnly: true },
]

const API = (import.meta.env.VITE_API_URL as string) || ''

export default function App() {
  const { isSignedIn, isLoaded, getToken } = useAuth()

  if (!isLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f1117]">
        <span className="text-[#6b7280] text-sm">Loading…</span>
      </div>
    )
  }
  if (!isSignedIn) return <AuthGate />

  return <AuthenticatedApp getToken={getToken} />
}

function AuthenticatedApp({ getToken }: { getToken: () => Promise<string | null> }) {
  const { connected, gatewayUrl, connect, setCredentials } = useGatewayStore()
  const { activePanes, paneCount, setPaneCount, pinToPane, sessions } = useSessionStore()
  const { labels, setLabel } = useLabelStore()
  const { hydrateFromServer: hydrateProjects } = useProjectStore()
  const { hydrateFromServer: hydrateHidden } = useHiddenStore()
  const [showConnect, setShowConnect] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [activeNav, setActiveNav] = useState('projects')
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [userRole, setUserRole] = useState<string | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const isMobile = useIsMobile()

  const NAV = NAV_ALL.filter(n => !n.ownerOnly || userRole === 'owner')

  // Fetch fresh gateway config from server on every sign-in
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const token = await getToken()
        const res = await fetch(`${API}/api/gateway-config`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`)
        const data = (await res.json()) as { url?: string; token?: string; agentId?: string; role?: string; needsSetup?: boolean }
        setUserRole(data.role || null)
        if (data.needsSetup) {
          setNeedsSetup(true)
          return
        }
        setCredentials(data.url!, data.token!, data.agentId)
        connect()
        const t = token || undefined
        void hydrateProjects(t)
        void hydrateHidden(t)
      } catch (e) {
        console.error('[octis] Failed to fetch gateway config:', e)
        setShowConnect(true)
      }
    }
    void fetchConfig()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Seed session labels from DB on mount
  useEffect(() => {
    void fetch(`${API}/api/session-labels`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (typeof data === 'object' && !('error' in data)) {
          // Set all keys from response (includes UUIDs, thread IDs, renamed keys)
          Object.entries(data).forEach(([key, label]) => {
            if (!labels[key]) setLabel(key, label)
          })
          sessions.forEach((s: Session) => {
            const gKey = s.key
            if (!gKey) return
            // Try UUID match
            const uuid = s.id || s.sessionId
            if (uuid && data[uuid] && !labels[gKey]) setLabel(gKey, data[uuid])
            // Try thread ID match (last segment of gateway key)
            const threadId = gKey.split(':').pop() || ''
            if (threadId && data[threadId] && !labels[gKey]) setLabel(gKey, data[threadId])
          })
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-seed when sessions load from gateway
  useEffect(() => {
    if (!sessions.length) return
    void fetch(`${API}/api/session-labels`)
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (typeof data === 'object' && !('error' in data)) {
          sessions.forEach((s: Session) => {
            const gKey = s.key
            if (!gKey) return
            const uuid = s.id || s.sessionId
            if (uuid && data[uuid] && !labels[gKey]) setLabel(gKey, data[uuid])
            const threadId = gKey.split(':').pop() || ''
            if (threadId && data[threadId] && !labels[gKey]) setLabel(gKey, data[threadId])
          })
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length])

  if (needsSetup) return (
    <SetupScreen
      getToken={getToken}
      onComplete={(role) => {
        setUserRole(role)
        setNeedsSetup(false)
      }}
    />
  )

  if (isMobile) return <MobileApp />

  const visiblePanes = activePanes.slice(0, paneCount)

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f1117]">
      {/* Left nav */}
      <div className="flex flex-col w-14 bg-[#181c24] border-r border-[#2a3142] items-center py-4 gap-2 shrink-0">
        <button
          onClick={() => setShowSettings(true)}
          className="text-2xl mb-2 hover:opacity-70 transition-opacity"
          title="Settings"
        >
          🐙
        </button>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => setActiveNav(n.id)}
            title={n.label}
            className={`w-9 h-9 rounded-lg text-lg transition-colors flex items-center justify-center ${
              activeNav === n.id ? 'bg-[#6366f1]' : 'hover:bg-[#2a3142] text-[#6b7280]'
            }`}
          >
            {n.label.split(' ')[0]}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => setShowConnect(true)}
          title={`Gateway: ${gatewayUrl || 'not configured'}`}
          className={`w-9 h-9 rounded-lg text-sm transition-colors flex items-center justify-center ${
            connected ? 'text-green-400 hover:bg-[#2a3142]' : 'text-red-400 hover:bg-[#2a3142]'
          }`}
        >
          {connected ? '🟢' : '🔴'}
        </button>
        <div className="mt-2 mb-1">
          <UserButton
            appearance={{
              elements: {
                avatarBox: 'w-8 h-8',
                userButtonPopoverCard: 'bg-[#181c24] border border-[#2a3142]',
                userButtonPopoverActionButton: 'text-[#e8eaf0] hover:bg-[#2a3142]',
                userButtonPopoverActionButtonText: 'text-[#e8eaf0]',
                userButtonPopoverFooter: 'hidden',
              },
            }}
          />
        </div>
      </div>

      {/* Main content */}
      {activeNav === 'projects' && !activeProject && (
        <ProjectsGrid onOpenProject={(p) => { setActiveProject(p); setActiveNav('projects') }} />
      )}

      {activeNav === 'projects' && activeProject && (
        <ProjectView
          project={activeProject}
          onBack={() => setActiveProject(null)}
          paneCount={paneCount}
        />
      )}

      {activeNav === 'sessions' && (
        <>
          <SidebarWrapper onSettingsClick={() => setShowConnect(true)} paneCount={paneCount} setPaneCount={setPaneCount} />
          <div className="flex flex-1 overflow-hidden">
            {visiblePanes.map((sessionKey, i) => (
              <ChatPane
                key={i}
                sessionKey={sessionKey}
                paneIndex={i}
                onClose={() => pinToPane(i, null)}
              />
            ))}
          </div>
        </>
      )}

      {activeNav === 'costs' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-6 py-4 border-b border-[#2a3142] bg-[#181c24] shrink-0">
            <h1 className="text-white font-semibold">💰 Costs</h1>
          </div>
          <CostsPanel />
        </div>
      )}

      {activeNav === 'memory' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-6 py-4 border-b border-[#2a3142] bg-[#181c24] shrink-0">
            <h1 className="text-white font-semibold">🧠 Memory</h1>
          </div>
          <MemoryPanel />
        </div>
      )}

      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function SidebarWrapper({ onSettingsClick, paneCount, setPaneCount }: { onSettingsClick: () => void; paneCount: number; setPaneCount: (n: number) => void }) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="flex shrink-0 overflow-hidden">
      {collapsed ? (
        <div className="w-10 bg-[#181c24] border-r border-[#2a3142] flex flex-col items-center py-3 gap-3">
          <button
            onClick={() => setCollapsed(false)}
            title="Expand sidebar"
            className="w-7 h-7 rounded-lg text-[#6b7280] hover:text-white hover:bg-[#2a3142] flex items-center justify-center text-sm transition-colors"
          >
            ›
          </button>
        </div>
      ) : (
        <div className="relative flex flex-col h-screen">
          <div className="flex-1 min-h-0 overflow-hidden">
            <Sidebar onSettingsClick={onSettingsClick} />
          </div>
          {/* Pane count control */}
          <div className="flex items-center justify-center gap-0.5 px-2 py-1.5 border-t border-[#2a3142] bg-[#181c24]">
            <span className="text-[10px] text-[#4b5563] mr-1">panes</span>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <button
                key={n}
                onClick={() => setPaneCount(n)}
                title={`${n} pane${n > 1 ? 's' : ''}`}
                className={`w-5 h-5 text-[10px] rounded transition-colors ${
                  paneCount === n
                    ? 'bg-[#6366f1] text-white'
                    : 'text-[#6b7280] hover:text-white hover:bg-[#2a3142]'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            className="absolute -right-3 top-1/2 -translate-y-1/2 z-10 w-6 h-6 rounded-full bg-[#2a3142] border border-[#3a4152] text-[#6b7280] hover:text-white flex items-center justify-center text-xs transition-colors shadow-lg"
          >
            ‹
          </button>
        </div>
      )}
    </div>
  )
}

// Keep TS happy — SignedIn/SignedOut are imported but may be used in future
void SignedIn
void SignedOut
