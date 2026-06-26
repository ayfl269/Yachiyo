import { useEffect, useState } from 'react'
import {
  Puzzle,
  RefreshCw,
  AlertCircle,
  Github,
  User,
  Tag,
  Activity
} from 'lucide-react'

interface Plugin {
  name: string
  author: string
  desc: string
  shortDesc: string
  version: string
  repo: string
  modulePath: string
  activated: boolean
  config: Record<string, any>
  handlerFullNames: string[]
  displayName: string
  logoPath: string
  supportPlatforms: string[]
}

export default function PluginManager() {
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const fetchPlugins = async () => {
    setIsLoading(true)
    setErrorMsg('')
    try {
      const res = await fetch('/api/plugins')
      if (!res.ok) throw new Error('获取插件列表失败')
      const data: Plugin[] = await res.json()
      setPlugins(data)
    } catch (err: any) {
      setErrorMsg(err.message || '加载插件失败')
    } finally {
      setIsLoading(false)
    }
  }

  const togglePlugin = async (plugin: Plugin) => {
    const targetState = !plugin.activated
    try {
      const res = await fetch('/api/plugins/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modulePath: plugin.modulePath,
          activated: targetState
        })
      })
      if (!res.ok) {
        const result = await res.json()
        throw new Error(result.error || '切换插件状态失败')
      }
      setPlugins((prev) =>
        prev.map((p) =>
          p.modulePath === plugin.modulePath ? { ...p, activated: targetState } : p
        )
      )
    } catch (err: any) {
      alert(err.message)
    }
  }

  useEffect(() => {
    fetchPlugins()
  }, [])

  return (
    <div className="panel-container animate-fade-in">
      <div className="panel-header">
        <div className="header-info">
          <h2>插件管理</h2>
          <p className="subtitle">管理扩展功能插件，动态控制运行时生命周期与消息处理事件处理器</p>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-secondary btn-icon"
            onClick={fetchPlugins}
            disabled={isLoading}
          >
            <RefreshCw className={`btn-icon-svg${isLoading ? ' animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="error-banner">
          <AlertCircle className="error-icon" />
          <span>{errorMsg}</span>
        </div>
      )}

      {plugins.length === 0 && !isLoading ? (
        <div className="empty-state">
          <Puzzle className="empty-icon" />
          <h3>没有加载到任何插件</h3>
          <p>在您的系统目录中添加扩展插件（Star）并在初始化时进行注册。</p>
        </div>
      ) : (
        <div className="plugin-grid">
          {plugins.map((plugin) => (
            <div
              key={plugin.modulePath}
              className={`plugin-card${plugin.activated ? ' active' : ''}`}
            >
              <div className="card-top">
                <div className="plugin-brand">
                  <div className="brand-icon-wrapper">
                    {plugin.logoPath ? (
                      <img src={plugin.logoPath} className="plugin-logo" alt="logo" />
                    ) : (
                      <Puzzle className="brand-icon text-indigo" />
                    )}
                  </div>
                  <div className="brand-info">
                    <h3>{plugin.displayName || plugin.name}</h3>
                    <div className="version-row">
                      <span className="version-badge">
                        <Tag className="tag-icon" /> v{plugin.version || '1.0.0'}
                      </span>
                      {plugin.author && (
                        <span className="author-label">
                          <User className="user-icon" /> {plugin.author}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  className={`switch-btn${plugin.activated ? ' active' : ''}`}
                  onClick={() => togglePlugin(plugin)}
                  title={plugin.activated ? '禁用插件' : '启用插件'}
                >
                  <span className="switch-handle"></span>
                </button>
              </div>

              <div className="card-desc">
                {plugin.desc || plugin.shortDesc || '该插件未提供描述信息。'}
              </div>

              <div className="card-details">
                {plugin.supportPlatforms && plugin.supportPlatforms.length > 0 && (
                  <div className="detail-section">
                    <span className="section-label">支持平台:</span>
                    <div className="tags-container">
                      {plugin.supportPlatforms.map((platform) => (
                        <span key={platform} className="tag platform-tag">
                          {platform}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {plugin.handlerFullNames && plugin.handlerFullNames.length > 0 && (
                  <div className="detail-section">
                    <span className="section-label">事件监听器:</span>
                    <div className="tags-container">
                      {plugin.handlerFullNames.map((handler) => (
                        <span key={handler} className="tag handler-tag">
                          <Activity className="handler-icon-svg" />
                          {handler.split('.').pop()}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="detail-row">
                  <span className="detail-label">模块路径:</span>
                  <code className="detail-value" title={plugin.modulePath}>
                    {plugin.modulePath.split('/').pop()}
                  </code>
                </div>
              </div>

              {plugin.repo && (
                <div className="card-footer-actions">
                  <a href={plugin.repo} target="_blank" className="repo-link">
                    <Github className="github-icon" />
                    开源仓库地址
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
