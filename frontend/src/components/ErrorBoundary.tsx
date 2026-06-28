import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Top-level Error Boundary. Any uncaught render error in a child component
 * (e.g. accessing a field on `null` after a failed fetch) is caught here so
 * the user sees a recoverable error card instead of a white screen.
 *
 * The boundary resets when the route-level `key` changes, allowing users to
 * retry by navigating away and back.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack)
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 16, padding: 24 }}>
        <div style={{ fontSize: 48 }}>⚠️</div>
        <h2 style={{ margin: 0, fontSize: 18, color: 'var(--text-primary)' }}>页面渲染出错</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 420 }}>
          {this.state.error?.message ?? '发生未知错误'}
        </p>
        <button
          onClick={this.handleReset}
          style={{
            padding: '8px 20px', borderRadius: 6, border: '1px solid var(--border-color)',
            background: 'var(--accent-color)', color: '#fff', cursor: 'pointer', fontWeight: 600,
          }}
        >
          重试
        </button>
      </div>
    )
  }
}
