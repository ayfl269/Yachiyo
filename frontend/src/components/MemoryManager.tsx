import { useEffect, useState } from 'react'
import {
  Plus, X, Trash2, Search, Brain, Clock, Tag, Save,
  CheckCircle, AlertCircle, ChevronDown, ChevronUp, Key,
  FileText, Hash, RefreshCw, Layers, Zap, Settings, BarChart3
} from 'lucide-react'
import { useToast, ToastPortal, Modal } from './shared'

// ===== Types =====
type MemoryType = 'short_term' | 'long_term' | 'persona' | 'user_profile'
type MemoryScope = 'global' | 'persona' | 'user' | 'session'

interface MemoryEntry {
  key: string
  value: string
  tags: string[]
  memoryType: MemoryType
  scope: MemoryScope
  scopeId: string
  priority: number
  accessCount: number
  lastAccessedAt: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

interface MemoryStats {
  total: number
  byType: Record<MemoryType, number>
  byScope: Record<MemoryScope, number>
}

interface ConsolidationConfig {
  interval: string
  enabled: boolean
  agingAccessThreshold: number
  agingMaxAgeDays: number
  promoteOnSessionEnd: boolean
  shortTermMaxAgeMs: number
  maxMemoryLength: number
  maxRetries: number
  bufferMinMessages: number
}

interface EditingMemory {
  key: string
  value: string
  tags: string
  memoryType: MemoryType
  scope: MemoryScope
  scopeId: string
  priority: number
}

interface ConsolidationResult {
  extractionFailed?: boolean
  extracted: number
  merged: number
  expired: number
  aged?: { demoted?: number; archived?: number }
}

// ===== Labels =====
const memoryTypeLabels: Record<MemoryType, string> = {
  short_term: '短期记忆',
  long_term: '长期记忆',
  persona: '角色记忆',
  user_profile: '用户资料',
}

const memoryTypeColors: Record<MemoryType, string> = {
  short_term: '#F59E0B',
  long_term: '#10B981',
  persona: '#8B5CF6',
  user_profile: '#3B82F6',
}

const scopeLabels: Record<MemoryScope, string> = {
  global: '全局',
  persona: '角色',
  user: '用户',
  session: '会话',
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString('zh-CN')
  } catch {
    return dateStr
  }
}

function truncateValue(value: string, maxLen = 120): string {
  if (value.length <= maxLen) return value
  return value.slice(0, maxLen) + '...'
}

export default function MemoryManager() {
  // ===== State =====
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [filterType, setFilterType] = useState<MemoryType | ''>('')
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [consolidating, setConsolidating] = useState(false)
  const [consolidationConfig, setConsolidationConfig] = useState<ConsolidationConfig | null>(null)

  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const [showModal, setShowModal] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editingMemory, setEditingMemory] = useState<EditingMemory | null>(null)
  const [saving, setSaving] = useState(false)

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ key: string } | null>(null)

  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)

  const [showConsolidationResult, setShowConsolidationResult] = useState(false)
  const [consolidationResult, setConsolidationResult] = useState<ConsolidationResult | null>(null)

  const { toast, showMessage } = useToast()

  // ===== API =====
  const fetchMemories = async (opts?: { search?: string; type?: MemoryType | '' }) => {
    const search = opts?.search !== undefined ? opts.search : searchQuery
    const type = opts?.type !== undefined ? opts.type : filterType
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', '200')
      if (search.trim()) params.set('search', search.trim())
      if (type) params.set('memory_type', type)
      const res = await fetch(`/api/memories?${params}`)
      if (res.ok) {
        const data = await res.json()
        setMemories(data.memories || [])
        setTotal(data.total || 0)
      }
    } catch (error) {
      console.error('获取记忆列表失败:', error)
      showMessage('获取记忆列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/memories/stats')
      if (res.ok) {
        setStats(await res.json())
      }
    } catch (error) {
      console.error('获取记忆统计失败:', error)
    }
  }

  const fetchConsolidationConfig = async () => {
    try {
      const res = await fetch('/api/memories/consolidation-config')
      if (res.ok) {
        setConsolidationConfig(await res.json())
      }
    } catch (error) {
      console.error('获取整理配置失败:', error)
    }
  }

  const handleSearch = async () => {
    setSearching(true)
    try {
      await fetchMemories()
    } finally {
      setSearching(false)
    }
  }

  const clearSearch = () => {
    setSearchQuery('')
    fetchMemories({ search: '' })
  }

  const handleFilterType = (type: MemoryType | '') => {
    setFilterType(type)
    fetchMemories({ type })
  }

  // ===== Actions =====
  const handleCreate = () => {
    setIsEditing(false)
    setEditingMemory({
      key: '', value: '', tags: '',
      memoryType: 'long_term', scope: 'global', scopeId: '', priority: 0,
    })
    setShowModal(true)
  }

  const handleEdit = (memory: MemoryEntry) => {
    setIsEditing(true)
    setEditingMemory({
      key: memory.key,
      value: memory.value,
      tags: memory.tags.join(', '),
      memoryType: memory.memoryType,
      scope: memory.scope,
      scopeId: memory.scopeId,
      priority: memory.priority,
    })
    setShowModal(true)
  }

  const updateEditing = (patch: Partial<EditingMemory>) => {
    setEditingMemory(prev => (prev ? { ...prev, ...patch } : prev))
  }

  const handleSave = async () => {
    if (!editingMemory) return
    if (!editingMemory.key.trim()) {
      showMessage('Key 不能为空', 'error')
      return
    }
    setSaving(true)
    try {
      const tags = editingMemory.tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)

      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: editingMemory.key.trim(),
          value: editingMemory.value,
          tags,
          memory_type: editingMemory.memoryType,
          scope: editingMemory.scope,
          scope_id: editingMemory.scopeId,
          priority: editingMemory.priority,
        })
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          setShowModal(false)
          setEditingMemory(null)
          showMessage(isEditing ? '记忆已更新' : '记忆已创建')
          await fetchMemories()
          await fetchStats()
        } else {
          showMessage(data.error || '操作失败', 'error')
        }
      } else {
        showMessage('操作失败', 'error')
      }
    } catch (error) {
      console.error('保存记忆失败:', error)
      showMessage('保存记忆失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = (key: string) => {
    setDeleteTarget({ key })
    setShowDeleteConfirm(true)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const targetKey = deleteTarget.key
    try {
      const res = await fetch(`/api/memories/${encodeURIComponent(targetKey)}`, { method: 'DELETE' })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          showMessage('记忆已删除')
          if (expandedKey === targetKey) setExpandedKey(null)
          await fetchMemories()
          await fetchStats()
        } else {
          showMessage('删除失败', 'error')
        }
      }
    } catch (error) {
      console.error('删除记忆失败:', error)
      showMessage('删除记忆失败', 'error')
    } finally {
      setShowDeleteConfirm(false)
      setDeleteTarget(null)
    }
  }

  const confirmClear = () => {
    setShowClearConfirm(true)
  }

  const handleClear = async () => {
    setClearing(true)
    try {
      const res = await fetch('/api/memories/clear', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          showMessage(`已清空 ${data.deletedCount} 条记忆`)
          setExpandedKey(null)
          await fetchMemories()
          await fetchStats()
        } else {
          showMessage('清空失败', 'error')
        }
      }
    } catch (error) {
      console.error('清空记忆失败:', error)
      showMessage('清空记忆失败', 'error')
    } finally {
      setClearing(false)
      setShowClearConfirm(false)
    }
  }

  const handleConsolidate = async () => {
    setConsolidating(true)
    try {
      const res = await fetch('/api/memories/consolidate', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          setConsolidationResult(data.result)
          setShowConsolidationResult(true)
          showMessage('记忆整理完成')
          await fetchMemories()
          await fetchStats()
        } else {
          showMessage(data.error || '整理失败', 'error')
        }
      }
    } catch (error) {
      console.error('记忆整理失败:', error)
      showMessage('记忆整理失败', 'error')
    } finally {
      setConsolidating(false)
    }
  }

  const toggleExpand = (key: string) => {
    setExpandedKey(prev => (prev === key ? null : key))
  }

  // ===== Lifecycle =====
  useEffect(() => {
    fetchMemories()
    fetchStats()
    fetchConsolidationConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="memory-page animate-fade-in">
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1>记忆管理</h1>
          <p>管理短期、长期、角色与用户资料等多层记忆，支持自动整理与老化淘汰</p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => { fetchMemories(); fetchStats() }} disabled={loading} title="刷新">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button className="btn accent" onClick={handleConsolidate} disabled={consolidating} title="手动整理记忆">
            <Zap size={16} />
            {consolidating ? <span>整理中...</span> : <span>整理记忆</span>}
          </button>
          <button className="btn danger" onClick={confirmClear} disabled={memories.length === 0}>
            <Trash2 size={16} /> 清空全部
          </button>
          <button className="btn primary" onClick={handleCreate}>
            <Plus size={16} /> 新建记忆
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      {stats && (
        <div className="stats-panel">
          <div className="mem-stat-card total">
            <BarChart3 size={18} />
            <div className="stat-info">
              <span className="stat-value">{stats.total}</span>
              <span className="stat-label">总记忆数</span>
            </div>
          </div>
          {Object.entries(memoryTypeLabels).map(([type, label]) => {
            const memType = type as MemoryType
            return (
              <div
                key={memType}
                className={`mem-stat-card type-card${filterType === memType ? ' active' : ''}`}
                onClick={() => handleFilterType(filterType === memType ? '' : memType)}
              >
                <div className="type-dot" style={{ background: memoryTypeColors[memType] }}></div>
                <div className="stat-info">
                  <span className="stat-value">{stats.byType[memType] ?? 0}</span>
                  <span className="stat-label">{label}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Search Bar */}
      <div className="search-bar">
        <div className="search-input-wrapper">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索记忆内容、Key 或标签..."
            className="search-input"
            onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          />
          {searchQuery && (
            <button className="search-clear" onClick={clearSearch}>
              <X size={14} />
            </button>
          )}
        </div>
        <button className="btn primary" onClick={handleSearch} disabled={searching}>
          <Search size={14} />
          {searching ? <span>搜索中...</span> : <span>搜索</span>}
        </button>
        {filterType && (
          <button className="btn" onClick={() => handleFilterType('')}>
            <X size={14} /> 清除筛选
          </button>
        )}
      </div>

      {/* Consolidation Config */}
      {consolidationConfig && (
        <div className="consolidation-info">
          <Settings size={14} />
          <span>自动整理: {consolidationConfig.enabled ? '已启用' : '已禁用'}</span>
          <span className="sep">|</span>
          <span>间隔: {consolidationConfig.interval}</span>
          <span className="sep">|</span>
          <span>老化阈值: {consolidationConfig.agingMaxAgeDays}天 / 访问&lt;{consolidationConfig.agingAccessThreshold}</span>
          <span className="sep">|</span>
          <span>记忆长度限制: {consolidationConfig.maxMemoryLength}字</span>
          <span className="sep">|</span>
          <span>失败重试: {consolidationConfig.maxRetries}次</span>
          <span className="sep">|</span>
          <span>缓冲区阈值: {consolidationConfig.bufferMinMessages}条</span>
        </div>
      )}

      {/* Loading */}
      {loading && memories.length === 0 ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      ) : (
        <div className="memory-list">
          {memories.map(memory => (
            <div key={memory.key} className={`memory-card${expandedKey === memory.key ? ' expanded' : ''}`}>
              <div className="memory-card-header" onClick={() => toggleExpand(memory.key)}>
                <div className="memory-main-info">
                  <div className="memory-key-row">
                    <span
                      className="type-badge"
                      style={{
                        background: memoryTypeColors[memory.memoryType] + '20',
                        color: memoryTypeColors[memory.memoryType],
                        borderColor: memoryTypeColors[memory.memoryType] + '40',
                      }}
                    >
                      {memoryTypeLabels[memory.memoryType]}
                    </span>
                    <Key size={14} className="key-icon" />
                    <span className="memory-key">{memory.key}</span>
                  </div>
                  <div className="memory-value-preview">{truncateValue(memory.value)}</div>
                  <div className="memory-meta-row">
                    {memory.tags.length > 0 && (
                      <span className="memory-tags-preview">
                        <Tag size={12} className="tag-icon" />
                        {memory.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="tag-chip">{tag}</span>
                        ))}
                        {memory.tags.length > 3 && (
                          <span className="tag-more">+{memory.tags.length - 3}</span>
                        )}
                      </span>
                    )}
                    <span className="scope-badge">
                      {scopeLabels[memory.scope]}{memory.scopeId ? `/${memory.scopeId.slice(0, 8)}` : ''}
                    </span>
                    {memory.priority > 0 && (
                      <span className="priority-badge">P{memory.priority}</span>
                    )}
                  </div>
                </div>
                <div className="memory-meta">
                  <span className="meta-time"><Clock size={12} /> {formatDate(memory.updatedAt)}</span>
                  <span className="meta-access">访问 {memory.accessCount} 次</span>
                  {expandedKey === memory.key ? (
                    <ChevronUp size={16} className="expand-icon" />
                  ) : (
                    <ChevronDown size={16} className="expand-icon" />
                  )}
                </div>
              </div>

              {/* Expanded Detail */}
              {expandedKey === memory.key && (
                <div className="memory-detail">
                  <div className="detail-section">
                    <div className="detail-label"><Key size={14} /> Key</div>
                    <div className="detail-value font-mono">{memory.key}</div>
                  </div>
                  <div className="detail-section">
                    <div className="detail-label"><FileText size={14} /> Value</div>
                    <pre className="detail-value content-block">{memory.value}</pre>
                  </div>
                  <div className="detail-section inline">
                    <div className="detail-row">
                      <span className="detail-label-sm"><Layers size={12} /> 类型</span>
                      <span className="detail-value-sm">{memoryTypeLabels[memory.memoryType]}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label-sm"><Hash size={12} /> 作用域</span>
                      <span className="detail-value-sm">{scopeLabels[memory.scope]}{memory.scopeId ? ` / ${memory.scopeId}` : ''}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label-sm">优先级</span>
                      <span className="detail-value-sm">{memory.priority}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label-sm">访问次数</span>
                      <span className="detail-value-sm">{memory.accessCount}</span>
                    </div>
                  </div>
                  <div className="detail-section">
                    <div className="detail-label"><Tag size={14} /> Tags</div>
                    <div className="detail-value">
                      {memory.tags.length > 0 ? (
                        <div className="tags-list">
                          {memory.tags.map(tag => (
                            <span key={tag} className="tag-chip">{tag}</span>
                          ))}
                        </div>
                      ) : (
                        <span className="no-tags">无标签</span>
                      )}
                    </div>
                  </div>
                  <div className="detail-section inline">
                    <div className="detail-row">
                      <span className="detail-label-sm"><Clock size={12} /> 创建时间</span>
                      <span className="detail-value-sm">{formatDate(memory.createdAt)}</span>
                    </div>
                    <div className="detail-row">
                      <span className="detail-label-sm"><Clock size={12} /> 更新时间</span>
                      <span className="detail-value-sm">{formatDate(memory.updatedAt)}</span>
                    </div>
                    {memory.lastAccessedAt && (
                      <div className="detail-row">
                        <span className="detail-label-sm"><Clock size={12} /> 最后访问</span>
                        <span className="detail-value-sm">{formatDate(memory.lastAccessedAt)}</span>
                      </div>
                    )}
                    {memory.expiresAt && (
                      <div className="detail-row">
                        <span className="detail-label-sm">过期时间</span>
                        <span className="detail-value-sm">{formatDate(memory.expiresAt)}</span>
                      </div>
                    )}
                  </div>
                  <div className="detail-actions">
                    <button className="btn sm" onClick={() => handleEdit(memory)}>编辑</button>
                    <button className="btn danger sm" onClick={() => confirmDelete(memory.key)}>
                      <Trash2 size={14} /> 删除
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Empty State */}
          {memories.length === 0 && !loading && (
            <div className="empty-state">
              <Brain size={48} className="empty-icon" />
              <h3>{searchQuery || filterType ? '未找到匹配的记忆' : '暂无记忆'}</h3>
              <p>{searchQuery || filterType ? '尝试调整搜索关键词或筛选条件' : 'Agent 在对话中会自动保存记忆，你也可以手动创建。'}</p>
              {!searchQuery && !filterType ? (
                <button className="btn primary" onClick={handleCreate}>
                  <Plus size={16} /> 创建第一条记忆
                </button>
              ) : (
                <button className="btn" onClick={() => { setSearchQuery(''); setFilterType(''); fetchMemories({ search: '', type: '' }) }}>
                  清除筛选
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ===== Create/Edit Modal ===== */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={isEditing ? '编辑记忆' : '新建记忆'}
        footer={
          <>
            <button className="btn" onClick={() => setShowModal(false)}>取消</button>
            <button className="btn primary" disabled={saving || !editingMemory?.key.trim()} onClick={handleSave}>
              {saving ? (
                <span className="btn-loading">
                  <span className="spinner mini white"></span>
                  <span>保存中...</span>
                </span>
              ) : (
                <>
                  <Save size={14} /> {isEditing ? '保存修改' : '创建记忆'}
                </>
              )}
            </button>
          </>
        }
      >
        {editingMemory && (
          <>
            <div className="form-group">
              <label>Key <span className="required">*</span></label>
              <input
                type="text"
                value={editingMemory.key}
                onChange={e => updateEditing({ key: e.target.value })}
                placeholder="记忆的唯一标识，例如: user_preference_theme"
                className="form-control"
                disabled={isEditing}
              />
              <span className="help-text">Key 是记忆的唯一标识，创建后不可修改</span>
            </div>
            <div className="form-group">
              <label>Value</label>
              <textarea
                value={editingMemory.value}
                onChange={e => updateEditing({ value: e.target.value })}
                placeholder="记忆内容..."
                className="form-control content-textarea"
                rows={5}
              />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>记忆类型</label>
                <select
                  value={editingMemory.memoryType}
                  onChange={e => updateEditing({ memoryType: e.target.value as MemoryType })}
                  className="form-control"
                >
                  <option value="short_term">短期记忆</option>
                  <option value="long_term">长期记忆</option>
                  <option value="persona">角色记忆</option>
                  <option value="user_profile">用户资料</option>
                </select>
              </div>
              <div className="form-group">
                <label>作用域</label>
                <select
                  value={editingMemory.scope}
                  onChange={e => updateEditing({ scope: e.target.value as MemoryScope })}
                  className="form-control"
                >
                  <option value="global">全局</option>
                  <option value="persona">角色</option>
                  <option value="user">用户</option>
                  <option value="session">会话</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>作用域 ID</label>
                <input
                  type="text"
                  value={editingMemory.scopeId}
                  onChange={e => updateEditing({ scopeId: e.target.value })}
                  placeholder="可选，如 Persona ID"
                  className="form-control"
                />
              </div>
              <div className="form-group">
                <label>优先级 (0-10)</label>
                <input
                  type="number"
                  value={editingMemory.priority}
                  onChange={e => updateEditing({ priority: Number(e.target.value) })}
                  min={0}
                  max={10}
                  className="form-control"
                />
              </div>
            </div>
            <div className="form-group">
              <label>Tags</label>
              <input
                type="text"
                value={editingMemory.tags}
                onChange={e => updateEditing({ tags: e.target.value })}
                placeholder="标签，用逗号分隔，例如: 偏好, 主题, UI"
                className="form-control"
              />
              <span className="help-text">用逗号分隔多个标签，方便分类和检索</span>
            </div>
          </>
        )}
      </Modal>

      {/* ===== Delete Confirm Modal ===== */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="确认删除"
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setShowDeleteConfirm(false)}>取消</button>
            <button className="btn danger" onClick={handleDelete}>确认删除</button>
          </>
        }
      >
        <div className="confirm-content">
          <AlertCircle size={32} className="confirm-icon danger" />
          <p>确定要删除记忆 <strong>"{deleteTarget?.key}"</strong> 吗？</p>
          <p className="confirm-warn">此操作不可撤销。</p>
        </div>
      </Modal>

      {/* ===== Clear Confirm Modal ===== */}
      <Modal
        open={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="确认清空"
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setShowClearConfirm(false)}>取消</button>
            <button className="btn danger" disabled={clearing} onClick={handleClear}>
              {clearing ? (
                <span className="btn-loading">
                  <span className="spinner mini white"></span>
                  <span>清空中...</span>
                </span>
              ) : '确认清空'}
            </button>
          </>
        }
      >
        <div className="confirm-content">
          <AlertCircle size={32} className="confirm-icon danger" />
          <p>确定要清空所有 <strong>{total} 条</strong> 记忆吗？</p>
          <p className="confirm-warn">此操作将不可逆地删除所有记忆数据！</p>
        </div>
      </Modal>

      {/* ===== Consolidation Result Modal ===== */}
      <Modal
        open={showConsolidationResult}
        onClose={() => setShowConsolidationResult(false)}
        title="记忆整理结果"
        size="sm"
        footer={
          <button className="btn primary" onClick={() => setShowConsolidationResult(false)}>确定</button>
        }
      >
        {consolidationResult && (
          <div className="consolidation-result">
            {consolidationResult.extractionFailed && (
              <div className="result-item">
                <AlertCircle size={16} className="result-icon warning" />
                <span>LLM 提取失败，短期缓冲区已保留等待下次重试</span>
              </div>
            )}
            <div className="result-item">
              <CheckCircle size={16} className="result-icon success" />
              <span>提取新记忆: <strong>{consolidationResult.extracted}</strong> 条</span>
            </div>
            <div className="result-item">
              <CheckCircle size={16} className="result-icon success" />
              <span>合并重复: <strong>{consolidationResult.merged}</strong> 条</span>
            </div>
            <div className="result-item">
              <CheckCircle size={16} className="result-icon success" />
              <span>过期清理: <strong>{consolidationResult.expired}</strong> 条</span>
            </div>
            <div className="result-item">
              <CheckCircle size={16} className="result-icon success" />
              <span>老化降权: <strong>{consolidationResult.aged?.demoted ?? 0}</strong> 条</span>
            </div>
            <div className="result-item">
              <CheckCircle size={16} className="result-icon success" />
              <span>老化归档: <strong>{consolidationResult.aged?.archived ?? 0}</strong> 条</span>
            </div>
          </div>
        )}
      </Modal>

      <ToastPortal toast={toast} />
    </div>
  )
}
