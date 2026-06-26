import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Settings, HardDrive, Terminal, Sun, Moon,
  Users, FileCode, BookOpen, Sparkles, Menu, MessageSquare,
  Database, Puzzle, Brain
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
