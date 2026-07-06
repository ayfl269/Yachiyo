import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, Trash2, RefreshCw, Upload, Download,
  FileArchive, ArrowUpFromLine, XCircle, CheckCircle,
  AlertTriangle, FolderOpen, FileText, File as FileIcon,
  Folder, ToggleLeft, ToggleRight, Sparkles, Package, Eye,
  Save, ChevronRight, Search
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useToast, ToastPortal, Modal } from './shared'
import { apiFetch } from '../lib/api'

// ===== Types =====
interface Skill {
  name: string
  description: string
  path: string
  active: boolean
  sourceType: string
  sourceLabel: string
  localExists: boolean
  sandboxExists: boolean
  pluginName: string | null
  readonly: boolean
}

type SkillUploadStatus = 'registered' | 'skipped_duplicate' | 'error'

interface UploadResultSkill {
  name: string
  status: SkillUploadStatus
  message: string
}

interface UploadResult {
  zipFile: string
  skills: UploadResultSkill[]
}

interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size?: number
}

interface RegisterForm {
  name: string
  description: string
  path: string
  sourceType: string
  sourceLabel: string
  active: boolean
}

interface PathStackItem {
  name: string
  path: string
}

const SOURCE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'manual', label: '手动注册' },
  { value: 'local', label: '本地文件扫描' },
  { value: 'plugin', label: '插件提供' },
  { value: 'upload', label: 'ZIP上传' }
]

export default function SkillManager() {
  // ===== State =====
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')

  // Toast
  const { toast, showMessage } = useToast()

  // Register dialog
  const [showRegisterDialog, setShowRegisterDialog] = useState(false)
  const [registerForm, setRegisterForm] = useState<RegisterForm>({
    name: '', description: '', path: '',
    sourceType: 'manual', sourceLabel: '手动注册', active: true
  })

  // Delete confirm dialog
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null)

  // Upload dialog
  const [showUploadPanel, setShowUploadPanel] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([])
  const [uploadError, setUploadError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // File browser dialog
  const [showFileBrowser, setShowFileBrowser] = useState(false)
  const [browserSkillName, setBrowserSkillName] = useState('')
  const [browserFiles, setBrowserFiles] = useState<FileEntry[]>([])
  const [browserLoading, setBrowserLoading] = useState(false)
  const [browserPathStack, setBrowserPathStack] = useState<PathStackItem[]>([])

  // File viewer/editor
  const [showFileViewer, setShowFileViewer] = useState(false)
  const [viewerFileName, setViewerFileName] = useState('')
  const [viewerFilePath, setViewerFilePath] = useState('')
  const [viewerContent, setViewerContent] = useState('')
  const [viewerLoading, setViewerLoading] = useState(false)
  const [viewerSaving, setViewerSaving] = useState(false)
  const viewerIsReadonly = false

  // ===== Computed =====
  const activeCount = useMemo(() => skills.filter(s => s.active).length, [skills])
  const totalCount = skills.length

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.sourceType.toLowerCase().includes(q)
    )
  }, [skills, searchQuery])

  const uploadSummary = useMemo(() => {
    let registered = 0, skipped = 0, errors = 0
    for (const r of uploadResults) {
      for (const s of r.skills) {
        if (s.status === 'registered') registered++
        else if (s.status === 'skipped_duplicate') skipped++
        else errors++
      }
    }
    return { registered, skipped, errors }
  }, [uploadResults])

  // ===== API =====
  async function fetchSkills() {
    setLoading(true)
    try {
      const res = await apiFetch('/api/skills')
      if (res.ok) setSkills(await res.json())
    } catch (error) {
      console.error('Error fetching skills:', error)
      showMessage('加载技能列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function handleToggleActive(skill: Skill) {
    const newStatus = !skill.active
    try {
      const res = await apiFetch(`/api/skills/${encodeURIComponent(skill.name)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: newStatus })
      })
      if (res.ok) {
        setSkills(prev => prev.map(s => s.name === skill.name ? { ...s, active: newStatus } : s))
        showMessage(newStatus ? `已启用 "${skill.name}"` : `已停用 "${skill.name}"`)
      } else {
        showMessage('状态切换失败', 'error')
      }
    } catch (error) {
      console.error(error)
      showMessage('状态切换失败', 'error')
    }
  }

  // Register
  function openRegisterDialog() {
    setRegisterForm({
      name: '', description: '', path: '',
      sourceType: 'manual', sourceLabel: '手动注册', active: true
    })
    setShowRegisterDialog(true)
  }

  async function handleRegister() {
    const form = registerForm
    if (!form.name.trim()) { showMessage('技能名称不能为空', 'error'); return }
    try {
      const res = await apiFetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          path: form.path || '',
          sourceType: form.sourceType,
          sourceLabel: form.sourceLabel || form.sourceType,
          active: form.active
        })
      })
      if (res.ok) {
        showMessage(`技能 "${form.name.trim()}" 注册成功`)
        setShowRegisterDialog(false)
        await fetchSkills()
      } else {
        const d = await res.json().catch(() => ({}))
        showMessage(d.error || '注册失败', 'error')
      }
    } catch (error) {
      console.error(error)
      showMessage('注册失败', 'error')
    }
  }

  // Delete
  function confirmDelete(skill: Skill) {
    if (skill.readonly) { showMessage('只读技能不可删除', 'error'); return }
    setDeleteTarget(skill)
    setShowDeleteDialog(true)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      const res = await apiFetch(`/api/skills/${encodeURIComponent(deleteTarget.name)}`, { method: 'DELETE' })
      if (res.ok) {
        showMessage(`技能 "${deleteTarget.name}" 已删除`)
        setShowDeleteDialog(false)
        setDeleteTarget(null)
        await fetchSkills()
      } else {
        showMessage('删除失败', 'error')
      }
    } catch (error) {
      console.error(error)
      showMessage('删除失败', 'error')
    }
  }

  // Download
  async function handleDownload(skill: Skill) {
    try {
      const res = await apiFetch(`/api/skills/download?name=${encodeURIComponent(skill.name)}`)
      if (!res.ok) { showMessage('下载失败', 'error'); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${skill.name}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      showMessage(`已下载 "${skill.name}.zip"`)
    } catch (error) {
      console.error(error)
      showMessage('下载失败', 'error')
    }
  }

  // Upload
  function onDragOver(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); setIsDragging(true) }
  function onDragLeave(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); setIsDragging(false) }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false)
    if (!e.dataTransfer?.files?.length) return
    addFiles(Array.from(e.dataTransfer.files))
  }
  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) addFiles(Array.from(e.target.files))
    e.target.value = ''
  }
  function addFiles(files: File[]) {
    const zipFiles = files.filter(f => f.name.toLowerCase().endsWith('.zip'))
    if (zipFiles.length === 0) { setUploadError('仅支持 .zip 格式的文件'); return }
    setUploadError('')
    setSelectedFiles(prev => [...prev, ...zipFiles])
  }
  function removeFile(index: number) {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }
  function clearAllFiles() {
    setSelectedFiles([])
    setUploadResults([])
    setUploadError('')
  }

  async function handleUpload() {
    if (selectedFiles.length === 0) return
    setIsUploading(true)
    setUploadResults([])
    setUploadError('')
    try {
      const formData = new FormData()
      for (const f of selectedFiles) formData.append('files', f)
      const res = await apiFetch('/api/skills/upload-zip', { method: 'POST', body: formData })
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '上传失败' }))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setUploadResults(data.results || [])
      await fetchSkills()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '上传过程中发生错误')
    } finally {
      setIsUploading(false)
    }
  }

  function closeUploadPanel() {
    setShowUploadPanel(false)
    clearAllFiles()
  }

  // File Browser
  async function openFileBrowser(skill: Skill) {
    setBrowserSkillName(skill.name)
    setBrowserPathStack([{ name: skill.name, path: '' }])
    setShowFileBrowser(true)
    await loadFileList('', skill.name)
  }

  async function loadFileList(dirPath: string, name?: string) {
    const skillName = name ?? browserSkillName
    setBrowserLoading(true)
    try {
      const params = new URLSearchParams({ name: skillName, path: dirPath })
      const res = await apiFetch(`/api/skills/files?${params}`)
      if (res.ok) {
        setBrowserFiles(await res.json())
      } else {
        showMessage('加载文件列表失败', 'error')
      }
    } catch (error) {
      console.error(error)
      showMessage('加载文件列表失败', 'error')
    } finally {
      setBrowserLoading(false)
    }
  }

  function navigateToFolder(entry: FileEntry) {
    if (!entry.is_dir) return
    setBrowserPathStack(prev => {
      const existingIdx = prev.findIndex(p => p.path === entry.path)
      if (existingIdx >= 0) return prev.slice(0, existingIdx + 1)
      return [...prev, { name: entry.name, path: entry.path }]
    })
    loadFileList(entry.path)
  }

  function navigateToBreadcrumb(index: number) {
    const target = browserPathStack[index]
    setBrowserPathStack(prev => prev.slice(0, index + 1))
    loadFileList(target.path)
  }

  async function openFileViewer(entry: FileEntry) {
    if (entry.is_dir) { navigateToFolder(entry); return }
    setViewerFileName(entry.name)
    setViewerFilePath(entry.path)
    setViewerContent('')
    setViewerLoading(true)
    setShowFileViewer(true)
    try {
      const params = new URLSearchParams({ name: browserSkillName, path: entry.path })
      const res = await apiFetch(`/api/skills/file?${params}`)
      if (res.ok) {
        setViewerContent(await res.text())
      } else {
        showMessage('加载文件内容失败', 'error')
      }
    } catch (error) {
      console.error(error)
      showMessage('加载文件内容失败', 'error')
    } finally {
      setViewerLoading(false)
    }
  }

  async function saveFileContent() {
    setViewerSaving(true)
    try {
      const res = await apiFetch('/api/skills/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: browserSkillName,
          path: viewerFilePath,
          content: viewerContent
        })
      })
      if (res.ok) {
        showMessage('文件保存成功')
      } else {
        showMessage('文件保存失败', 'error')
      }
    } catch (error) {
      console.error(error)
      showMessage('文件保存失败', 'error')
    } finally {
      setViewerSaving(false)
    }
  }

  function closeFileViewer() {
    setShowFileViewer(false)
    setViewerFileName('')
    setViewerFilePath('')
    setViewerContent('')
  }

  // ===== Helpers =====
  function getSourceIcon(skill: Skill): LucideIcon {
    if (skill.pluginName) return Package
    if (skill.localExists) return FolderOpen
    return FileText
  }

  function getSourceBadgeClass(skill: Skill): string {
    if (skill.pluginName) return 'plugin'
    if (skill.localExists) return 'local'
    return skill.sourceType === 'upload' ? 'upload' : 'manual'
  }

  function getSourceLabelText(skill: Skill): string {
    if (skill.pluginName) return `插件: ${skill.pluginName}`
    if (skill.localExists) return '本地文件'
    if (skill.sourceType === 'upload') return 'ZIP上传'
    if (skill.sourceType === 'manual') return '手动注册'
    return skill.sourceLabel || skill.sourceType
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1048576).toFixed(1) + ' MB'
  }

  function getStatusIcon(status: SkillUploadStatus): LucideIcon {
    if (status === 'registered') return CheckCircle
    if (status === 'skipped_duplicate') return AlertTriangle
    return XCircle
  }

  function getStatusLabel(status: SkillUploadStatus): string {
    if (status === 'registered') return '已注册'
    if (status === 'skipped_duplicate') return '已跳过'
    return '错误'
  }

  // ===== Lifecycle =====
  useEffect(() => {
    fetchSkills()
  }, [])

  // ===== Render =====
  return (
    <div className="skill-page animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1>技能管理</h1>
          <p>管理 Agent 可调用的技能，通过预设流程扩展其行动能力</p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={fetchSkills} disabled={loading} title="刷新列表">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          <button className="btn primary-outline" onClick={() => setShowUploadPanel(true)}>
            <Upload size={16} /> 上传 ZIP
          </button>
          <button className="btn primary" onClick={openRegisterDialog}>
            <Plus size={16} /> 注册技能
          </button>
        </div>
      </div>

      {/* Stats & Search */}
      <div className="toolbar">
        <div className="stats-bar">
          <Sparkles size={16} className="stat-icon active" />
          <span>已激活 <strong>{activeCount}</strong> / {totalCount} 个</span>
        </div>
        <div className="search-box">
          <Search size={14} className="search-icon" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索技能..."
            className="form-control sm"
          />
        </div>
      </div>

      {/* Loading */}
      {loading && skills.length === 0 && (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      )}

      {/* Skills Grid */}
      {!(loading && skills.length === 0) && (
        <div className="skills-grid">
          {filteredSkills.map(skill => {
            const SourceIcon = getSourceIcon(skill)
            return (
              <div key={skill.name} className={`skill-card${!skill.active ? ' inactive' : ''}`}>
                <div className="card-header">
                  <div className="title-info">
                    <div className="name-row">
                      <SourceIcon size={16} className="accent" />
                      <h3>{skill.name}</h3>
                      <span className={`source-tag ${getSourceBadgeClass(skill)}`}>
                        {getSourceLabelText(skill)}
                      </span>
                      {skill.readonly && <span className="source-tag readonly">只读</span>}
                    </div>
                    <p className="description">{skill.description || '暂无描述'}</p>
                  </div>
                  <div className="actions">
                    <button
                      className="icon-btn"
                      title={skill.active ? '停用技能' : '启用技能'}
                      onClick={() => handleToggleActive(skill)}
                    >
                      {skill.active
                        ? <ToggleRight size={22} className="toggle-icon active" />
                        : <ToggleLeft size={22} className="toggle-icon" />}
                    </button>
                  </div>
                </div>

                <div className="card-body">
                  <div className="details-list">
                    {skill.path && (
                      <div className="info-row">
                        <span className="label">来源路径</span>
                        <span className="value font-mono text-truncate" title={skill.path}>{skill.path}</span>
                      </div>
                    )}
                    <div className="status-row">
                      <div className={`status-indicator-item${skill.active ? ' ok' : ''}`}>
                        {skill.active
                          ? <CheckCircle size={14} className="status-icon" />
                          : <AlertTriangle size={14} className="status-icon" />}
                        <span>{skill.active ? '已激活 - Agent 可见' : '已停用 - 对 Agent 隐藏'}</span>
                      </div>
                      {skill.localExists && (
                        <div className="status-indicator-item ok">
                          <FolderOpen size={14} className="status-icon" />
                          <span>本地目录存在</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="card-footer">
                  <button className="btn sm" onClick={() => openFileBrowser(skill)} title="浏览文件">
                    <Eye size={14} /> 浏览
                  </button>
                  <button className="btn sm" onClick={() => handleDownload(skill)} title="下载 ZIP">
                    <Download size={14} /> 下载
                  </button>
                  {!skill.readonly && (
                    <button className="btn sm danger" onClick={() => confirmDelete(skill)} title="删除">
                      <Trash2 size={14} /> 删除
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          {/* Empty State */}
          {skills.length === 0 && !loading && (
            <div className="no-data-card">
              <FileText size={48} className="empty-icon" />
              <h3>暂无已注册的技能</h3>
              <p>在 <code>data/skills/</code> 目录下创建包含 <code>skill.md</code> 或 <code>manifest.json</code> 的子目录来定义技能，或使用下方按钮手动注册或批量上传 ZIP 包。</p>
              <div className="format-hints">
                <div className="format-hint">
                  <strong>skill.md</strong>
                  <code>{'# 技能名\n---\nname: my-skill\ndescription: 描述\n---'}</code>
                </div>
                <div className="format-hint">
                  <strong>manifest.json</strong>
                  <code>{"{\"name\":\"my-skill\",\"description\":\"描述\"}"}</code>
                </div>
                <div className="format-hint">
                  <strong>skills.md</strong>
                  <code>- skill-name: 技能描述文本</code>
                </div>
              </div>
              <div className="empty-actions">
                <button className="btn primary" onClick={() => setShowUploadPanel(true)}><Upload size={16} /> 上传 ZIP 包</button>
                <button className="btn" onClick={openRegisterDialog}><Plus size={16} /> 手动注册</button>
              </div>
            </div>
          )}

          {filteredSkills.length === 0 && skills.length > 0 && (
            <div className="no-data-card">
              <Search size={48} className="empty-icon" />
              <h3>未找到匹配的技能</h3>
              <p>尝试使用不同的关键词搜索。</p>
            </div>
          )}
        </div>
      )}

      {/* Register Dialog */}
      <Modal
        open={showRegisterDialog}
        onClose={() => setShowRegisterDialog(false)}
        title="注册新技能"
        footer={
          <>
            <button className="btn" onClick={() => setShowRegisterDialog(false)}>取消</button>
            <button className="btn primary" onClick={handleRegister}>注册技能</button>
          </>
        }
      >
        <div className="form-group">
          <label>技能标识名 <span className="required">*</span></label>
          <input
            type="text"
            value={registerForm.name}
            onChange={e => setRegisterForm(prev => ({ ...prev, name: e.target.value }))}
            placeholder="例如: code-review, debugging"
            className="form-control"
          />
          <span className="help-text">唯一标识符，将出现在 Agent 的系统提示中。建议使用 kebab-case 命名。</span>
        </div>
        <div className="form-group">
          <label>技能描述</label>
          <textarea
            value={registerForm.description}
            onChange={e => setRegisterForm(prev => ({ ...prev, description: e.target.value }))}
            placeholder="例如: 审查代码质量、安全性及性能问题..."
            rows={3}
            className="form-control"
          />
          <span className="help-text">向 LLM 声明的技能功能说明。Agent 将根据此描述判断何时使用该技能。</span>
        </div>
        <div className="form-group">
          <label>来源路径</label>
          <input
            type="text"
            value={registerForm.path}
            onChange={e => setRegisterForm(prev => ({ ...prev, path: e.target.value }))}
            placeholder="可选"
            className="form-control font-mono"
          />
          <span className="help-text">可选。标记技能的物理来源路径，用于调试和溯源。</span>
        </div>
        <div className="form-row-2">
          <div className="form-group">
            <label>激活状态</label>
            <select
              value={String(registerForm.active)}
              onChange={e => setRegisterForm(prev => ({ ...prev, active: e.target.value === 'true' }))}
              className="form-control"
            >
              <option value="true">启用 - Agent 可见</option>
              <option value="false">停用 - Agent 隐藏</option>
            </select>
          </div>
          <div className="form-group">
            <label>来源类型</label>
            <select
              value={registerForm.sourceType}
              onChange={e => {
                const newType = e.target.value
                const opt = SOURCE_TYPE_OPTIONS.find(o => o.value === newType)
                setRegisterForm(prev => ({
                  ...prev,
                  sourceType: newType,
                  sourceLabel: opt?.label || newType
                }))
              }}
              className="form-control"
            >
              {SOURCE_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      </Modal>

      {/* Delete Confirm Dialog */}
      <Modal
        open={showDeleteDialog}
        onClose={() => setShowDeleteDialog(false)}
        title="确认删除"
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setShowDeleteDialog(false)}>取消</button>
            <button className="btn danger" onClick={handleDelete}>确认删除</button>
          </>
        }
      >
        <div className="confirm-content">
          <AlertTriangle size={32} className="confirm-icon danger" />
          <p>确定要删除技能 <strong>"{deleteTarget?.name}"</strong> 吗？</p>
          <span className="help-text">删除后 Agent 将不再感知该技能，此操作不可撤销。</span>
        </div>
      </Modal>

      {/* Upload ZIP Dialog */}
      <Modal
        open={showUploadPanel}
        onClose={closeUploadPanel}
        title="批量上传 ZIP 技能包"
      >
        <p className="upload-desc">拖拽或选择 .zip 文件，系统自动解析目录结构并校验 SKILL.md</p>

        {/* Drop Zone */}
        <div
          className={`drop-zone${isDragging ? ' dragging' : ''}${isUploading ? ' disabled' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".zip" multiple hidden onChange={onFileInputChange} />
          {!isUploading ? (
            <>
              <ArrowUpFromLine size={40} className={`drop-icon${isDragging ? ' active' : ''}`} />
              <p className="drop-text">将 ZIP 文件拖放到此处，或点击选择文件</p>
              <p className="drop-hint">支持同时上传多个 .zip 文件，每个压缩包可包含多个技能文件夹</p>
            </>
          ) : (
            <>
              <div className="spinner"></div>
              <p className="drop-text">正在解析并注册技能...</p>
            </>
          )}
        </div>

        {/* Selected Files */}
        {selectedFiles.length > 0 && (
          <div className="file-list-section">
            <div className="section-header">
              <strong>已选文件 ({selectedFiles.length})</strong>
              <button className="btn-text danger" onClick={clearAllFiles}>清空全部</button>
            </div>
            <div className="file-list">
              {selectedFiles.map((file, idx) => (
                <div key={`${idx}-${file.name}`} className="file-item">
                  <FileArchive size={18} className="file-icon" />
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatFileSize(file.size)}</span>
                  <button className="icon-btn sm" onClick={() => removeFile(idx)} title="移除"><XCircle size={16} /></button>
                </div>
              ))}
            </div>
            <div className="upload-actions">
              <button
                className="btn primary"
                onClick={handleUpload}
                disabled={isUploading || selectedFiles.length === 0}
              >
                <Upload size={16} /> {isUploading ? '处理中...' : `开始上传 (${selectedFiles.length} 个文件)`}
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {uploadError && <div className="alert error">{uploadError}</div>}

        {/* Results */}
        {uploadResults.length > 0 && (
          <div className="results-section">
            <div className="results-header">
              <h3>上传结果</h3>
              <div className="summary-badges">
                {uploadSummary.registered > 0 && (
                  <span className="badge success">
                    <CheckCircle size={13} className="badge-icon" /> +{uploadSummary.registered} 注册成功
                  </span>
                )}
                {uploadSummary.skipped > 0 && (
                  <span className="badge warning">
                    <AlertTriangle size={13} className="badge-icon" /> {uploadSummary.skipped} 跳过重复
                  </span>
                )}
                {uploadSummary.errors > 0 && (
                  <span className="badge error">
                    <XCircle size={13} className="badge-icon" /> {uploadSummary.errors} 校验失败
                  </span>
                )}
              </div>
            </div>
            {uploadResults.map(result => (
              <div key={result.zipFile} className="result-group">
                <div className="result-zip-name">
                  <FileArchive size={16} className="accent" /> {result.zipFile}
                </div>
                <div className="result-items">
                  {result.skills.map(skill => {
                    const StatusIcon = getStatusIcon(skill.status)
                    return (
                      <div key={`${skill.name}-${skill.status}`} className={`result-item ${skill.status}`}>
                        <StatusIcon size={17} className="result-status-icon" />
                        <div className="result-info">
                          <span className="result-name">{skill.name}</span>
                          <span className="result-msg">{skill.message}</span>
                        </div>
                        <span className={`result-badge ${skill.status}`}>
                          {getStatusLabel(skill.status)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* File Browser Dialog */}
      <Modal
        open={showFileBrowser}
        onClose={() => setShowFileBrowser(false)}
        title={`文件浏览 - ${browserSkillName}`}
        size="lg"
      >
        {/* Breadcrumb */}
        <div className="breadcrumb">
          {browserPathStack.map((item, idx) => (
            <button
              key={idx}
              className={`breadcrumb-item${idx === browserPathStack.length - 1 ? ' current' : ''}`}
              onClick={() => navigateToBreadcrumb(idx)}
            >
              {idx > 0 && <ChevronRight size={12} className="breadcrumb-sep" />}
              {item.name}
            </button>
          ))}
        </div>

        {/* Loading */}
        {browserLoading ? (
          <div className="loading-state compact">
            <div className="spinner"></div>
            <p>加载中...</p>
          </div>
        ) : browserFiles.length > 0 ? (
          <div className="browser-file-list">
            {browserFiles.map(entry => (
              <div
                key={entry.path}
                className="browser-file-item"
                onClick={() => entry.is_dir ? navigateToFolder(entry) : openFileViewer(entry)}
              >
                {entry.is_dir
                  ? <Folder size={18} className="browser-file-icon folder" />
                  : <FileIcon size={18} className="browser-file-icon" />}
                <span className="browser-file-name">{entry.name}</span>
                {entry.size && <span className="browser-file-size">{formatFileSize(entry.size)}</span>}
                {entry.is_dir && <ChevronRight size={14} className="browser-chevron" />}
              </div>
            ))}
          </div>
        ) : (
          <div className="browser-empty">
            <FolderOpen size={32} className="empty-icon" />
            <p>此目录为空</p>
          </div>
        )}
      </Modal>

      {/* File Viewer/Editor Dialog */}
      <Modal
        open={showFileViewer}
        onClose={closeFileViewer}
        title={viewerFileName}
        size="lg"
        footer={
          <>
            <button className="btn" onClick={closeFileViewer}>关闭</button>
            <button className="btn primary" disabled={viewerSaving} onClick={saveFileContent}>
              {viewerSaving
                ? <><RefreshCw size={14} className="animate-spin" /> 保存中...</>
                : <><Save size={14} /> 保存</>}
            </button>
          </>
        }
      >
        {viewerLoading ? (
          <div className="loading-state compact">
            <div className="spinner"></div>
            <p>加载中...</p>
          </div>
        ) : (
          <div className="viewer-body">
            <textarea
              value={viewerContent}
              onChange={e => setViewerContent(e.target.value)}
              className="file-editor"
              readOnly={viewerIsReadonly}
              spellCheck={false}
            />
          </div>
        )}
      </Modal>

      {/* Toast */}
      <ToastPortal toast={toast} />
    </div>
  )
}
