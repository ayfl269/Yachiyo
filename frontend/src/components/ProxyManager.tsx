import { useState, useRef } from 'react'
import { Globe, Save, Power, Zap, AlertCircle, CheckCircle } from 'lucide-react'
import { useToast, ToastPortal, useAsyncEffect } from './shared'
import { apiFetch } from '../lib/api'

interface ProxyStatus {
  enabled: boolean
  url: string | null
  source: 'env' | 'runtime' | 'default'
}

interface ProxyTestResult {
  ok: boolean
  testUrl: string
  statusCode: number | null
  elapsedMs: number | null
  error: string | null
}

export default function ProxyManager() {
  const [status, setStatus] = useState<ProxyStatus | null>(null)
  const [urlInput, setUrlInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null)
  const [testUrl, setTestUrl] = useState('')
  const { toast, showMessage } = useToast()
  const fetchInProgress = useRef(false)

  const fetchStatus = async () => {
    if (fetchInProgress.current) return
    fetchInProgress.current = true
    try {
      const res = await apiFetch('/api/proxy')
      if (res.ok) {
        const data: ProxyStatus = await res.json()
        setStatus(data)
        setUrlInput(data.url ?? '')
      }
    } catch (error) {
      console.error('Failed to fetch proxy status:', error)
      showMessage('获取代理状态失败', 'error')
    } finally {
      setLoading(false)
      fetchInProgress.current = false
    }
  }

  useAsyncEffect(async (signal) => {
    await fetchStatus()
    if (signal.aborted) return
  }, [])

  const handleEnable = async () => {
    const url = urlInput.trim()
    if (!url) {
      showMessage('请输入代理 URL', 'error')
      return
    }
    setSaving(true)
    try {
      const res = await apiFetch('/api/proxy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (res.ok) {
        const data = await res.json()
        setStatus({ enabled: data.enabled, url: data.url, source: data.source })
        showMessage('代理已启用')
        setTestResult(null)
      } else {
        const err = await res.json().catch(() => ({}))
        showMessage(`启用失败: ${err.error || res.statusText}`, 'error')
      }
    } catch (error) {
      console.error('Failed to enable proxy:', error)
      showMessage('启用代理失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDisable = async () => {
    setSaving(true)
    try {
      const res = await apiFetch('/api/proxy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: null }),
      })
      if (res.ok) {
        const data = await res.json()
        setStatus({ enabled: data.enabled, url: data.url, source: data.source })
        setUrlInput('')
        showMessage('代理已禁用')
        setTestResult(null)
      } else {
        showMessage('禁用失败', 'error')
      }
    } catch (error) {
      console.error('Failed to disable proxy:', error)
      showMessage('禁用代理失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const body: Record<string, unknown> = {}
      if (testUrl.trim()) body.test_url = testUrl.trim()
      body.timeout = 10

      const res = await apiFetch('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data: ProxyTestResult = await res.json()
        setTestResult(data)
        if (data.ok) {
          showMessage(`测试成功 (${data.elapsedMs}ms)`)
        } else {
          showMessage(`测试失败: ${data.error}`, 'error')
        }
      } else {
        showMessage('测试请求失败', 'error')
      }
    } catch (error) {
      console.error('Failed to test proxy:', error)
      showMessage('测试代理失败', 'error')
    } finally {
      setTesting(false)
    }
  }

  const sourceLabel = (source: string) => {
    switch (source) {
      case 'env': return '环境变量'
      case 'runtime': return '运行时设置'
      default: return '默认（直连）'
    }
  }

  if (loading) {
    return (
      <div className="config-view animate-fade-in">
        <div className="header">
          <div className="header-main">
            <div>
              <h1>代理配置</h1>
              <p>管理 Agent 系统的网络代理设置</p>
            </div>
          </div>
        </div>
        <div className="loading-state">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="config-view animate-fade-in">
      <div className="header">
        <div className="header-main">
          <div>
            <h1>代理配置</h1>
            <p>管理 Agent 系统的网络代理设置，影响所有 fetch 请求和浏览器工具</p>
          </div>
        </div>
      </div>

      <div className="config-form">
        {/* Status Card */}
        <div className="section-content" style={{ marginBottom: '1.5rem' }}>
          <div className="form-grid">
            <div className="form-group span-2">
              <label>当前状态</label>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '1rem 1.25rem',
                borderRadius: '8px',
                background: status?.enabled
                  ? 'rgba(34, 197, 94, 0.1)'
                  : 'var(--bg-secondary)',
                border: `1px solid ${status?.enabled ? 'rgba(34, 197, 94, 0.3)' : 'var(--border-color)'}`,
              }}>
                {status?.enabled ? (
                  <CheckCircle size={24} style={{ color: '#22c55e' }} />
                ) : (
                  <Power size={24} style={{ color: 'var(--text-secondary)' }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                    {status?.enabled ? '代理已启用' : '代理未启用（直连模式）'}
                  </div>
                  {status?.url && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                      URL: <span className="font-mono">{status.url}</span>
                    </div>
                  )}
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                    来源: {sourceLabel(status?.source ?? 'default')}
                  </div>
                </div>
                <button className="btn" onClick={fetchStatus} disabled={saving} style={{ whiteSpace: 'nowrap' }}>
                  刷新
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Configuration Card */}
        <div className="section-content" style={{ marginBottom: '1.5rem' }}>
          <div className="form-grid">
            <div className="form-group span-2">
              <label>代理 URL</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                  className="form-control font-mono"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !saving) handleEnable() }}
                />
                <button
                  className="btn primary"
                  onClick={handleEnable}
                  disabled={saving || !urlInput.trim()}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  <Save className={`icon-inline${saving ? ' spinning' : ''}`} />
                  {saving ? '处理中...' : '启用'}
                </button>
                {status?.enabled && (
                  <button
                    className="btn"
                    onClick={handleDisable}
                    disabled={saving}
                    style={{ whiteSpace: 'nowrap', color: 'var(--text-danger, #ef4444)' }}
                  >
                    <Power size={14} />
                    禁用
                  </button>
                )}
              </div>
              <span className="help-text">
                支持的协议: http://, https://, socks5://, socks4://。无协议前缀时默认使用 http://。
                SOCKS 代理仅对 Playwright 浏览器工具生效，fetch 请求需使用 http/https 代理。
              </span>
            </div>

            <div className="form-group span-2">
              <label>影响范围</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.75rem 1rem', background: 'var(--bg-secondary)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                  <Globe size={14} style={{ color: 'var(--text-secondary)' }} />
                  <span>web_fetch / http_request / web_search（通过 undici 全局 dispatcher）</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                  <Globe size={14} style={{ color: 'var(--text-secondary)' }} />
                  <span>browser_navigate 等浏览器工具（通过 Playwright proxy 选项）</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}>
                  <Globe size={14} style={{ color: 'var(--text-secondary)' }} />
                  <span>Agent 调用 proxy_manage 工具也可在运行时修改代理</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Connectivity Test Card */}
        <div className="section-content">
          <div className="form-grid">
            <div className="form-group span-2">
              <label>连通性测试</label>
              <span className="help-text" style={{ marginBottom: '0.5rem' }}>
                通过当前代理（或直连）访问指定 URL 验证连通性
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={testUrl}
                  onChange={(e) => setTestUrl(e.target.value)}
                  placeholder="https://httpbin.org/get（留空使用默认）"
                  className="form-control font-mono"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !testing) handleTest() }}
                />
                <button
                  className="btn"
                  onClick={handleTest}
                  disabled={testing}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  <Zap className={`icon-inline${testing ? ' spinning' : ''}`} />
                  {testing ? '测试中...' : '测试'}
                </button>
              </div>
            </div>

            {testResult && (
              <div className="form-group span-2">
                <div style={{
                  padding: '0.75rem 1rem',
                  borderRadius: '6px',
                  background: testResult.ok
                    ? 'rgba(34, 197, 94, 0.1)'
                    : 'rgba(239, 68, 68, 0.1)',
                  border: `1px solid ${testResult.ok ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                    {testResult.ok ? (
                      <CheckCircle size={16} style={{ color: '#22c55e' }} />
                    ) : (
                      <AlertCircle size={16} style={{ color: '#ef4444' }} />
                    )}
                    <strong>{testResult.ok ? '测试成功' : '测试失败'}</strong>
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <span>测试 URL: <span className="font-mono">{testResult.testUrl}</span></span>
                    {testResult.statusCode && <span>状态码: {testResult.statusCode}</span>}
                    {testResult.elapsedMs !== null && <span>耗时: {testResult.elapsedMs}ms</span>}
                    {testResult.error && <span style={{ color: 'var(--text-danger, #ef4444)' }}>错误: {testResult.error}</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <ToastPortal toast={toast} />
    </div>
  )
}
