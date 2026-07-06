import { useEffect, useMemo, useState } from 'react'
import {
  Plus, X, Search, Pencil, Trash2, Eye, Sparkles,
  MessageSquare, Smile, Wrench, BookOpen, AlertCircle,
  User, FileText, Zap
} from 'lucide-react'
import { useToast, ToastPortal, Modal } from './shared'
import { apiFetch } from '../lib/api'

// ===== Types =====
interface Persona {
  id: string
  name: string
  prompt: string
  beginDialogs: string[]
  moodImitationDialogs: string[]
  tools: string[] | null
  skills: string[] | null
  customErrorMessage: string | null
}

interface ToolItem {
  name: string
  description?: string
}

interface SkillItem {
  name: string
  description?: string
}

type FormTab = 'basic' | 'dialogs' | 'capabilities'
type CapabilityMode = 'all' | 'selected'

interface DialogPair {
  user: string
  ai: string
  userIndex: number
  aiIndex: number
}

interface DetailDialogPair {
  user: string
  ai: string
}

type RawItem = string | { name: string; description?: string }

// ===== Helpers =====
function slugifyName(name: string): string {
  return name.trim()
    .toLowerCase()
    .replace(/[\s]+/g, '_')
    .replace(/[^\w\u4e00-\u9fff]/g, '')
}

function getBeginDialogPairs(persona: Persona | null): DialogPair[] {
  if (!persona) return []
  const pairs: DialogPair[] = []
  const arr = persona.beginDialogs
  for (let i = 0; i < arr.length; i += 2) {
    pairs.push({
      user: arr[i] || '',
      ai: arr[i + 1] || '',
      userIndex: i,
      aiIndex: i + 1
    })
  }
  return pairs
}

function getDetailDialogPairs(persona: Persona): DetailDialogPair[] {
  const pairs: DetailDialogPair[] = []
  for (let i = 0; i < persona.beginDialogs.length; i += 2) {
    pairs.push({
      user: persona.beginDialogs[i] || '',
      ai: persona.beginDialogs[i + 1] || ''
    })
  }
  return pairs
}

function normalizeItems(data: unknown): ToolItem[] {
  if (!Array.isArray(data)) return []
  return data.map((t: RawItem) =>
    typeof t === 'string' ? { name: t } : { name: t.name, description: t.description }
  )
}

let _personaItemIdCounter = 0
function genItemId(): string {
  return `pm-item-${++_personaItemIdCounter}`
}

export default function PersonaManager() {
  // ===== State =====
  const [personas, setPersonas] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')

  const [availableTools, setAvailableTools] = useState<ToolItem[]>([])
  const [availableSkills, setAvailableSkills] = useState<SkillItem[]>([])
  const [toolsLoaded, setToolsLoaded] = useState(false)
  const [skillsLoaded, setSkillsLoaded] = useState(false)

  const [showModal, setShowModal] = useState(false)
  const [isNew, setIsNew] = useState(false)
  const [activeFormTab, setActiveFormTab] = useState<FormTab>('basic')
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null)

  const [showDetailModal, setShowDetailModal] = useState(false)
  const [detailPersona, setDetailPersona] = useState<Persona | null>(null)

  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  const [toolsMode, setToolsMode] = useState<CapabilityMode>('all')
  const [skillsMode, setSkillsMode] = useState<CapabilityMode>('all')
  const [toolSearch, setToolSearch] = useState('')
  const [skillSearch, setSkillSearch] = useState('')

  const [showCustomId, setShowCustomId] = useState(false)
  const [moodInput, setMoodInput] = useState('')

  const [dialogPairIds, setDialogPairIds] = useState<string[]>([])
  const [moodDialogIds, setMoodDialogIds] = useState<string[]>([])

  const { toast, showMessage } = useToast()

  // ===== Computed =====
  const filteredPersonas = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return personas
    return personas.filter(p =>
      p.id.toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.prompt.toLowerCase().includes(q)
    )
  }, [personas, searchQuery])

  const filteredAvailableTools = useMemo(() => {
    const q = toolSearch.trim().toLowerCase()
    if (!q) return availableTools
    return availableTools.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.description !== undefined && t.description.toLowerCase().includes(q))
    )
  }, [availableTools, toolSearch])

  const filteredAvailableSkills = useMemo(() => {
    const q = skillSearch.trim().toLowerCase()
    if (!q) return availableSkills
    return availableSkills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.description !== undefined && s.description.toLowerCase().includes(q))
    )
  }, [availableSkills, skillSearch])

  const beginDialogPairs = useMemo(() => getBeginDialogPairs(editingPersona), [editingPersona])
  const detailDialogPairs = useMemo(
    () => (detailPersona ? getDetailDialogPairs(detailPersona) : []),
    [detailPersona]
  )

  // ===== API =====
  const fetchPersonas = async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/personas')
      if (res.ok) {
        setPersonas(await res.json())
      }
    } catch (error) {
      console.error('获取设定列表失败:', error)
      showMessage('获取设定列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  const fetchTools = async () => {
    try {
      const res = await apiFetch('/api/tools/list')
      if (res.ok) {
        const data = await res.json()
        setAvailableTools(normalizeItems(data))
      }
    } catch (error) {
      console.error('获取工具列表失败:', error)
    } finally {
      setToolsLoaded(true)
    }
  }

  const fetchSkills = async () => {
    try {
      const res = await apiFetch('/api/skills')
      if (res.ok) {
        const data = await res.json()
        setAvailableSkills(normalizeItems(data))
      }
    } catch (error) {
      console.error('获取技能列表失败:', error)
    } finally {
      setSkillsLoaded(true)
    }
  }

  useEffect(() => {
    fetchPersonas()
  }, [])

  // ===== Actions =====
  const handleCreate = () => {
    setIsNew(true)
    setShowCustomId(false)
    setEditingPersona({
      id: '',
      name: '',
      prompt: '',
      beginDialogs: [],
      moodImitationDialogs: [],
      tools: null,
      skills: null,
      customErrorMessage: null
    })
    setToolsMode('all')
    setSkillsMode('all')
    setActiveFormTab('basic')
    setDialogPairIds([])
    setMoodDialogIds([])
    setShowModal(true)
    fetchTools()
    fetchSkills()
  }

  const handleEdit = (persona: Persona) => {
    setIsNew(false)
    setEditingPersona(structuredClone(persona))
    setDialogPairIds(Array.from({ length: Math.ceil(persona.beginDialogs.length / 2) }, () => genItemId()))
    setMoodDialogIds(persona.moodImitationDialogs.map(() => genItemId()))
    setToolsMode(persona.tools === null ? 'all' : 'selected')
    setSkillsMode(persona.skills === null ? 'all' : 'selected')
    setActiveFormTab('basic')
    setShowModal(true)
    fetchTools()
    fetchSkills()
  }

  const handleViewDetail = (persona: Persona) => {
    setDetailPersona(persona)
    setShowDetailModal(true)
  }

  const confirmDelete = (id: string, name: string) => {
    setDeleteTarget({ id, name })
    setShowDeleteModal(true)
  }

  const executeDelete = async () => {
    if (!deleteTarget) return
    try {
      const res = await apiFetch(`/api/personas/${deleteTarget.id}`, { method: 'DELETE' })
      if (res.ok) {
        showMessage(`角色 "${deleteTarget.name}" 已删除`)
        setShowDeleteModal(false)
        setDeleteTarget(null)
        await fetchPersonas()
      } else {
        showMessage('删除失败', 'error')
      }
    } catch (error) {
      console.error('删除角色失败:', error)
      showMessage('删除失败', 'error')
    }
  }

  const handleSave = async () => {
    if (!editingPersona) return
    const p: Persona = { ...editingPersona }

    if (!p.name.trim()) { showMessage('角色名称不能为空', 'error'); return }
    if (!p.id.trim()) { p.id = slugifyName(p.name) }
    if (!p.id.trim()) { showMessage('角色 ID 不能为空', 'error'); return }
    if (!p.prompt.trim()) { showMessage('系统提示词不能为空', 'error'); return }

    if (toolsMode === 'all') {
      p.tools = null
    } else if (p.tools && p.tools.length === 0) {
      p.tools = null
    }
    if (skillsMode === 'all') {
      p.skills = null
    } else if (p.skills && p.skills.length === 0) {
      p.skills = null
    }

    try {
      const url = isNew ? '/api/personas' : '/api/personas/update'
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p)
      })
      if (res.ok) {
        showMessage(isNew ? '设定创建成功' : '设定更新成功')
        setShowModal(false)
        setEditingPersona(null)
        await fetchPersonas()
      } else {
        const text = await res.text()
        showMessage(`保存失败: ${text || res.statusText}`, 'error')
      }
    } catch (error) {
      console.error('保存设定失败:', error)
      showMessage('保存失败', 'error')
    }
  }

  // ===== Editing helpers (immutable updates) =====
  const updateEditing = (patch: Partial<Persona>) => {
    setEditingPersona(prev => (prev ? { ...prev, ...patch } : prev))
  }

  const onNameChange = (value: string) => {
    if (!editingPersona) return
    if (isNew && !showCustomId) {
      setEditingPersona(prev => (prev ? { ...prev, name: value, id: slugifyName(value) } : prev))
    } else {
      updateEditing({ name: value })
    }
  }

  const addBeginDialogPair = () => {
    setEditingPersona(prev => (prev ? { ...prev, beginDialogs: [...prev.beginDialogs, '', ''] } : prev))
    setDialogPairIds(prev => [...prev, genItemId()])
  }

  const removeBeginDialogPair = (index: number) => {
    const pairOrdinal = Math.floor(index / 2)
    setEditingPersona(prev => {
      if (!prev) return prev
      const pairIndex = pairOrdinal * 2
      const next = prev.beginDialogs.filter((_, i) => i !== pairIndex && i !== pairIndex + 1)
      return { ...prev, beginDialogs: next }
    })
    setDialogPairIds(prev => prev.filter((_, i) => i !== pairOrdinal))
  }

  const updateBeginDialog = (index: number, value: string) => {
    setEditingPersona(prev =>
      prev
        ? { ...prev, beginDialogs: prev.beginDialogs.map((d, i) => (i === index ? value : d)) }
        : prev
    )
  }

  const addMoodDialog = () => {
    const value = moodInput.trim()
    if (!value || !editingPersona) return
    setEditingPersona(prev =>
      prev ? { ...prev, moodImitationDialogs: [...prev.moodImitationDialogs, value] } : prev
    )
    setMoodDialogIds(prev => [...prev, genItemId()])
    setMoodInput('')
  }

  const removeMoodDialog = (index: number) => {
    setEditingPersona(prev =>
      prev
        ? { ...prev, moodImitationDialogs: prev.moodImitationDialogs.filter((_, i) => i !== index) }
        : prev
    )
    setMoodDialogIds(prev => prev.filter((_, i) => i !== index))
  }

  const isToolSelected = (toolName: string): boolean => {
    return !!editingPersona?.tools && editingPersona.tools.includes(toolName)
  }

  const toggleTool = (toolName: string) => {
    setEditingPersona(prev => {
      if (!prev) return prev
      const tools = prev.tools ? [...prev.tools] : []
      const idx = tools.indexOf(toolName)
      if (idx >= 0) {
        tools.splice(idx, 1)
      } else {
        tools.push(toolName)
      }
      return { ...prev, tools }
    })
  }

  const isSkillSelected = (skillName: string): boolean => {
    return !!editingPersona?.skills && editingPersona.skills.includes(skillName)
  }

  const toggleSkill = (skillName: string) => {
    setEditingPersona(prev => {
      if (!prev) return prev
      const skills = prev.skills ? [...prev.skills] : []
      const idx = skills.indexOf(skillName)
      if (idx >= 0) {
        skills.splice(idx, 1)
      } else {
        skills.push(skillName)
      }
      return { ...prev, skills }
    })
  }

  const onToolsModeChange = (mode: CapabilityMode) => {
    setToolsMode(mode)
    setEditingPersona(prev => {
      if (!prev) return prev
      if (mode === 'all') return { ...prev, tools: null }
      if (prev.tools === null) return { ...prev, tools: [] }
      return prev
    })
  }

  const onSkillsModeChange = (mode: CapabilityMode) => {
    setSkillsMode(mode)
    setEditingPersona(prev => {
      if (!prev) return prev
      if (mode === 'all') return { ...prev, skills: null }
      if (prev.skills === null) return { ...prev, skills: [] }
      return prev
    })
  }

  // ===== Render =====
  return (
    <div className="persona-page animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1>角色设定</h1>
          <p>配置助理的人设 Prompt、开场白与工具权限，赋予其独特的语气与专业领域知识</p>
        </div>
        <button className="btn primary" onClick={handleCreate}>
          <Plus size={16} /> 添加设定
        </button>
      </div>

      {/* Search Bar */}
      <div className="search-bar">
        <Search size={16} className="search-icon" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="搜索角色 ID、名称或提示词..."
          className="form-control"
        />
      </div>

      {/* Loading */}
      {loading ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      ) : (
        <>
          {filteredPersonas.length > 0 ? (
            <div className="personas-grid">
              {filteredPersonas.map(persona => (
                <div key={persona.id} className="persona-card">
                  <div className="card-header">
                    <div className="title-info">
                      <div className="name-row">
                        <Sparkles size={16} className="accent-icon" />
                        <h3>{persona.name}</h3>
                        <span className="id-badge font-mono">{persona.id}</span>
                      </div>
                      <p className="prompt-preview">{persona.prompt}</p>
                    </div>
                  </div>

                  <div className="card-body">
                    <div className="tags-area">
                      <div className="tag-group">
                        <MessageSquare size={12} className="tag-group-icon" />
                        <span className="tag-label">{persona.beginDialogs.length} 条预设对话</span>
                      </div>
                      <div className="tag-group">
                        <Smile size={12} className="tag-group-icon" />
                        <span className="tag-label">{persona.moodImitationDialogs.length} 条语气模仿</span>
                      </div>
                      <div className="tag-group">
                        <Wrench size={12} className="tag-group-icon tool-icon" />
                        <span className="tag-label">{persona.tools ? persona.tools.length + ' 工具' : '全部工具'}</span>
                      </div>
                      <div className="tag-group">
                        <BookOpen size={12} className="tag-group-icon skill-icon" />
                        <span className="tag-label">{persona.skills ? persona.skills.length + ' 技能' : '全部技能'}</span>
                      </div>
                    </div>
                  </div>

                  <div className="card-footer">
                    <button className="btn sm" onClick={() => handleViewDetail(persona)} title="查看详情">
                      <Eye size={14} /> 详情
                    </button>
                    <button className="btn sm" onClick={() => handleEdit(persona)} title="编辑">
                      <Pencil size={14} /> 编辑
                    </button>
                    <button className="btn sm danger" onClick={() => confirmDelete(persona.id, persona.name)} title="删除">
                      <Trash2 size={14} /> 删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <User size={48} className="empty-icon" />
              <h3>{searchQuery ? '没有匹配的角色设定' : '暂无角色设定'}</h3>
              <p>{searchQuery ? '尝试调整搜索关键词' : '创建自定义角色设定，赋予系统智能不同的交互灵魂。'}</p>
              {!searchQuery && (
                <button className="btn primary" onClick={handleCreate}>
                  <Plus size={16} /> 创建第一个角色设定
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Create/Edit Modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={isNew ? '创建新设定' : '编辑设定'}
        size="lg"
        footer={
          <>
            <button className="btn" onClick={() => setShowModal(false)}>取消</button>
            <button className="btn primary" onClick={handleSave}>
              {isNew ? '创建' : '保存'}
            </button>
          </>
        }
      >
        {/* Tabs */}
        <div className="form-tabs">
          <button
            className={`form-tab${activeFormTab === 'basic' ? ' active' : ''}`}
            onClick={() => setActiveFormTab('basic')}
          >
            <FileText size={14} /> 基本信息
          </button>
          <button
            className={`form-tab${activeFormTab === 'dialogs' ? ' active' : ''}`}
            onClick={() => setActiveFormTab('dialogs')}
          >
            <MessageSquare size={14} /> 预设对话
          </button>
          <button
            className={`form-tab${activeFormTab === 'capabilities' ? ' active' : ''}`}
            onClick={() => setActiveFormTab('capabilities')}
          >
            <Zap size={14} /> 能力配置
          </button>
        </div>

        {editingPersona && (
          <>
            {/* Basic Tab */}
            {activeFormTab === 'basic' && (
              <div className="tab-panel">
                <div className="form-grid">
                  <div className="form-group">
                    <label>名称 <span className="required">*</span></label>
                    <input
                      type="text"
                      value={editingPersona.name}
                      onChange={e => onNameChange(e.target.value)}
                      placeholder="例如: 智能助理, 资深架构师"
                      className="form-control"
                    />
                  </div>

                  {!isNew ? (
                    <div className="form-group">
                      <label>角色 ID</label>
                      <input
                        type="text"
                        value={editingPersona.id}
                        className="form-control font-mono"
                        disabled
                      />
                      <span className="help-text">唯一标识符，创建后不可修改</span>
                    </div>
                  ) : (
                    <div className="form-group">
                      <label>角色 ID</label>
                      {showCustomId ? (
                        <>
                          <input
                            type="text"
                            value={editingPersona.id}
                            onChange={e => updateEditing({ id: e.target.value })}
                            placeholder="自定义角色 ID"
                            className="form-control font-mono"
                          />
                          <span className="help-text">留空则自动从名称生成</span>
                        </>
                      ) : (
                        <div className="id-inline-row">
                          <span className="help-text">ID: <code className="font-mono">{editingPersona.id || '(将自动生成)'}</code></span>
                          <button className="btn sm link-btn" onClick={() => setShowCustomId(true)}>自定义</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label>系统提示词 <span className="required">*</span></label>
                  <textarea
                    value={editingPersona.prompt}
                    onChange={e => updateEditing({ prompt: e.target.value })}
                    placeholder="你是一个经验丰富的高级软件工程师，在回答用户提问时总是使用简洁的语气..."
                    rows={10}
                    className="form-control"
                  />
                  <span className="help-text">发送给模型的核心 System Prompt</span>
                </div>

                <div className="form-group">
                  <label>自定义错误消息 <span className="optional">(可选)</span></label>
                  <input
                    type="text"
                    value={editingPersona.customErrorMessage ?? ''}
                    onChange={e => updateEditing({ customErrorMessage: e.target.value })}
                    placeholder="例如: 抱歉，我的思考链路在处理此请求时发生了中断，请稍后再试。"
                    className="form-control"
                  />
                  <span className="help-text">当模型服务发生异常时，对用户的友好应答</span>
                </div>
              </div>
            )}

            {/* Dialogs Tab */}
            {activeFormTab === 'dialogs' && (
              <div className="tab-panel">
                <div className="section-block">
                  <div className="section-block-header">
                    <div>
                      <h4>开场预设对话 (Begin Dialogs)</h4>
                      <p className="section-desc">成对的用户/AI 消息，偶数行为用户消息，奇数行为 AI 回复</p>
                    </div>
                    <button className="btn sm" onClick={addBeginDialogPair}>
                      <Plus size={14} /> 添加对话对
                    </button>
                  </div>

                  {beginDialogPairs.length > 0 ? (
                    <div className="dialog-pairs">
                      {beginDialogPairs.map((pair, idx) => (
                        <div key={dialogPairIds[idx] ?? `pair-${idx}`} className="dialog-pair">
                          <div className="dialog-pair-header">
                            <span className="dialog-pair-index">对话对 #{idx + 1}</span>
                            <button className="btn sm danger-text" onClick={() => removeBeginDialogPair(pair.userIndex)}>
                              <Trash2 size={12} /> 删除
                            </button>
                          </div>
                          <div className="dialog-pair-body">
                            <div className="form-group">
                              <label className="dialog-label user-label">
                                <User size={12} /> 用户消息
                              </label>
                              <textarea
                                value={editingPersona.beginDialogs[pair.userIndex] ?? ''}
                                onChange={e => updateBeginDialog(pair.userIndex, e.target.value)}
                                placeholder="用户说的话..."
                                rows={2}
                                className="form-control"
                              />
                            </div>
                            <div className="form-group">
                              <label className="dialog-label ai-label">
                                <Sparkles size={12} /> AI 回复
                              </label>
                              <textarea
                                value={editingPersona.beginDialogs[pair.aiIndex] ?? ''}
                                onChange={e => updateBeginDialog(pair.aiIndex, e.target.value)}
                                placeholder="AI 的回复..."
                                rows={2}
                                className="form-control"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-hint">
                      <MessageSquare size={24} className="empty-hint-icon" />
                      <p>暂无预设对话，点击上方按钮添加</p>
                    </div>
                  )}
                </div>

                <div className="section-block">
                  <div className="section-block-header">
                    <div>
                      <h4>语气模仿对话 (Mood Imitation Dialogs)</h4>
                      <p className="section-desc">供 few-shot 语气参考的对话片段</p>
                    </div>
                  </div>

                  {editingPersona.moodImitationDialogs.length > 0 ? (
                    <div className="dialog-items">
                      {editingPersona.moodImitationDialogs.map((item, idx) => (
                        <div key={moodDialogIds[idx] ?? `mood-${idx}`} className="dialog-item-row">
                          <span className="dialog-item-text">{item}</span>
                          <button className="icon-btn danger" onClick={() => removeMoodDialog(idx)}>
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-hint small">
                      <p>暂无语气模仿对话</p>
                    </div>
                  )}

                  <div className="add-item-row">
                    <input
                      type="text"
                      value={moodInput}
                      onChange={e => setMoodInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addMoodDialog()
                        }
                      }}
                      placeholder="添加语气模仿示例..."
                      className="form-control"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Capabilities Tab */}
            {activeFormTab === 'capabilities' && (
              <div className="tab-panel">
                {/* Tools */}
                <div className="section-block">
                  <div className="section-block-header">
                    <h4>工具权限</h4>
                  </div>

                  <div className="mode-switch">
                    <label className={`mode-option${toolsMode === 'all' ? ' checked' : ''}`}>
                      <input type="radio" name="toolsMode" checked={toolsMode === 'all'} onChange={() => onToolsModeChange('all')} className="sr-only" />
                      <span className="radio-indicator"></span>
                      <span className="mode-label">全部工具</span>
                      <span className="mode-desc">不限制，可使用所有工具</span>
                    </label>
                    <label className={`mode-option${toolsMode === 'selected' ? ' checked' : ''}`}>
                      <input type="radio" name="toolsMode" checked={toolsMode === 'selected'} onChange={() => onToolsModeChange('selected')} className="sr-only" />
                      <span className="radio-indicator"></span>
                      <span className="mode-label">指定工具</span>
                      <span className="mode-desc">仅允许使用选中的工具</span>
                    </label>
                  </div>

                  {toolsMode === 'selected' && (
                    <div className="selection-panel">
                      <div className="search-box">
                        <Search size={14} className="search-icon" />
                        <input
                          type="text"
                          value={toolSearch}
                          onChange={e => setToolSearch(e.target.value)}
                          placeholder="搜索工具..."
                          className="form-control sm"
                        />
                      </div>
                      <div className="check-list">
                        {filteredAvailableTools.map(tool => (
                          <label key={tool.name} className="check-item">
                            <input
                              type="checkbox"
                              checked={isToolSelected(tool.name)}
                              onChange={() => toggleTool(tool.name)}
                            />
                            <span className="check-item-name font-mono">{tool.name}</span>
                            {tool.description && <span className="check-item-desc">{tool.description}</span>}
                          </label>
                        ))}
                        {filteredAvailableTools.length === 0 && (
                          <div className="check-empty">
                            {toolsLoaded ? '没有可用的工具' : '加载中...'}
                          </div>
                        )}
                      </div>
                      {editingPersona.tools && editingPersona.tools.length > 0 && (
                        <div className="selected-tags">
                          <span className="selected-count">已选 {editingPersona.tools.length} 项</span>
                          {editingPersona.tools.map(name => (
                            <span key={name} className="tag tool-tag">
                              {name}
                              <X
                                size={10}
                                className="tag-remove"
                                role="button"
                                tabIndex={0}
                                aria-label={`移除 ${name}`}
                                onClick={() => toggleTool(name)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    toggleTool(name)
                                  }
                                }}
                              />
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Skills */}
                <div className="section-block">
                  <div className="section-block-header">
                    <h4>技能权限</h4>
                  </div>

                  <div className="mode-switch">
                    <label className={`mode-option${skillsMode === 'all' ? ' checked' : ''}`}>
                      <input type="radio" name="skillsMode" checked={skillsMode === 'all'} onChange={() => onSkillsModeChange('all')} className="sr-only" />
                      <span className="radio-indicator"></span>
                      <span className="mode-label">全部技能</span>
                      <span className="mode-desc">不限制，可使用所有技能</span>
                    </label>
                    <label className={`mode-option${skillsMode === 'selected' ? ' checked' : ''}`}>
                      <input type="radio" name="skillsMode" checked={skillsMode === 'selected'} onChange={() => onSkillsModeChange('selected')} className="sr-only" />
                      <span className="radio-indicator"></span>
                      <span className="mode-label">指定技能</span>
                      <span className="mode-desc">仅允许使用选中的技能</span>
                    </label>
                  </div>

                  {skillsMode === 'selected' && (
                    <div className="selection-panel">
                      <div className="search-box">
                        <Search size={14} className="search-icon" />
                        <input
                          type="text"
                          value={skillSearch}
                          onChange={e => setSkillSearch(e.target.value)}
                          placeholder="搜索技能..."
                          className="form-control sm"
                        />
                      </div>
                      <div className="check-list">
                        {filteredAvailableSkills.map(skill => (
                          <label key={skill.name} className="check-item">
                            <input
                              type="checkbox"
                              checked={isSkillSelected(skill.name)}
                              onChange={() => toggleSkill(skill.name)}
                            />
                            <span className="check-item-name font-mono">{skill.name}</span>
                            {skill.description && <span className="check-item-desc">{skill.description}</span>}
                          </label>
                        ))}
                        {filteredAvailableSkills.length === 0 && (
                          <div className="check-empty">
                            {skillsLoaded ? '没有可用的技能' : '加载中...'}
                          </div>
                        )}
                      </div>
                      {editingPersona.skills && editingPersona.skills.length > 0 && (
                        <div className="selected-tags">
                          <span className="selected-count">已选 {editingPersona.skills.length} 项</span>
                          {editingPersona.skills.map(name => (
                            <span key={name} className="tag skill-tag">
                              {name}
                              <X
                                size={10}
                                className="tag-remove"
                                role="button"
                                tabIndex={0}
                                aria-label={`移除 ${name}`}
                                onClick={() => toggleSkill(name)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    toggleSkill(name)
                                  }
                                }}
                              />
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Detail Modal */}
      <Modal
        open={showDetailModal}
        onClose={() => setShowDetailModal(false)}
        title={`${detailPersona?.name ?? ''} — 详情`}
        size="lg"
        footer={
          <>
            <button className="btn" onClick={() => setShowDetailModal(false)}>关闭</button>
            <button
              className="btn primary"
              onClick={() => {
                const p = detailPersona
                if (!p) return
                setShowDetailModal(false)
                handleEdit(p)
              }}
            >
              <Pencil size={14} /> 编辑
            </button>
          </>
        }
      >
        {detailPersona && (
          <>
            {/* Basic Info */}
            <div className="detail-section">
              <div className="detail-section-title">
                <FileText size={16} /> 基本信息
              </div>
              <div className="detail-grid">
                <div className="detail-field">
                  <span className="detail-label">ID</span>
                  <span className="detail-value font-mono">{detailPersona.id}</span>
                </div>
                <div className="detail-field">
                  <span className="detail-label">名称</span>
                  <span className="detail-value">{detailPersona.name}</span>
                </div>
              </div>
              <div className="detail-field full">
                <span className="detail-label">系统提示词</span>
                <div className="detail-prompt">{detailPersona.prompt}</div>
              </div>
              {detailPersona.customErrorMessage && (
                <div className="detail-field full">
                  <span className="detail-label">自定义错误消息</span>
                  <div className="detail-error-msg">{detailPersona.customErrorMessage}</div>
                </div>
              )}
            </div>

            {/* Dialogs */}
            <div className="detail-section">
              <div className="detail-section-title">
                <MessageSquare size={16} /> 预设对话
              </div>
              {detailDialogPairs.length > 0 ? (
                <div className="detail-dialogs">
                  {detailDialogPairs.map((pair, idx) => (
                    <div key={idx} className="detail-dialog-pair">
                      <div className="detail-dialog-bubble user-bubble">
                        <User size={12} /> {pair.user || '(空)'}
                      </div>
                      <div className="detail-dialog-bubble ai-bubble">
                        <Sparkles size={12} /> {pair.ai || '(空)'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="detail-empty">暂无预设对话</div>
              )}

              {detailPersona.moodImitationDialogs.length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                  <span className="detail-label">语气模仿对话</span>
                  <div className="detail-mood-items">
                    {detailPersona.moodImitationDialogs.map((item, idx) => (
                      <div key={idx} className="detail-mood-item">
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Tools & Skills */}
            <div className="detail-section">
              <div className="detail-section-title">
                <Zap size={16} /> 能力配置
              </div>
              <div className="detail-grid">
                <div className="detail-field">
                  <span className="detail-label">工具</span>
                  <span className="detail-value">
                    {detailPersona.tools === null ? (
                      '全部工具'
                    ) : (
                      <>
                        {detailPersona.tools.map(t => (
                          <span key={t} className="tag tool-tag">{t}</span>
                        ))}
                        {detailPersona.tools.length === 0 && <span className="muted">无</span>}
                      </>
                    )}
                  </span>
                </div>
                <div className="detail-field">
                  <span className="detail-label">技能</span>
                  <span className="detail-value">
                    {detailPersona.skills === null ? (
                      '全部技能'
                    ) : (
                      <>
                        {detailPersona.skills.map(s => (
                          <span key={s} className="tag skill-tag">{s}</span>
                        ))}
                        {detailPersona.skills.length === 0 && <span className="muted">无</span>}
                      </>
                    )}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* Delete Confirm Modal */}
      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title="确认删除"
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setShowDeleteModal(false)}>取消</button>
            <button className="btn danger" onClick={executeDelete}>确认删除</button>
          </>
        }
      >
        <div className="delete-confirm-content">
          <AlertCircle size={32} className="delete-warn-icon" />
          <p>确定要删设定 <strong>{deleteTarget?.name}</strong> (ID: <code className="font-mono">{deleteTarget?.id}</code>) 吗？</p>
          <p className="delete-sub">此操作不可撤销</p>
        </div>
      </Modal>

      {/* Toast */}
      <ToastPortal toast={toast} />
    </div>
  )
}
