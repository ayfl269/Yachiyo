import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Settings, HardDrive, Terminal, Sun, Moon,
  Users, FileCode, BookOpen, Sparkles, Menu, MessageSquare,
  Database, Puzzle, Brain, Lock
} from 'lucide-react'
import Dashboard from './components/Dashboard'
import ConfigManager from './components/ConfigManager'
import ProviderManager from './components/ProviderManager'
import McpManager from './components/McpManager'
import SubAgentManager from './components/SubAgentManager'
import SkillManager from './components/SkillManager'
import KnowledgeManager from './components/KnowledgeManager'
import PersonaManager from './components/PersonaManager'
import MessagePlatformManager from './components/MessagePlatformManager'
import ChatDataManager from './components/ChatDataManager'
import PluginManager from './components/PluginManager'
import MemoryManager from './components/MemoryManager'

type TabType =
  | 'dashboard' | 'configs' | 'providers' | 'mcp' | 'subagents'
  | 'skills' | 'kbs' | 'personas' | 'platforms' | 'chatdata'
  | 'plugins' | 'memory'

const DASHBOARD_TOKEN_KEY = 'dashboardAuthToken'
type AuthStatus = 'checking' | 'unauthenticated' | 'authenticated'

const NAV_ITEMS: Array<{ key: TabType; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
  { key: 'platforms', label: '消息平台', icon: MessageSquare },
  { key: 'providers', label: '模型提供商', icon: HardDrive },
  { key: 'personas', label: '角色设定', icon: Sparkles },
  { key: 'kbs', label: '知识库', icon: BookOpen },
  { key: 'plugins', label: '插件管理', icon: Puzzle },
  { key: 'mcp', label: 'MCP', icon: Terminal },
  { key: 'subagents', label: '子 Agent', icon: Users },
  { key: 'skills', label: 'Skills', icon: FileCode },
  { key: 'memory', label: '记忆', icon: Brain },
  { key: 'chatdata', label: '对话数据', icon: Database },
  { key: 'configs', label: '配置', icon: Settings },
]

function App() {
  const [currentTab, setCurrentTab] = useState<TabType>(
    () => (localStorage.getItem('currentTab') as TabType) || 'dashboard'
  )
  const [isLightMode, setIsLightMode] = useState(() => localStorage.getItem('theme') === 'light')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === 'true'
  )

  // ── Auth gate ───────────────────────────────────────────────────────────
  // Probe the API to determine whether a Bearer token is required. When the
  // server has authToken configured, unauthenticated /api/ calls return 401
  // and we show a login screen. The token entered here is stored in
  // localStorage and injected by the global fetch wrapper in main.tsx.
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking')
  const [tokenInput, setTokenInput] = useState('')
  const [authError, setAuthError] = useState('')

  const probeAuth = async () => {
    try {
      const res = await fetch('/api/status')
      if (res.status === 401) {
        setAuthStatus('unauthenticated')
      } else {
        setAuthStatus('authenticated')
      }
    } catch {
      // Network error — assume unauthenticated so the user can retry.
      setAuthStatus('unauthenticated')
    }
  }

  useEffect(() => {
    probeAuth()
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')
    const token = tokenInput.trim()
    if (!token) return
    // Store the token so the global fetch wrapper picks it up, then verify.
    localStorage.setItem(DASHBOARD_TOKEN_KEY, token)
    try {
      const res = await fetch('/api/status')
      if (res.ok) {
        setAuthStatus('authenticated')
        setTokenInput('')
      } else {
        localStorage.removeItem(DASHBOARD_TOKEN_KEY)
        setAuthError('令牌无效，请重试。')
      }
    } catch {
      localStorage.removeItem(DASHBOARD_TOKEN_KEY)
      setAuthError('无法连接到服务器。')
    }
  }

  useEffect(() => {
    localStorage.setItem('currentTab', currentTab)
  }, [currentTab])

  useEffect(() => {
    if (isLightMode) {
      document.body.classList.add('light-theme')
      localStorage.setItem('theme', 'light')
    } else {
      document.body.classList.remove('light-theme')
      localStorage.setItem('theme', 'dark')
    }
  }, [isLightMode])

  // Auth gate: render the login screen while unauthenticated. (Placed after
  // all hooks so the Rules of Hooks are not violated by early returns.)
  if (authStatus === 'checking') {
    return (
      <div className="app-container">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <div style={{ color: 'var(--text-secondary)' }}>正在连接控制台…</div>
        </div>
      </div>
    )
  }

  if (authStatus === 'unauthenticated') {
    return (
      <div className="app-container">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <form onSubmit={handleLogin} style={{ width: 320, padding: 24, background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Lock size={28} style={{ color: 'var(--accent-color)' }} />
              <h2 style={{ margin: 0, fontSize: 18 }}>控制台登录</h2>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>请输入访问令牌以继续</p>
            </div>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="访问令牌"
              autoFocus
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace', marginBottom: 12 }}
            />
            {authError && <div style={{ color: '#e5484d', fontSize: 12, marginBottom: 12 }}>{authError}</div>}
            <button type="submit" style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: 'none', background: 'var(--accent-color)', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>登录</button>
          </form>
        </div>
      </div>
    )
  }

  const toggleSidebar = () => {
    setIsSidebarCollapsed((v) => {
      const next = !v
      localStorage.setItem('sidebarCollapsed', String(next))
      return next
    })
  }

  const toggleTheme = () => setIsLightMode((v) => !v)

  const renderTab = () => {
    switch (currentTab) {
      case 'dashboard': return <Dashboard />
      case 'chatdata': return <ChatDataManager />
      case 'configs': return <ConfigManager />
      case 'providers': return <ProviderManager />
      case 'platforms': return <MessagePlatformManager />
      case 'mcp': return <McpManager />
      case 'subagents': return <SubAgentManager />
      case 'skills': return <SkillManager />
      case 'kbs': return <KnowledgeManager />
      case 'memory': return <MemoryManager />
      case 'personas': return <PersonaManager />
      case 'plugins': return <PluginManager />
      default: return <Dashboard />
    }
  }

  return (
    <div className="app-container">
      <header className="topbar">
        <div className={`topbar-left ${isSidebarCollapsed ? 'collapsed' : ''}`}>
          <button
            className="collapse-btn"
            onClick={toggleSidebar}
            title={isSidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
          >
            <Menu className="topbar-icon" />
          </button>
        </div>
        <div className="topbar-right">
          <button
            className="topbar-theme-toggle"
            onClick={toggleTheme}
            title={isLightMode ? '切换为暗色模式' : '切换为亮色模式'}
          >
            {isLightMode ? <Sun className="topbar-icon" /> : <Moon className="topbar-icon" />}
          </button>
        </div>
      </header>

      <div className="layout-wrapper">
        <aside className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
          <nav className="nav-links">
            {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                className={`nav-link ${currentTab === key ? 'active' : ''}`}
                onClick={() => setCurrentTab(key)}
                title={isSidebarCollapsed ? label : ''}
              >
                <Icon className="nav-icon" />
                <span className="nav-text">{label}</span>
              </button>
            ))}
          </nav>
        </aside>

        {!isSidebarCollapsed && (
          <div className="sidebar-overlay" onClick={toggleSidebar} />
        )}

        <main className="main-content">
          <div className="content-container">
            {renderTab()}
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
