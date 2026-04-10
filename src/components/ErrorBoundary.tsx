import { Component, ReactNode, ErrorInfo } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[octis] Uncaught error:', error, info)
  }

  handleReset() {
    localStorage.removeItem('octis-gateway')
    window.location.reload()
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen bg-[#0f1117] items-center justify-center">
          <div className="bg-[#181c24] border border-[#2a3142] rounded-xl p-8 max-w-md w-full text-center shadow-2xl">
            <div className="text-4xl mb-4">🐙</div>
            <h2 className="text-white font-semibold text-lg mb-2">Something went wrong</h2>
            <p className="text-[#6b7280] text-sm mb-6">
              {this.state.error?.message || 'Unexpected error'}
            </p>
            <button
              onClick={this.handleReset}
              className="bg-[#6366f1] hover:bg-[#818cf8] text-white rounded-lg px-5 py-2 text-sm font-medium transition-colors"
            >
              Clear state &amp; reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
