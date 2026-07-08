import { useEffect, useState, useCallback } from 'react'
import {
  Plus, Trash2, Search, Clock, Tag, Save,
  ChevronDown, ChevronUp,
  RefreshCw, Flag, Play
} from 'lucide-react'
import { useToast, ToastPortal, Modal } from './shared'
import { apiFetch } from '../lib/api'

// ===== Types =====
type TaskType = 'reminder' | 'scheduled' | 'recurring' | 'goal' | 'plan'
type TaskStatus = 'pending' | 'active' | 'completed' | 'cancelled' | 'failed'

interface SchedulerTask {
  id: string
  type: TaskType
  title: string
  description: string
  status: TaskStatus
  priority: number
  scheduledAt: string | null
  recurrence: string | null
  goal: string | null
  plan: { description: string; status: string }[]
  currentStep: number
  tags: string[]
  umo: string | null
  sessionId: string | null
  platformId: string | null
  payload: string | null
  lastFiredAt: string | null
  nextFireAt: string | null
  createdAt: string
  updatedAt: string
}

interface SchedulerStats {
  total: number
  byType: Partial<Record<TaskType, number>>
  byStatus: Partial<Record<TaskStatus, number>>
}

interface EditingTask {
  id?: string
  type: TaskType
  title: string
  description: string
  status: TaskStatus
  priority: number
  scheduledAt: string
  recurrence: string
  goal: string
  payload: string
  tags: string
}

// ===== Labels =====
const taskTypeLabels: Record<TaskType, string> = {
  reminder: '提醒',
  scheduled: '定时',
  recurring: '周期',
  goal: '目标',
  plan: '计划',
}

const taskTypeColors: Record<TaskType, string> = {
  reminder: '#F59E0B',
  scheduled: '#3B82F6',
  recurring: '#8B5CF6',
  goal: '#10B981',
  plan: '#EC4899',
}

const taskStatusLabels: Record<TaskStatus, string> = {
  pending: '待处理',
  active: '进行中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
}

const taskStatusColors: Record<TaskStatus, string> = {
  pending: '#F59E0B',
  active: '#3B82F6',
  completed: '#10B981',
  cancelled: '#6B7280',
  failed: '#EF4444',
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr).toLocaleString('zh-CN')
  } catch {
    return dateStr
  }
}

const emptyEditing: EditingTask = {
  type: 'reminder',
  title: '',
  description: '',
  status: 'pending',
  priority: 0,
  scheduledAt: '',
  recurrence: '',
  goal: '',
  payload: '',
  tags: '',
}

export default function SchedulerManager() {
  const [tasks, setTasks] = useState<SchedulerTask[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<TaskType | ''>('')
  const [filterStatus, setFilterStatus] = useState<TaskStatus | ''>('')
  const [stats, setStats] = useState<SchedulerStats | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [showModal, setShowModal] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editing, setEditing] = useState<EditingTask>(emptyEditing)
  const [saving, setSaving] = useState(false)

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)

  const { toast, showMessage } = useToast()

  // ===== API =====
  const fetchTasks = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', '200')
      if (searchQuery.trim()) params.set('search', searchQuery.trim())
      if (filterType) params.set('type', filterType)
      if (filterStatus) params.set('status', filterStatus)
      const res = await apiFetch(`/api/scheduler/tasks?${params}`)
      if (res.ok) {
        const data = await res.json()
        setTasks(data.tasks || [])
      }
    } catch (error) {
      console.error('获取任务列表失败:', error)
      showMessage('获取任务列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, filterType, filterStatus, showMessage])

  const fetchStats = async () => {
    try {
      const res = await apiFetch('/api/scheduler/stats')
      if (res.ok) {
        const data = await res.json()
        setStats(data.stats || null)
      }
    } catch (error) {
      console.error('获取统计失败:', error)
    }
  }

  useEffect(() => { fetchTasks() }, [fetchTasks])
  useEffect(() => { fetchStats() }, [])

  const handleSave = async () => {
    if (!editing.title.trim()) {
      showMessage('请输入任务标题', 'error')
      return
    }
    setSaving(true)
    try {
      const body: any = {
        type: editing.type,
        title: editing.title,
        description: editing.description,
        status: editing.status,
        priority: editing.priority,
        scheduled_at: editing.scheduledAt || null,
        recurrence: editing.recurrence || null,
        goal: editing.goal || null,
        payload: editing.payload || null,
        tags: editing.tags ? editing.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      }

      if (isEditing && editing.id) {
        const res = await apiFetch(`/api/scheduler/tasks/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.ok) {
          showMessage('任务已更新', 'success')
        } else {
          throw new Error('Update failed')
        }
      } else {
        const res = await apiFetch('/api/scheduler/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.ok) {
          showMessage('任务已创建', 'success')
        } else {
          throw new Error('Create failed')
        }
      }
      setShowModal(false)
      fetchTasks()
      fetchStats()
    } catch (error) {
      console.error('保存任务失败:', error)
      showMessage('保存任务失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await apiFetch(`/api/scheduler/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.ok) {
        showMessage('任务已删除', 'success')
        fetchTasks()
        fetchStats()
      } else {
        throw new Error('Delete failed')
      }
    } catch (error) {
      console.error('删除任务失败:', error)
      showMessage('删除任务失败', 'error')
    }
    setShowDeleteConfirm(false)
    setDeleteTarget(null)
  }

  const handleFireNow = async (id: string) => {
    try {
      const res = await apiFetch(`/api/scheduler/tasks/${encodeURIComponent(id)}/fire`, { method: 'POST' })
      if (res.ok) {
        showMessage('任务已立即触发', 'success')
        fetchTasks()
        fetchStats()
      } else {
        throw new Error('Fire failed')
      }
    } catch (error) {
      console.error('触发任务失败:', error)
      showMessage('触发任务失败', 'error')
    }
  }

  const openCreate = () => {
    setEditing(emptyEditing)
    setIsEditing(false)
    setShowModal(true)
  }

  const openEdit = (task: SchedulerTask) => {
    setEditing({
      id: task.id,
      type: task.type,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      scheduledAt: task.scheduledAt || '',
      recurrence: task.recurrence || '',
      goal: task.goal || '',
      payload: task.payload || '',
      tags: task.tags.join(', '),
    })
    setIsEditing(true)
    setShowModal(true)
  }

  // ===== Render =====
  return (
    <div className="manager-container">
      <div className="manager-header">
        <div className="manager-title">
          <h2>定时任务</h2>
        </div>
        <div className="manager-actions">
          <button className="btn btn-primary" onClick={openCreate}>
            <Plus size={16} /> 新建任务
          </button>
          <button className="btn btn-secondary" onClick={() => { fetchTasks(); fetchStats() }}>
            <RefreshCw size={16} /> 刷新
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">总任务</div>
            <div className="stat-value">{stats.total}</div>
          </div>
          {Object.entries(stats.byType || {}).map(([type, count]) => (
            <div className="stat-card" key={type}>
              <div className="stat-label" style={{ color: taskTypeColors[type as TaskType] || '' }}>
                {taskTypeLabels[type as TaskType] || type}
              </div>
              <div className="stat-value">{count as number}</div>
            </div>
          ))}
          {Object.entries(stats.byStatus || {}).filter(([s]) => s === 'pending' || s === 'active').map(([status, count]) => (
            <div className="stat-card" key={status}>
              <div className="stat-label" style={{ color: taskStatusColors[status as TaskStatus] || '' }}>
                {taskStatusLabels[status as TaskStatus] || status}
              </div>
              <div className="stat-value">{count as number}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="filter-bar">
        <div className="search-box">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            className="form-control"
            placeholder="搜索任务标题..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchTasks()}
          />
        </div>
        <select className="form-control" value={filterType} onChange={(e) => setFilterType(e.target.value as TaskType | '')}>
          <option value="">全部类型</option>
          {Object.entries(taskTypeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="form-control" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as TaskStatus | '')}>
          <option value="">全部状态</option>
          {Object.entries(taskStatusLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {/* Task List */}
      <div className="data-list">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">暂无定时任务</div>
        ) : (
          tasks.map((task) => (
            <div key={task.id} className="data-item">
              <div className="data-item-header" onClick={() => setExpandedId(expandedId === task.id ? null : task.id)}>
                <div className="data-item-info">
                  <span
                    className="badge"
                    style={{
                      backgroundColor: `${taskTypeColors[task.type]}18` || 'rgba(107, 114, 128, 0.15)',
                      color: taskTypeColors[task.type] || '#6B7280',
                      border: `1px solid ${taskTypeColors[task.type]}30` || '1px solid rgba(107, 114, 128, 0.25)'
                    }}
                  >
                    {taskTypeLabels[task.type] || task.type}
                  </span>
                  <span
                    className="badge"
                    style={{
                      backgroundColor: `${taskStatusColors[task.status]}18` || 'rgba(107, 114, 128, 0.15)',
                      color: taskStatusColors[task.status] || '#6B7280',
                      border: `1px solid ${taskStatusColors[task.status]}30` || '1px solid rgba(107, 114, 128, 0.25)'
                    }}
                  >
                    {taskStatusLabels[task.status] || task.status}
                  </span>
                  <span className="data-item-title">{task.title}</span>
                  {task.priority > 0 && (
                    <span className="badge badge-priority" title={`优先级 ${task.priority}`}>
                      <Flag size={12} /> {task.priority}
                    </span>
                  )}
                </div>
                <div className="data-item-meta">
                  {task.nextFireAt && (
                    <span className="meta-time" title="下次触发">
                      <Clock size={12} /> {formatDate(task.nextFireAt)}
                    </span>
                  )}
                  {expandedId === task.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </div>

              {expandedId === task.id && (
                <div className="data-item-detail">
                  <div className="detail-row">
                    <span className="detail-label">ID</span>
                    <code className="detail-value">{task.id}</code>
                  </div>
                  {task.description && (
                    <div className="detail-row">
                      <span className="detail-label">描述</span>
                      <span className="detail-value">{task.description}</span>
                    </div>
                  )}
                  {task.payload && (
                    <div className="detail-row">
                      <span className="detail-label">载荷</span>
                      <span className="detail-value">{task.payload}</span>
                    </div>
                  )}
                  {task.goal && (
                    <div className="detail-row">
                      <span className="detail-label">目标</span>
                      <span className="detail-value">{task.goal}</span>
                    </div>
                  )}
                  {task.scheduledAt && (
                    <div className="detail-row">
                      <span className="detail-label">计划时间</span>
                      <span className="detail-value">{formatDate(task.scheduledAt)}</span>
                    </div>
                  )}
                  {task.recurrence && (
                    <div className="detail-row">
                      <span className="detail-label">周期</span>
                      <span className="detail-value">{task.recurrence}</span>
                    </div>
                  )}
                  {task.umo && (
                    <div className="detail-row">
                      <span className="detail-label">UMO</span>
                      <code className="detail-value">{task.umo}</code>
                    </div>
                  )}
                  {task.lastFiredAt && (
                    <div className="detail-row">
                      <span className="detail-label">上次触发</span>
                      <span className="detail-value">{formatDate(task.lastFiredAt)}</span>
                    </div>
                  )}
                  {task.tags.length > 0 && (
                    <div className="detail-row">
                      <span className="detail-label">标签</span>
                      <div className="detail-tags">
                        {task.tags.map((tag, i) => (
                          <span key={i} className="tag-chip"><Tag size={10} /> {tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {task.plan.length > 0 && (
                    <div className="detail-row">
                      <span className="detail-label">计划步骤</span>
                      <div className="plan-steps">
                        {task.plan.map((step, i) => (
                          <div key={i} className={`plan-step ${step.status}`}>
                            <span className="step-index">{i + 1}</span>
                            <span className="step-desc">{step.description}</span>
                            <span className="step-status">{step.status}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="detail-row">
                    <span className="detail-label">创建时间</span>
                    <span className="detail-value">{formatDate(task.createdAt)}</span>
                  </div>

                  <div className="detail-actions">
                    <button className="btn btn-sm btn-secondary" onClick={() => openEdit(task)}>
                      编辑
                    </button>
                    <button className="btn btn-sm btn-warning" onClick={() => handleFireNow(task.id)}>
                      <Play size={12} /> 立即触发
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => {
                      setDeleteTarget({ id: task.id, title: task.title })
                      setShowDeleteConfirm(true)
                    }}>
                      <Trash2 size={12} /> 删除
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Create/Edit Modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={isEditing ? '编辑任务' : '新建任务'}
        size="lg"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowModal(false)}>取消</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Save size={16} /> {saving ? '保存中...' : '保存'}
            </button>
          </>
        }
      >
        <div className="form-grid">
          <div className="form-group">
            <label>类型</label>
            <select className="form-control" value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as TaskType })}>
              {Object.entries(taskTypeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>标题 *</label>
            <input
              type="text"
              className="form-control"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              placeholder="任务标题"
            />
          </div>
          <div className="form-group">
            <label>状态</label>
            <select className="form-control" value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as TaskStatus })}>
              {Object.entries(taskStatusLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>优先级 (0-10)</label>
            <input
              type="number"
              className="form-control"
              min={0}
              max={10}
              value={editing.priority}
              onChange={(e) => setEditing({ ...editing, priority: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="form-group span-2">
            <label>描述</label>
            <textarea
              className="form-control"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              rows={2}
              placeholder="任务描述"
            />
          </div>
          {(editing.type === 'reminder' || editing.type === 'scheduled') && (
            <div className="form-group">
              <label>触发时间</label>
              <input
                type="datetime-local"
                className="form-control"
                value={editing.scheduledAt ? editing.scheduledAt.slice(0, 16) : ''}
                onChange={(e) => setEditing({ ...editing, scheduledAt: e.target.value ? new Date(e.target.value + 'Z').toISOString() : '' })}
              />
            </div>
          )}
          {editing.type === 'recurring' && (
            <div className="form-group">
              <label>周期 (如 1h, 30m, daily, weekly)</label>
              <input
                type="text"
                className="form-control"
                value={editing.recurrence}
                onChange={(e) => setEditing({ ...editing, recurrence: e.target.value })}
                placeholder="1h / 30m / daily / weekly"
              />
            </div>
          )}
          {(editing.type === 'goal' || editing.type === 'plan') && (
            <div className="form-group span-2">
              <label>目标</label>
              <textarea
                className="form-control"
                value={editing.goal}
                onChange={(e) => setEditing({ ...editing, goal: e.target.value })}
                rows={2}
                placeholder="任务目标"
              />
            </div>
          )}
          {(editing.type === 'reminder' || editing.type === 'scheduled' || editing.type === 'recurring') && (
            <div className="form-group span-2">
              <label>触发载荷 / 消息</label>
              <textarea
                className="form-control"
                value={editing.payload}
                onChange={(e) => setEditing({ ...editing, payload: e.target.value })}
                rows={2}
                placeholder="任务触发时发送的消息"
              />
            </div>
          )}
          <div className="form-group span-2">
            <label>标签 (逗号分隔)</label>
            <input
              type="text"
              className="form-control"
              value={editing.tags}
              onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
              placeholder="标签1, 标签2"
            />
          </div>
        </div>
      </Modal>

      {/* Delete Confirm */}
      <Modal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title="确认删除"
        size="sm"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)}>取消</button>
            <button className="btn btn-danger" onClick={() => deleteTarget && handleDelete(deleteTarget.id)}>
              <Trash2 size={16} /> 删除
            </button>
          </>
        }
      >
        <p>确定要删除任务「{deleteTarget?.title}」吗？此操作不可撤销。</p>
      </Modal>

      <ToastPortal toast={toast} />
    </div>
  )
}
