import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, X, Trash2, Pencil, RefreshCw,
  Wrench, AlertTriangle, CheckCircle2, XCircle,
  ChevronRight, Loader2, Server
} from 'lucide-react'
import { useToast, ToastPortal } from './shared'

// ===== Types =====
interface McpServer {
  name: string
  config: Record<string, any>
  active: boolean
  tools: string[]
  errlogs: string[]
  createdAt: string
  updatedAt: string
}

interface EditForm {
  serverName: string
  transportType: 'stdio' | 'http'
  command: string
  argsStr: string
  env: Array<{ key: string; value: string; id: string }>
  url: string
  transport: 'sse' | 'streamable_http'
  headers: Array<{ key: string; value: string; id: string }>
  jsonConfig: string
}

let _mcpRowIdCounter = 0
function genRowId(): string {
  return `mcp-row-${++_mcpRowIdCounter}`
}

interface TestResult {
  success: boolean
  tools: string[]
  message: string
}

// ===== Helpers =====
function createEmptyForm(): EditForm {
  return {
    serverName: '',
    transportType: 'stdio',
    command: '',
    argsStr: '',
    env: [],
    url: '',
    transport: 'sse',
    headers: [],
    jsonConfig: ''
  }
}

function getTransportType(config: Record<string, any>): 'stdio' | 'http' {
  return 'url' in config ? 'http' : 'stdio'
}

function configToForm(name: string, config: Record<string, any>): EditForm {
  const transportType = getTransportType(config)
  const envArray: Array<{ key: string; value: string; id: string }> = []
  if (config.env && typeof config.env === 'object') {
    for (const [key, value] of Object.entries(config.env)) {
      envArray.push({ key, value: String(value), id: genRowId() })
    }
  }
  const headersArray: Array<{ key: string; value: string; id: string }> = []
  if (config.headers && typeof config.headers === 'object') {
    for (const [key, value] of Object.entries(config.headers)) {
      headersArray.push({ key, value: String(value), id: genRowId() })
    }
  }
  const argsString = Array.isArray(config.args) ? config.args.join(' ') : ''
  return {
    serverName: name,
    transportType,
    command: (config.command as string) || '',
    argsStr: argsString,
    env: envArray,
    url: (config.url as string) || '',
    transport: (config.transport as 'sse' | 'streamable_http') || 'sse',
    headers: headersArray,
    jsonConfig: JSON.stringify(config, null, 2)
  }
}

function formToConfig(form: EditForm): Record<string, any> {
  // Try JSON config first if non-empty
  const jsonTrim = form.jsonConfig.trim()
  if (jsonTrim) {
    try {
      return JSON.parse(jsonTrim)
    } catch {
      // fall through to form-based construction
    }
  }

  const configObj: Record<string, any> = {}
  if (form.transportType === 'stdio') {
    configObj.command = form.command.trim()
    configObj.args = form.argsStr
      .split(' ')
      .map(x => x.trim())
      .filter(x => x.length > 0)
    if (form.env.length > 0) {
      const envObj: Record<string, string> = {}
      for (const row of form.env) {
        if (row.key.trim()) envObj[row.key.trim()] = row.value
      }
      if (Object.keys(envObj).length > 0) configObj.env = envObj
    }
  } else {
    configObj.url = form.url.trim()
    configObj.transport = form.transport
    if (form.headers.length > 0) {
      const headersObj: Record<string, string> = {}
      for (const row of form.headers) {
        if (row.key.trim()) headersObj[row.key.trim()] = row.value
      }
      if (Object.keys(headersObj).length > 0) configObj.headers = headersObj
    }
  }
  return configObj
}

// ===== Component =====
export default function McpManager() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showToolsDialog, setShowToolsDialog] = useState(false)
  const [deletingServerName, setDeletingServerName] = useState('')
  const [viewingTools, setViewingTools] = useState<string[]>([])
  const [viewingToolsServerName, setViewingToolsServerName] = useState('')

  // Edit form
  const [editForm, setEditForm] = useState<EditForm>(createEmptyForm)
  const [isAdding, setIsAdding] = useState(false)
  const [saving, setSaving] = useState(false)

  // Test connection
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  // Toast
  const { toast, showMessage } = useToast()

  // ===== JSON sync helpers =====
  function syncJsonFromForm() {
    setEditForm(prev => {
      try {
        const config = formToConfig(prev)
        return { ...prev, jsonConfig: JSON.stringify(config, null, 2) }
      } catch {
        return prev
      }
    })
  }

  function syncFormFromJson() {
    setEditForm(prev => {
      try {
        const parsed = JSON.parse(prev.jsonConfig)
        const isHttp = 'url' in parsed
        if (isHttp) {
          const headers: Array<{ key: string; value: string; id: string }> = []
          if (parsed.headers && typeof parsed.headers === 'object') {
            for (const [key, value] of Object.entries(parsed.headers)) {
              headers.push({ key, value: String(value), id: genRowId() })
            }
          }
          return {
            ...prev,
            transportType: 'http' as const,
            url: parsed.url || '',
            transport: parsed.transport || 'sse',
            headers
          }
        } else {
          const env: Array<{ key: string; value: string; id: string }> = []
          if (parsed.env && typeof parsed.env === 'object') {
            for (const [key, value] of Object.entries(parsed.env)) {
              env.push({ key, value: String(value), id: genRowId() })
            }
          }
          return {
            ...prev,
            transportType: 'stdio' as const,
            command: parsed.command || '',
            argsStr: Array.isArray(parsed.args) ? parsed.args.join(' ') : '',
            env
          }
        }
      } catch {
        return prev
      }
    })
  }

  // ===== API =====
  async function fetchServers() {
    try {
      const res = await fetch('/api/tools/mcp/servers')
      if (res.ok) {
        setServers(await res.json())
      }
    } catch (error) {
      console.error('获取 MCP 服务器列表失败:', error)
    } finally {
      setLoading(false)
    }
  }

  async function toggleActive(server: McpServer) {
    const newActive = !server.active
    try {
      const res = await fetch('/api/tools/mcp/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName: server.name, config: server.config, active: newActive })
      })
      if (res.ok) {
        setServers(prev => prev.map(s => s.name === server.name ? { ...s, active: newActive } : s))
        showMessage(newActive ? `已启用 ${server.name}` : `已停用 ${server.name}`)
      } else {
        showMessage('操作失败', 'error')
      }
    } catch (error) {
      showMessage('操作失败', 'error')
    }
  }

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const config = formToConfig(editForm)
      const res = await fetch('/api/tools/mcp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config })
      })
      if (res.ok) {
        const result = await res.json()
        setTestResult(result)
        if (result?.success) {
          showMessage('连接测试成功')
        } else {
          showMessage(result?.message || '连接测试失败', 'error')
        }
      } else {
        showMessage('连接测试请求失败', 'error')
      }
    } catch (error) {
      showMessage('连接测试请求失败', 'error')
    } finally {
      setTesting(false)
    }
  }

  async function saveServer() {
    if (!editForm.serverName.trim()) {
      showMessage('服务器名称不能为空', 'error')
      return
    }

    // Validate JSON if provided
    const jsonTrim = editForm.jsonConfig.trim()
    if (jsonTrim) {
      try {
        JSON.parse(jsonTrim)
      } catch {
        showMessage('JSON 配置格式错误', 'error')
        return
      }
    }

    // Validate required fields
    if (editForm.transportType === 'stdio' && !editForm.command.trim() && !jsonTrim) {
      showMessage('Command 不能为空', 'error')
      return
    }
    if (editForm.transportType === 'http' && !editForm.url.trim() && !jsonTrim) {
      showMessage('URL 不能为空', 'error')
      return
    }

    setSaving(true)
    const config = formToConfig(editForm)
    try {
      const endpoint = isAdding ? '/api/tools/mcp/add' : '/api/tools/mcp/update'
      const body: Record<string, any> = {
        serverName: editForm.serverName.trim(),
        config
      }
      if (!isAdding) {
        body.active = true
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (res.ok) {
        showMessage(isAdding ? '服务器添加成功' : '服务器更新成功')
        closeDialog()
        await fetchServers()
      } else {
        try {
          const text = await res.text()
          showMessage(`保存失败: ${text.slice(0, 200)}`, 'error')
        } catch {
          showMessage('保存失败', 'error')
        }
      }
    } catch (error) {
      showMessage('保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function deleteServer() {
    try {
      const res = await fetch('/api/tools/mcp/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName: deletingServerName })
      })
      if (res.ok) {
        showMessage(`已删除 ${deletingServerName}`)
        setShowDeleteDialog(false)
        await fetchServers()
      } else {
        showMessage('删除失败', 'error')
      }
    } catch (error) {
      showMessage('删除失败', 'error')
    }
  }

  // ===== Dialog Handlers =====
  function openAddDialog() {
    setIsAdding(true)
    setEditForm(createEmptyForm())
    setTestResult(null)
    setShowAddDialog(true)
  }

  function openEditDialog(server: McpServer) {
    setIsAdding(false)
    setEditForm(configToForm(server.name, server.config))
    setTestResult(null)
    setShowEditDialog(true)
  }

  function openDeleteDialog(name: string) {
    setDeletingServerName(name)
    setShowDeleteDialog(true)
  }

  function openToolsDialog(server: McpServer) {
    setViewingToolsServerName(server.name)
    setViewingTools(server.tools || [])
    setShowToolsDialog(true)
  }

  function closeDialog() {
    setShowAddDialog(false)
    setShowEditDialog(false)
    setTestResult(null)
  }

  // ===== List editors =====
  function addEnvRow() {
    setEditForm(prev => ({ ...prev, env: [...prev.env, { key: '', value: '', id: genRowId() }] }))
  }

  function removeEnvRow(index: number) {
    setEditForm(prev => ({ ...prev, env: prev.env.filter((_, i) => i !== index) }))
  }

  function addHeaderRow() {
    setEditForm(prev => ({ ...prev, headers: [...prev.headers, { key: '', value: '', id: genRowId() }] }))
  }

  function removeHeaderRow(index: number) {
    setEditForm(prev => ({ ...prev, headers: prev.headers.filter((_, i) => i !== index) }))
  }

  // ===== Lifecycle =====
  useEffect(() => {
    void fetchServers()
    const timer = window.setInterval(() => { void fetchServers() }, 30000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  const showDialog = showAddDialog || showEditDialog

  return (
    <div className="mcp-page animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1>MCP 服务器管理</h1>
          <p>管理 Model Context Protocol 服务，让 Agent 安全调用外部工具与资源</p>
        </div>
        <button className="btn primary" onClick={openAddDialog}>
          <Plus size={16} /> 添加 MCP 服务
        </button>
      </div>

      {/* Loading */}
      {loading && servers.length === 0 ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      ) : (
        <div className="server-grid">
          {servers.map(server => (
            <div
              key={server.name}
              className={`server-card${!server.active ? ' inactive' : ''}`}
            >
              {/* Card Header */}
              <div className="card-header">
                <div className="title-info">
                  <div className="name-row">
                    <Server size={16} className="server-icon" />
                    <h3>{server.name}</h3>
                    <span className={`transport-badge ${getTransportType(server.config)}`}>
                      {getTransportType(server.config) === 'http' ? 'HTTP' : 'Stdio'}
                    </span>
                  </div>
                </div>
                <div className="actions">
                  <button className="icon-btn" title="编辑" aria-label="编辑" onClick={() => openEditDialog(server)}>
                    <Pencil size={14} />
                  </button>
                  <button className="icon-btn danger" title="删除" aria-label="删除" onClick={() => openDeleteDialog(server.name)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Card Body */}
              <div className="card-body">
                {getTransportType(server.config) === 'stdio' ? (
                  <>
                    <div className="info-row">
                      <span className="label">命令</span>
                      <span className="value font-mono text-truncate">{server.config.command}</span>
                    </div>
                    {server.config.args?.length ? (
                      <div className="info-row">
                        <span className="label">参数</span>
                        <span className="value font-mono text-truncate">{server.config.args.join(' ')}</span>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="info-row">
                      <span className="label">端点</span>
                      <span className="value font-mono text-truncate" title={server.config.url}>{server.config.url}</span>
                    </div>
                    <div className="info-row">
                      <span className="label">协议</span>
                      <span className="value font-mono">{server.config.transport || 'sse'}</span>
                    </div>
                  </>
                )}

                {/* Tools count */}
                <div className="info-row clickable" onClick={() => openToolsDialog(server)}>
                  <span className="label">工具</span>
                  <span className="value tools-count">
                    <Wrench size={13} />
                    {server.tools?.length || 0} 个
                    <ChevronRight size={14} className="chevron" />
                  </span>
                </div>

                {/* Error logs */}
                {server.errlogs?.length ? (
                  <div className="error-logs">
                    <div className="error-header">
                      <AlertTriangle size={13} className="error-icon" />
                      <span>错误日志 ({server.errlogs.length})</span>
                    </div>
                    <div className="error-list">
                      {server.errlogs.map((log, idx) => (
                        <div key={idx} className="error-item font-mono">{log}</div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Card Footer */}
              <div className="card-footer">
                <div
                  className="active-toggle"
                  role="button"
                  tabIndex={0}
                  aria-label={server.active ? '停用服务器' : '启用服务器'}
                  onClick={() => toggleActive(server)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void toggleActive(server)
                    }
                  }}
                >
                  <div className={`toggle-switch${server.active ? ' on' : ''}`}>
                    <div className="toggle-knob"></div>
                  </div>
                  <span className={`toggle-label${server.active ? ' active' : ''}`}>
                    {server.active ? '运行中' : '已停用'}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {/* Empty State */}
          {servers.length === 0 ? (
            <div className="empty-state">
              <Server size={48} className="empty-icon" />
              <p>暂无 MCP 服务器，点击右上角添加</p>
            </div>
          ) : null}
        </div>
      )}

      {/* Add/Edit Dialog */}
      {showDialog && createPortal(
        <div className="modal-backdrop" onClick={closeDialog}>
          <div className="modal-content modal-lg" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{isAdding ? '添加 MCP 服务器' : `编辑: ${editForm.serverName}`}</h3>
              <button className="close-btn" onClick={closeDialog}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <div className="form-grid">
                {/* Server Name */}
                <div className="form-group">
                  <label>服务器名称 *</label>
                  <input
                    type="text"
                    value={editForm.serverName}
                    disabled={!isAdding}
                    onChange={e => setEditForm(prev => ({ ...prev, serverName: e.target.value }))}
                    placeholder="例如: gcal"
                    className="form-control font-mono"
                  />
                  {isAdding ? <span className="help-text">唯一标识，不可更改，作为工具调用前缀</span> : null}
                </div>

                {/* Transport Type */}
                {isAdding ? (
                  <div className="form-group">
                    <label>传输类型</label>
                    <select
                      value={editForm.transportType}
                      onChange={e => {
                        setEditForm(prev => ({ ...prev, transportType: e.target.value as 'stdio' | 'http' }))
                        syncJsonFromForm()
                      }}
                      className="form-control"
                    >
                      <option value="stdio">Stdio (本地子进程)</option>
                      <option value="http">HTTP (远程服务)</option>
                    </select>
                  </div>
                ) : null}

                {/* Stdio Fields */}
                {editForm.transportType === 'stdio' ? (
                  <>
                    <div className="form-group">
                      <label>命令 (Command) *</label>
                      <input
                        type="text"
                        value={editForm.command}
                        onChange={e => {
                          setEditForm(prev => ({ ...prev, command: e.target.value }))
                          syncJsonFromForm()
                        }}
                        placeholder="例如: npx, node, python"
                        className="form-control font-mono"
                      />
                    </div>
                    <div className="form-group">
                      <label>参数 (Args，空格分隔)</label>
                      <input
                        type="text"
                        value={editForm.argsStr}
                        onChange={e => {
                          setEditForm(prev => ({ ...prev, argsStr: e.target.value }))
                          syncJsonFromForm()
                        }}
                        placeholder="例如: -y @modelcontextprotocol/server-gcal"
                        className="form-control font-mono"
                      />
                    </div>

                    {/* Env Variables */}
                    <div className="form-group span-2 list-editor">
                      <div className="list-editor-header">
                        <label>环境变量</label>
                        <button className="btn sm" onClick={addEnvRow}>
                          <Plus size={14} /> 添加
                        </button>
                      </div>
                      <div className="list-rows">
                        {editForm.env.map((row, idx) => (
                          <div key={row.id} className="list-row">
                            <input
                              type="text"
                              value={row.key}
                              onChange={e => {
                                setEditForm(prev => ({
                                  ...prev,
                                  env: prev.env.map((r, i) => i === idx ? { ...r, key: e.target.value } : r)
                                }))
                                syncJsonFromForm()
                              }}
                              placeholder="变量名"
                              className="form-control font-mono half-width"
                            />
                            <input
                              type="text"
                              value={row.value}
                              onChange={e => {
                                setEditForm(prev => ({
                                  ...prev,
                                  env: prev.env.map((r, i) => i === idx ? { ...r, value: e.target.value } : r)
                                }))
                                syncJsonFromForm()
                              }}
                              placeholder="值"
                              className="form-control font-mono half-width"
                            />
                            <button
                              className="icon-btn danger"
                              onClick={() => { removeEnvRow(idx); syncJsonFromForm() }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                        {editForm.env.length === 0 ? (
                          <div className="editor-empty">
                            <p>未配置环境变量</p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {/* HTTP Fields */}
                    <div className="form-group span-2">
                      <label>端点 URL *</label>
                      <input
                        type="text"
                        value={editForm.url}
                        onChange={e => {
                          setEditForm(prev => ({ ...prev, url: e.target.value }))
                          syncJsonFromForm()
                        }}
                        placeholder="例如: http://127.0.0.1:3011/sse"
                        className="form-control font-mono"
                      />
                    </div>
                    <div className="form-group">
                      <label>传输协议</label>
                      <select
                        value={editForm.transport}
                        onChange={e => {
                          setEditForm(prev => ({ ...prev, transport: e.target.value as 'sse' | 'streamable_http' }))
                          syncJsonFromForm()
                        }}
                        className="form-control"
                      >
                        <option value="sse">SSE (Server-Sent Events)</option>
                        <option value="streamable_http">Streamable HTTP</option>
                      </select>
                    </div>

                    {/* Headers */}
                    <div className="form-group span-2 list-editor">
                      <div className="list-editor-header">
                        <label>自定义 Headers</label>
                        <button className="btn sm" onClick={addHeaderRow}>
                          <Plus size={14} /> 添加
                        </button>
                      </div>
                      <div className="list-rows">
                        {editForm.headers.map((row, idx) => (
                          <div key={row.id} className="list-row">
                            <input
                              type="text"
                              value={row.key}
                              onChange={e => {
                                setEditForm(prev => ({
                                  ...prev,
                                  headers: prev.headers.map((r, i) => i === idx ? { ...r, key: e.target.value } : r)
                                }))
                                syncJsonFromForm()
                              }}
                              placeholder="Header 键"
                              className="form-control font-mono half-width"
                            />
                            <input
                              type="text"
                              value={row.value}
                              onChange={e => {
                                setEditForm(prev => ({
                                  ...prev,
                                  headers: prev.headers.map((r, i) => i === idx ? { ...r, value: e.target.value } : r)
                                }))
                                syncJsonFromForm()
                              }}
                              placeholder="值"
                              className="form-control font-mono half-width"
                            />
                            <button
                              className="icon-btn danger"
                              onClick={() => { removeHeaderRow(idx); syncJsonFromForm() }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                        {editForm.headers.length === 0 ? (
                          <div className="editor-empty">
                            <p>未配置自定义 Header</p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </>
                )}

                {/* JSON Config */}
                <div className="form-group span-2">
                  <label>JSON 配置（可直接编辑，优先级高于上方表单）</label>
                  <textarea
                    value={editForm.jsonConfig}
                    onChange={e => {
                      setEditForm(prev => ({ ...prev, jsonConfig: e.target.value }))
                      syncFormFromJson()
                    }}
                    className="form-control font-mono textarea-json"
                    rows={6}
                    placeholder="在此编辑 JSON 配置，或留空使用上方表单生成"
                  ></textarea>
                </div>
              </div>

              {/* Test Connection */}
              <div className="test-section">
                <button className="btn" disabled={testing} onClick={testConnection}>
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  测试连接
                </button>
                {testResult ? (
                  <div className="test-result">
                    {testResult.success ? (
                      <div className="test-success">
                        <CheckCircle2 size={16} />
                        <span>{testResult.message || '连接成功'}</span>
                      </div>
                    ) : (
                      <div className="test-fail">
                        <XCircle size={16} />
                        <span>{testResult.message || '连接失败'}</span>
                      </div>
                    )}
                    {testResult.tools?.length ? (
                      <div className="test-tools">
                        <span className="test-tools-label">可用工具:</span>
                        {testResult.tools.map(tool => (
                          <span key={tool} className="tool-tag">{tool}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={closeDialog}>取消</button>
              <button className="btn primary" disabled={saving} onClick={saveServer}>
                {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete Confirm Dialog */}
      {showDeleteDialog && createPortal(
        <div className="modal-backdrop" onClick={() => setShowDeleteDialog(false)}>
          <div className="modal-content modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>确认删除</h3>
              <button className="close-btn" onClick={() => setShowDeleteDialog(false)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <div className="confirm-text">
                <AlertTriangle size={20} className="confirm-icon" />
                <p>确定要删除 MCP 服务器 <strong>{deletingServerName}</strong> 吗？此操作不可撤销。</p>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowDeleteDialog(false)}>取消</button>
              <button className="btn danger" onClick={deleteServer}>确认删除</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Tools List Dialog */}
      {showToolsDialog && createPortal(
        <div className="modal-backdrop" onClick={() => setShowToolsDialog(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>工具列表 - {viewingToolsServerName}</h3>
              <button className="close-btn" onClick={() => setShowToolsDialog(false)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              {viewingTools.length ? (
                <div className="tools-list">
                  {viewingTools.map(tool => (
                    <div key={tool} className="tool-item">
                      <Wrench size={14} className="tool-icon" />
                      <span className="font-mono">{tool}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="tools-empty">
                  <Wrench size={32} className="empty-icon" />
                  <p>暂无可用工具</p>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowToolsDialog(false)}>关闭</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Toast */}
      <ToastPortal toast={toast} />
    </div>
  )
}
