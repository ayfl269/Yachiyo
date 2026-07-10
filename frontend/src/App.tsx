import { useEffect, useRef, useState } from 'react'
import {
  LayoutDashboard, Settings, HardDrive, Terminal, Sun, Moon,
  Users, FileCode, BookOpen, Sparkles, Menu, MessageSquare,
  Database, Puzzle, Brain, Lock, LogOut, UserCircle, KeyRound,
  Eye, EyeOff, Clock, Globe
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
import SchedulerManager from './components/SchedulerManager'
import ProxyManager from './components/ProxyManager'
import AccountSettings from './components/AccountSettings'
import { Modal } from './components/shared'
import { ErrorBoundary } from './components/ErrorBoundary'
import { authStore, apiFetch } from './lib/api'

type TabType =
  | 'dashboard' | 'configs' | 'providers' | 'mcp' | 'subagents'
  | 'skills' | 'kbs' | 'personas' | 'platforms' | 'chatdata'
  | 'plugins' | 'memory' | 'scheduler' | 'proxy'

type AuthStatus = 'checking' | 'unauthenticated' | 'authenticated' | 'must_change_credentials'

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
  { key: 'scheduler', label: '定时任务', icon: Clock },
  { key: 'proxy', label: '代理', icon: Globe },
  { key: 'chatdata', label: '对话数据', icon: Database },
  { key: 'configs', label: '配置', icon: Settings },
]

function App() {
  const [currentTab, setCurrentTab] = useState<TabType>(() => {
    const stored = localStorage.getItem('currentTab')
    // Validate against known tab keys — a stale/forged value must not be
    // trusted as a `TabType` (type lie). Fall back to 'dashboard'.
    const validKeys = NAV_ITEMS.map((n) => n.key)
    return (stored && validKeys.includes(stored as TabType)) ? (stored as TabType) : 'dashboard'
  })
  const [isLightMode, setIsLightMode] = useState(() => localStorage.getItem('theme') === 'light')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === 'true'
  )

  // ── Auth gate ───────────────────────────────────────────────────────────
  // Probe the API to determine authentication status. The session token
  // returned after login is stored via authStore (memory + sessionStorage)
  // and injected by apiFetch for /api/ requests.
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking')
  const [usernameInput, setUsernameInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [newUsernameInput, setNewUsernameInput] = useState('')
  const [newPasswordInput, setNewPasswordInput] = useState('')
  const [confirmPasswordInput, setConfirmPasswordInput] = useState('')
  const [authError, setAuthError] = useState('')
  const [showLoginPassword, setShowLoginPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showAccountModal, setShowAccountModal] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  const probeAuth = async () => {
    try {
      const res = await apiFetch('/api/auth/status')
      if (res.ok) {
        const data = await res.json()
        if (data.authenticated) {
          if (data.mustChange) {
            setAuthStatus('must_change_credentials')
          } else {
            setAuthStatus('authenticated')
          }
        } else {
          setAuthStatus('unauthenticated')
        }
      } else {
        setAuthStatus('unauthenticated')
      }
    } catch {
      // Network error — assume unauthenticated so the user can retry.
      setAuthStatus('unauthenticated')
    }
  }

  useEffect(() => {
    probeAuth()
  }, [])

  // Close user dropdown on outside click.
  useEffect(() => {
    if (!showUserMenu) return
    const handleClick = (e: MouseEvent): void => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showUserMenu])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')

    const username = usernameInput.trim()
    const password = passwordInput.trim()
    if (!username || !password) return
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      const data = await res.json()
      if (res.ok) {
        authStore.setToken(data.token)
        if (data.status === 'must_change') {
          setAuthStatus('must_change_credentials')
        } else {
          setAuthStatus('authenticated')
        }
        setUsernameInput('')
        setPasswordInput('')
      } else {
        setAuthError(data.message || '用户名或密码错误。')
      }
    } catch {
      setAuthError('无法连接到服务器。')
    }
  }

  const handleChangeCredentials = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError('')
    const newUsername = newUsernameInput.trim()
    const newPassword = newPasswordInput.trim()
    const confirmPassword = confirmPasswordInput.trim()

    if (!newUsername || !newPassword || !confirmPassword) {
      setAuthError('所有字段均为必填项。')
      return
    }
    if (newUsername.length < 3) {
      setAuthError('用户名长度至少为3位。')
      return
    }
    if (newPassword.length < 8) {
      setAuthError('密码长度至少为8位。')
      return
    }
    if (newPassword !== confirmPassword) {
      setAuthError('两次输入的密码不一致。')
      return
    }

    try {
      const res = await apiFetch('/api/auth/change-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newUsername, newPassword, confirmPassword })
      })
      const data = await res.json()
      if (res.ok) {
        authStore.setToken(data.token)
        setAuthStatus('authenticated')
        setNewUsernameInput('')
        setNewPasswordInput('')
        setConfirmPasswordInput('')
      } else {
        setAuthError(data.message || '修改凭证失败，请重试。')
      }
    } catch {
      setAuthError('无法连接到服务器。')
    }
  }

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // Ignore
    }
    authStore.clearToken()
    setAuthStatus('unauthenticated')
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
          <form onSubmit={handleLogin} style={{ width: 400, padding: 32, background: 'var(--bg-secondary)', borderRadius: 16, border: '1px solid var(--border-color)', boxShadow: '0 8px 30px rgba(0, 0, 0, 0.12)', backdropFilter: 'var(--glass-blur)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <Lock size={32} style={{ color: 'var(--accent-primary)' }} />
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>控制台登录</h2>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
                请输入您的用户名与密码
              </p>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label htmlFor="login-username" style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>用户名</label>
              <input
                id="login-username"
                type="text"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="用户名"
                autoFocus
                autoComplete="username"
                style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="login-password" style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}>密码</label>
              <div className="input-with-toggle">
                <input
                  id="login-password"
                  type={showLoginPassword ? 'text' : 'password'}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="密码"
                  autoComplete="current-password"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', paddingRight: '2.4rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowLoginPassword(!showLoginPassword)}
                  title={showLoginPassword ? '隐藏密码' : '显示密码'}
                  tabIndex={-1}
                >
                  {showLoginPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {authError && <div style={{ color: '#e5484d', fontSize: 12, marginBottom: 14, background: 'rgba(229, 72, 77, 0.1)', padding: '8px 12px', borderRadius: 6, border: '1px solid rgba(229, 72, 77, 0.2)' }}>{authError}</div>}

            <button type="submit" className="auth-submit-btn">
              登录
            </button>
          </form>
        </div>
      </div>
    )
  }

  if (authStatus === 'must_change_credentials') {
    return (
      <div className="app-container">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <form onSubmit={handleChangeCredentials} style={{ width: 500, padding: 42, background: 'var(--bg-secondary)', borderRadius: 16, border: '1px solid var(--border-color)', boxShadow: '0 8px 30px rgba(0, 0, 0, 0.12)', backdropFilter: 'var(--glass-blur)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Lock size={32} style={{ color: 'var(--accent-primary)' }} />
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>初始化安全设置</h2>
              <p style={{ margin: 0, fontSize: 12, color: '#e5484d', textAlign: 'center', background: 'rgba(229, 72, 77, 0.1)', padding: '6px 12px', borderRadius: 6 }}>
                检测到您是首次登录，请强制修改默认用户名与密码。
              </p>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>新用户名</label>
              <input
                type="text"
                value={newUsernameInput}
                onChange={(e) => setNewUsernameInput(e.target.value)}
                placeholder="至少3个字符"
                autoFocus
                style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
              />
            </div>
            
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>新密码</label>
              <div className="input-with-toggle">
                <input
                  type={showNewPassword ? 'text' : 'password'}
                  value={newPasswordInput}
                  onChange={(e) => setNewPasswordInput(e.target.value)}
                  placeholder="至少5个字符"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', paddingRight: '2.4rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  title={showNewPassword ? '隐藏密码' : '显示密码'}
                  tabIndex={-1}
                >
                  {showNewPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>确认新密码</label>
              <div className="input-with-toggle">
                <input
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPasswordInput}
                  onChange={(e) => setConfirmPasswordInput(e.target.value)}
                  placeholder="再次输入以确认"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', paddingRight: '2.4rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  title={showConfirmPassword ? '隐藏密码' : '显示密码'}
                  tabIndex={-1}
                >
                  {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {authError && <div style={{ color: '#e5484d', fontSize: 12, marginBottom: 14, background: 'rgba(229, 72, 77, 0.1)', padding: '8px 12px', borderRadius: 6, border: '1px solid rgba(229, 72, 77, 0.2)' }}>{authError}</div>}

            <button type="submit" className="auth-submit-btn">
              提交并保存凭证
            </button>
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
      case 'dashboard': return <Dashboard isLightMode={isLightMode} />
      case 'chatdata': return <ChatDataManager />
      case 'configs': return <ConfigManager />
      case 'providers': return <ProviderManager />
      case 'platforms': return <MessagePlatformManager />
      case 'mcp': return <McpManager />
      case 'subagents': return <SubAgentManager />
      case 'skills': return <SkillManager />
      case 'kbs': return <KnowledgeManager />
      case 'memory': return <MemoryManager />
      case 'scheduler': return <SchedulerManager />
      case 'proxy': return <ProxyManager />
      case 'personas': return <PersonaManager />
      case 'plugins': return <PluginManager />
      default: return <Dashboard isLightMode={isLightMode} />
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
          <div ref={userMenuRef} style={{ position: 'relative' }}>
            <button
              className="topbar-theme-toggle"
              onClick={() => setShowUserMenu((v) => !v)}
              title="账户菜单"
            >
              <UserCircle className="topbar-icon" />
            </button>
            {showUserMenu && (
              <div style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 6px)',
                minWidth: 160,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-color)',
                borderRadius: 10,
                boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                overflow: 'hidden',
                zIndex: 1000,
              }}>
                <button
                  onClick={() => { setShowUserMenu(false); setShowAccountModal(true) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    padding: '10px 14px', border: 'none', background: 'transparent',
                    color: 'var(--text-primary)', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <KeyRound size={15} style={{ color: 'var(--accent-primary)' }} />
                  修改账户
                </button>
                <div style={{ height: 1, background: 'var(--border-color)' }} />
                <button
                  onClick={() => { setShowUserMenu(false); handleLogout() }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                    padding: '10px 14px', border: 'none', background: 'transparent',
                    color: '#e5484d', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <LogOut size={15} />
                  退出登录
                </button>
              </div>
            )}
          </div>
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
            <ErrorBoundary key={currentTab}>
              {renderTab()}
            </ErrorBoundary>
          </div>
        </main>
      </div>

      <Modal
        open={showAccountModal}
        onClose={() => setShowAccountModal(false)}
        title="账户设置"
        size="sm"
      >
        <AccountSettings onSuccess={() => setShowAccountModal(false)} />
      </Modal>
    </div>
  )
}

export default App
