import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, X, Users } from 'lucide-react'
import { useToast, ToastPortal } from './shared'
import { apiFetch } from '../lib/api'

interface SubAgent {
  name: string
  instructions: string
  description: string
  tools: string[]
}

interface EditingSubAgent {
  name: string
  instructions: string
  description: string
  tools: string[]
}

export default function SubAgentManager() {
  const [subAgents, setSubAgents] = useState<SubAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [editingSubAgent, setEditingSubAgent] = useState<EditingSubAgent | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [newToolName, setNewToolName] = useState('')
  const { toast, showMessage } = useToast()

  const fetchSubAgents = async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/subagents')
      if (res.ok) {
        setSubAgents(await res.json())
      }
    } catch (error) {
      console.error('Error fetching sub-agents:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    setIsNew(true)
    setEditingSubAgent({
      name: '',
      instructions: '',
      description: '',
      tools: []
    })
    setShowModal(true)
  }

  const handleAddTool = () => {
    const trimmed = newToolName.trim()
    if (trimmed && editingSubAgent) {
      setEditingSubAgent(prev => {
        if (!prev) return prev
        if (!prev.tools.includes(trimmed)) {
          return { ...prev, tools: [...prev.tools, trimmed] }
        }
        return prev
      })
      setNewToolName('')
    }
  }

  const handleRemoveTool = (index: number) => {
    if (!editingSubAgent) return
    setEditingSubAgent(prev => {
      if (!prev) return prev
      const next = [...prev.tools]
      next.splice(index, 1)
      return { ...prev, tools: next }
    })
  }

  const handleDelete = async (name: string) => {
    if (!window.confirm(`确定要注销并删除子 Agent "${name}" 吗？`)) return
    try {
      const res = await apiFetch(`/api/subagents/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (res.ok) {
        await fetchSubAgents()
      } else {
        showMessage('删除失败', 'error')
      }
    } catch (error) {
      console.error('Error deleting sub-agent:', error)
    }
  }

  const handleSave = async () => {
    if (!editingSubAgent) return
    if (!editingSubAgent.name.trim()) {
      showMessage('子 Agent 名称不能为空', 'error')
      return
    }
    if (!editingSubAgent.instructions.trim()) {
      showMessage('指令 instructions 不能为空', 'error')
      return
    }

    try {
      const res = await apiFetch('/api/subagents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editingSubAgent.name.trim(),
          instructions: editingSubAgent.instructions.trim(),
          description: editingSubAgent.description.trim() || undefined,
          tools: editingSubAgent.tools.length > 0 ? editingSubAgent.tools : undefined
        })
      })
      if (res.ok) {
        setEditingSubAgent(null)
        setShowModal(false)
        await fetchSubAgents()
      } else {
        showMessage('保存失败', 'error')
      }
    } catch (error) {
      console.error('Error saving sub-agent:', error)
    }
  }

  const updateEditing = (patch: Partial<EditingSubAgent>) => {
    setEditingSubAgent(prev => (prev ? { ...prev, ...patch } : prev))
  }

  useEffect(() => {
    void fetchSubAgents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="sub-agent-view animate-fade-in">
      <div className="header">
        <div className="header-main">
          <div>
            <h1>子 Agent 管理</h1>
            <p>创建和管理子代理，将其作为可复用的专属助理分配给特定任务</p>
          </div>
          <button className="btn primary" onClick={handleCreate}>
            <Plus size={16} className="icon-inline" /> 添加子 Agent
          </button>
        </div>
      </div>

      {loading && subAgents.length === 0 && (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      )}

      {(!loading || subAgents.length > 0) && (
        <div className="agents-grid">
          {subAgents.map(agent => (
            <div key={agent.name} className="agent-card">
              <div className="card-header">
                <div className="title-info">
                  <div className="name-row">
                    <Users size={16} className="icon-inline accent" />
                    <h3>{agent.name}</h3>
                  </div>
                  <p className="description">{agent.description || '暂无描述'}</p>
                </div>
                <div className="actions">
                  <button
                    className="btn icon-btn danger"
                    title="删除"
                    onClick={() => handleDelete(agent.name)}
                  >
                    <Trash2 size={16} className="icon-inline" />
                  </button>
                </div>
              </div>

              <div className="card-body">
                <div className="details-list">
                  <div className="info-row">
                    <span className="label">系统指令 (System Prompt):</span>
                    <p className="value-block text-truncate-3">{agent.instructions}</p>
                  </div>
                  {agent.tools && agent.tools.length > 0 ? (
                    <div className="info-row">
                      <span className="label">可用工具 (Tools):</span>
                      <div className="tools-tags">
                        {agent.tools.map(tool => (
                          <span key={tool} className="tool-tag">
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="info-row">
                      <span className="label">可用工具 (Tools):</span>
                      <span className="value text-muted">默认工具集</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {subAgents.length === 0 && (
            <div className="no-data-card">
              <Users size={48} className="empty-icon" />
              <h3>没有已注册的子 Agent</h3>
              <p>动态创建的子 Agent 允许主 Agent 在对话时通过生成专门的任务代表来协同工作。</p>
              <button className="btn primary" onClick={handleCreate}>
                创建第一个子 Agent
              </button>
            </div>
          )}
        </div>
      )}

      {showModal &&
        editingSubAgent &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setShowModal(false)}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{isNew ? '创建新子 Agent' : '编辑子 Agent'}</h3>
                <button className="close-btn" onClick={() => setShowModal(false)}>
                  <X size={20} className="close-icon" />
                </button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <label>
                    Agent 名称 <span className="required">*</span>
                  </label>
                  <input
                    type="text"
                    value={editingSubAgent.name}
                    onChange={e => updateEditing({ name: e.target.value })}
                    placeholder="例如: CodeAnalyzer, WebSearcher"
                    disabled={!isNew}
                    className="form-control"
                  />
                  <p className="help-text">
                    用于主 Agent 识别并派发任务的唯一名称，建议仅使用字母和数字。
                  </p>
                </div>

                <div className="form-group">
                  <label>意图描述 (Description)</label>
                  <textarea
                    value={editingSubAgent.description}
                    onChange={e => updateEditing({ description: e.target.value })}
                    placeholder="例如: 负责深度解析代码，并在项目结构中查找问题"
                    rows={2}
                    className="form-control"
                  />
                  <p className="help-text">
                    在分派工具描述中显示，模型将根据此描述评估何时调用该子 Agent。
                  </p>
                </div>

                <div className="form-group">
                  <label>
                    系统提示词 (System Prompt) <span className="required">*</span>
                  </label>
                  <textarea
                    value={editingSubAgent.instructions}
                    onChange={e => updateEditing({ instructions: e.target.value })}
                    placeholder="请详细描述此子 Agent 的角色设定、回答风格和执行逻辑..."
                    rows={6}
                    className="form-control font-mono"
                  />
                  <p className="help-text">子 Agent 在独立运行时接收的专属系统级别提示指令。</p>
                </div>

                <div className="form-group">
                  <label>关联的工具列表 (Tools)</label>
                  <div className="tool-input-row">
                    <input
                      type="text"
                      value={newToolName}
                      onChange={e => setNewToolName(e.target.value)}
                      placeholder="输入工具名称，按回车或点添加"
                      onKeyUp={e => {
                        if (e.key === 'Enter') handleAddTool()
                      }}
                      className="form-control"
                    />
                    <button className="btn secondary" onClick={handleAddTool}>
                      添加
                    </button>
                  </div>
                  {editingSubAgent.tools.length > 0 && (
                    <div className="tools-tags-edit">
                      {editingSubAgent.tools.map((tool, index) => (
                        <span key={tool} className="tool-tag-edit">
                          {tool}
                          <X
                            size={12}
                            className="tag-close-icon"
                            onClick={() => handleRemoveTool(index)}
                          />
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="help-text">
                    指定该子 Agent 可以调用的工具（如 webSearch, read_file 等）。不填则为默认全量工具。
                  </p>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  取消
                </button>
                <button className="btn btn-primary" onClick={handleSave}>
                  保存并注册
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      <ToastPortal toast={toast} />
    </div>
  )
}
