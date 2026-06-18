<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  Plus, X, Trash2, RefreshCw, Upload, Download,
  FileArchive, ArrowUpFromLine, XCircle, CheckCircle,
  AlertTriangle, FolderOpen, FileText, File, Folder,
  ToggleLeft, ToggleRight, Sparkles, Package, Eye,
  Save, ChevronRight, Search
} from 'lucide-vue-next'

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

interface UploadResult {
  zipFile: string
  skills: Array<{
    name: string
    status: 'registered' | 'skipped_duplicate' | 'error'
    message: string
  }>
}

interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size?: number
}

// ===== State =====
const skills = ref<Skill[]>([])
const loading = ref(true)
const searchQuery = ref('')

// Toast
const toast = ref({ show: false, message: '', color: 'success' })
let toastTimer: number | null = null

function showMessage(message: string, color = 'success') {
  toast.value = { show: true, message, color }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value.show = false }, 3000)
}

// Register dialog
const showRegisterDialog = ref(false)
const registerForm = ref({
  name: '',
  description: '',
  path: '',
  sourceType: 'manual',
  sourceLabel: '手动注册',
  active: true
})

// Delete confirm dialog
const showDeleteDialog = ref(false)
const deleteTarget = ref<Skill | null>(null)

// Upload dialog
const showUploadPanel = ref(false)
const isDragging = ref(false)
const isUploading = ref(false)
const selectedFiles = ref<File[]>([])
const uploadResults = ref<UploadResult[]>([])
const uploadError = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)

// File browser dialog
const showFileBrowser = ref(false)
const browserSkillName = ref('')
const browserCurrentPath = ref('')
const browserFiles = ref<FileEntry[]>([])
const browserLoading = ref(false)
const browserPathStack = ref<{ name: string; path: string }[]>([])

// File viewer/editor
const showFileViewer = ref(false)
const viewerFileName = ref('')
const viewerFilePath = ref('')
const viewerContent = ref('')
const viewerLoading = ref(false)
const viewerSaving = ref(false)
const viewerIsReadonly = ref(false)

// ===== Computed =====
const activeCount = computed(() => skills.value.filter(s => s.active).length)
const totalCount = computed(() => skills.value.length)

const filteredSkills = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return skills.value
  return skills.value.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.sourceType.toLowerCase().includes(q)
  )
})

const uploadSummary = computed(() => {
  let registered = 0, skipped = 0, errors = 0
  for (const r of uploadResults.value) {
    for (const s of r.skills) {
      if (s.status === 'registered') registered++
      else if (s.status === 'skipped_duplicate') skipped++
      else errors++
    }
  }
  return { registered, skipped, errors }
})

// ===== API =====
const fetchSkills = async () => {
  loading.value = true
  try {
    const res = await fetch('/api/skills')
    if (res.ok) skills.value = await res.json()
  } catch (error) {
    console.error('Error fetching skills:', error)
    showMessage('加载技能列表失败', 'error')
  } finally {
    loading.value = false
  }
}

const handleToggleActive = async (skill: Skill) => {
  const newStatus = !skill.active
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skill.name)}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: newStatus })
    })
    if (res.ok) {
      skill.active = newStatus
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
const openRegisterDialog = () => {
  registerForm.value = {
    name: '', description: '', path: '',
    sourceType: 'manual', sourceLabel: '手动注册', active: true
  }
  showRegisterDialog.value = true
}

const handleRegister = async () => {
  const form = registerForm.value
  if (!form.name.trim()) { showMessage('技能名称不能为空', 'error'); return }
  try {
    const res = await fetch('/api/skills', {
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
      showRegisterDialog.value = false
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
const confirmDelete = (skill: Skill) => {
  if (skill.readonly) { showMessage('只读技能不可删除', 'error'); return }
  deleteTarget.value = skill
  showDeleteDialog.value = true
}

const handleDelete = async () => {
  if (!deleteTarget.value) return
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(deleteTarget.value.name)}`, { method: 'DELETE' })
    if (res.ok) {
      showMessage(`技能 "${deleteTarget.value.name}" 已删除`)
      showDeleteDialog.value = false
      deleteTarget.value = null
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
const handleDownload = async (skill: Skill) => {
  try {
    const res = await fetch(`/api/skills/download?name=${encodeURIComponent(skill.name)}`)
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
const onDragOver = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); isDragging.value = true }
const onDragLeave = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); isDragging.value = false }
const onDrop = (e: DragEvent) => {
  e.preventDefault(); e.stopPropagation(); isDragging.value = false
  if (!e.dataTransfer?.files?.length) return
  addFiles(Array.from(e.dataTransfer.files))
}
const onFileInputChange = (e: Event) => {
  const target = e.target as HTMLInputElement
  if (target.files?.length) addFiles(Array.from(target.files))
  target.value = ''
}
const addFiles = (files: File[]) => {
  const zipFiles = files.filter(f => f.name.toLowerCase().endsWith('.zip'))
  if (zipFiles.length === 0) { uploadError.value = '仅支持 .zip 格式的文件'; return }
  uploadError.value = ''
  selectedFiles.value.push(...zipFiles)
}
const removeFile = (index: number) => { selectedFiles.value.splice(index, 1) }
const clearAllFiles = () => { selectedFiles.value = []; uploadResults.value = []; uploadError.value = '' }

const handleUpload = async () => {
  if (selectedFiles.value.length === 0) return
  isUploading.value = true
  uploadResults.value = []
  uploadError.value = ''
  try {
    const formData = new FormData()
    for (const f of selectedFiles.value) formData.append('files', f)
    const res = await fetch('/api/skills/upload-zip', { method: 'POST', body: formData })
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: '上传失败' }))
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    const data = await res.json()
    uploadResults.value = data.results || []
    await fetchSkills()
  } catch (err: any) {
    uploadError.value = err.message || '上传过程中发生错误'
  } finally {
    isUploading.value = false
  }
}

const closeUploadPanel = () => { showUploadPanel.value = false; clearAllFiles() }

// File Browser
const openFileBrowser = async (skill: Skill) => {
  browserSkillName.value = skill.name
  browserCurrentPath.value = ''
  browserPathStack.value = [{ name: skill.name, path: '' }]
  showFileBrowser.value = true
  await loadFileList('')
}

const loadFileList = async (dirPath: string) => {
  browserLoading.value = true
  try {
    const params = new URLSearchParams({ name: browserSkillName.value, path: dirPath })
    const res = await fetch(`/api/skills/files?${params}`)
    if (res.ok) {
      browserFiles.value = await res.json()
      browserCurrentPath.value = dirPath
    } else {
      showMessage('加载文件列表失败', 'error')
    }
  } catch (error) {
    console.error(error)
    showMessage('加载文件列表失败', 'error')
  } finally {
    browserLoading.value = false
  }
}

const navigateToFolder = (entry: FileEntry) => {
  if (!entry.is_dir) return
  const existingIdx = browserPathStack.value.findIndex(p => p.path === entry.path)
  if (existingIdx >= 0) {
    browserPathStack.value = browserPathStack.value.slice(0, existingIdx + 1)
  } else {
    browserPathStack.value.push({ name: entry.name, path: entry.path })
  }
  loadFileList(entry.path)
}

const navigateToBreadcrumb = (index: number) => {
  const target = browserPathStack.value[index]
  browserPathStack.value = browserPathStack.value.slice(0, index + 1)
  loadFileList(target.path)
}

const openFileViewer = async (entry: FileEntry) => {
  if (entry.is_dir) { navigateToFolder(entry); return }
  viewerFileName.value = entry.name
  viewerFilePath.value = entry.path
  viewerContent.value = ''
  viewerLoading.value = true
  showFileViewer.value = true
  try {
    const params = new URLSearchParams({ name: browserSkillName.value, path: entry.path })
    const res = await fetch(`/api/skills/file?${params}`)
    if (res.ok) {
      viewerContent.value = await res.text()
    } else {
      showMessage('加载文件内容失败', 'error')
    }
  } catch (error) {
    console.error(error)
    showMessage('加载文件内容失败', 'error')
  } finally {
    viewerLoading.value = false
  }
}

const saveFileContent = async () => {
  viewerSaving.value = true
  try {
    const res = await fetch('/api/skills/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: browserSkillName.value,
        path: viewerFilePath.value,
        content: viewerContent.value
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
    viewerSaving.value = false
  }
}

const closeFileViewer = () => {
  showFileViewer.value = false
  viewerFileName.value = ''
  viewerFilePath.value = ''
  viewerContent.value = ''
}

// ===== Helpers =====
const getSourceIcon = (skill: Skill) => {
  if (skill.pluginName) return Package
  if (skill.localExists) return FolderOpen
  return FileText
}

const getSourceBadgeClass = (skill: Skill) => {
  if (skill.pluginName) return 'plugin'
  if (skill.localExists) return 'local'
  return skill.sourceType === 'upload' ? 'upload' : 'manual'
}

const getSourceLabelText = (skill: Skill) => {
  if (skill.pluginName) return `插件: ${skill.pluginName}`
  if (skill.localExists) return '本地文件'
  if (skill.sourceType === 'upload') return 'ZIP上传'
  if (skill.sourceType === 'manual') return '手动注册'
  return skill.sourceLabel || skill.sourceType
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(1) + ' MB'
}

const sourceTypeOptions = [
  { value: 'manual', label: '手动注册' },
  { value: 'local', label: '本地文件扫描' },
  { value: 'plugin', label: '插件提供' },
  { value: 'upload', label: 'ZIP上传' }
]

const onSourceTypeChange = () => {
  const opt = sourceTypeOptions.find(o => o.value === registerForm.value.sourceType)
  registerForm.value.sourceLabel = opt?.label || registerForm.value.sourceType
}

onMounted(fetchSkills)
</script>

<template>
  <div class="skill-page animate-fade-in">
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1>技能管理</h1>
        <p>管理 Agent 可用的技能（Skills）。支持手动注册、ZIP 批量导入、文件浏览与编辑。</p>
      </div>
      <div class="header-actions">
        <button class="btn" @click="fetchSkills" :disabled="loading" title="刷新列表">
          <RefreshCw :size="16" :class="{ 'animate-spin': loading }" />
        </button>
        <button class="btn primary-outline" @click="showUploadPanel = true">
          <Upload :size="16" /> 上传 ZIP
        </button>
        <button class="btn primary" @click="openRegisterDialog">
          <Plus :size="16" /> 注册技能
        </button>
      </div>
    </div>

    <!-- Stats & Search -->
    <div class="toolbar">
      <div class="stats-bar">
        <Sparkles :size="16" class="stat-icon active" />
        <span>已激活 <strong>{{ activeCount }}</strong> / {{ totalCount }} 个</span>
      </div>
      <div class="search-box">
        <Search :size="14" class="search-icon" />
        <input type="text" v-model="searchQuery" placeholder="搜索技能..." class="form-control sm" />
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && skills.length === 0" class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- Skills Grid -->
    <div v-else class="skills-grid">
      <div v-for="skill in filteredSkills" :key="skill.name" class="skill-card" :class="{ inactive: !skill.active }">
        <div class="card-header">
          <div class="title-info">
            <div class="name-row">
              <component :is="getSourceIcon(skill)" :size="16" class="accent" />
              <h3>{{ skill.name }}</h3>
              <span :class="['source-tag', getSourceBadgeClass(skill)]">
                {{ getSourceLabelText(skill) }}
              </span>
              <span v-if="skill.readonly" class="source-tag readonly">只读</span>
            </div>
            <p class="description">{{ skill.description || '暂无描述' }}</p>
          </div>
          <div class="actions">
            <button class="icon-btn" :title="skill.active ? '停用技能' : '启用技能'" @click="handleToggleActive(skill)">
              <ToggleRight v-if="skill.active" :size="22" class="toggle-icon active" />
              <ToggleLeft v-else :size="22" class="toggle-icon" />
            </button>
          </div>
        </div>

        <div class="card-body">
          <div class="details-list">
            <div class="info-row" v-if="skill.path">
              <span class="label">来源路径</span>
              <span class="value font-mono text-truncate" :title="skill.path">{{ skill.path }}</span>
            </div>
            <div class="status-row">
              <div class="status-indicator-item" :class="{ ok: skill.active }">
                <CheckCircle v-if="skill.active" :size="14" class="status-icon" />
                <AlertTriangle v-else :size="14" class="status-icon" />
                <span>{{ skill.active ? '已激活 - Agent 可见' : '已停用 - 对 Agent 隐藏' }}</span>
              </div>
              <div class="status-indicator-item ok" v-if="skill.localExists">
                <FolderOpen :size="14" class="status-icon" />
                <span>本地目录存在</span>
              </div>
            </div>
          </div>
        </div>

        <div class="card-footer">
          <button class="btn sm" @click="openFileBrowser(skill)" title="浏览文件">
            <Eye :size="14" /> 浏览
          </button>
          <button class="btn sm" @click="handleDownload(skill)" title="下载 ZIP">
            <Download :size="14" /> 下载
          </button>
          <button v-if="!skill.readonly" class="btn sm danger" @click="confirmDelete(skill)" title="删除">
            <Trash2 :size="14" /> 删除
          </button>
        </div>
      </div>

      <!-- Empty State -->
      <div v-if="skills.length === 0 && !loading" class="no-data-card">
        <FileText :size="48" class="empty-icon" />
        <h3>暂无已注册的技能</h3>
        <p>在 <code>data/skills/</code> 目录下创建包含 <code>skill.md</code> 或 <code>manifest.json</code> 的子目录来定义技能，或使用下方按钮手动注册或批量上传 ZIP 包。</p>
        <div class="format-hints">
          <div class="format-hint">
            <strong>skill.md</strong>
            <code># 技能名
---
name: my-skill
description: 描述
---</code>
          </div>
          <div class="format-hint">
            <strong>manifest.json</strong>
            <code>{"name":"my-skill","description":"描述"}</code>
          </div>
          <div class="format-hint">
            <strong>skills.md</strong>
            <code>- skill-name: 技能描述文本</code>
          </div>
        </div>
        <div class="empty-actions">
          <button class="btn primary" @click="showUploadPanel = true"><Upload :size="16" /> 上传 ZIP 包</button>
          <button class="btn" @click="openRegisterDialog"><Plus :size="16" /> 手动注册</button>
        </div>
      </div>

      <div v-if="filteredSkills.length === 0 && skills.length > 0" class="no-data-card">
        <Search :size="48" class="empty-icon" />
        <h3>未找到匹配的技能</h3>
        <p>尝试使用不同的关键词搜索。</p>
      </div>
    </div>

    <!-- Register Dialog -->
    <Teleport to="body">
      <div v-if="showRegisterDialog" class="modal-backdrop" @click.self="showRegisterDialog = false">
        <div class="modal-content">
          <div class="modal-header">
            <h3>注册新技能</h3>
            <button class="close-btn" @click="showRegisterDialog = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>技能标识名 <span class="required">*</span></label>
              <input type="text" v-model="registerForm.name" placeholder="例如: code-review, debugging" class="form-control" />
              <span class="help-text">唯一标识符，将出现在 Agent 的系统提示中。建议使用 kebab-case 命名。</span>
            </div>
            <div class="form-group">
              <label>技能描述</label>
              <textarea v-model="registerForm.description" placeholder="例如: 审查代码质量、安全性及性能问题..." rows="3" class="form-control"></textarea>
              <span class="help-text">向 LLM 声明的技能功能说明。Agent 将根据此描述判断何时使用该技能。</span>
            </div>
            <div class="form-group">
              <label>来源路径</label>
              <input type="text" v-model="registerForm.path" placeholder="可选" class="form-control font-mono" />
              <span class="help-text">可选。标记技能的物理来源路径，用于调试和溯源。</span>
            </div>
            <div class="form-row-2">
              <div class="form-group">
                <label>激活状态</label>
                <select v-model="registerForm.active" class="form-control">
                  <option :value="true">启用 - Agent 可见</option>
                  <option :value="false">停用 - Agent 隐藏</option>
                </select>
              </div>
              <div class="form-group">
                <label>来源类型</label>
                <select v-model="registerForm.sourceType" class="form-control" @change="onSourceTypeChange">
                  <option v-for="opt in sourceTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showRegisterDialog = false">取消</button>
            <button class="btn primary" @click="handleRegister">注册技能</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Confirm Dialog -->
    <Teleport to="body">
      <div v-if="showDeleteDialog" class="modal-backdrop" @click.self="showDeleteDialog = false">
        <div class="modal-content modal-sm">
          <div class="modal-header">
            <h3>确认删除</h3>
            <button class="close-btn" @click="showDeleteDialog = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="confirm-content">
              <AlertTriangle :size="32" class="confirm-icon danger" />
              <p>确定要删除技能 <strong>"{{ deleteTarget?.name }}"</strong> 吗？</p>
              <span class="help-text">删除后 Agent 将不再感知该技能，此操作不可撤销。</span>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showDeleteDialog = false">取消</button>
            <button class="btn danger" @click="handleDelete">确认删除</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Upload ZIP Dialog -->
    <Teleport to="body">
      <div v-if="showUploadPanel" class="modal-backdrop" @click.self="closeUploadPanel">
        <div class="modal-content modal-upload">
          <div class="modal-header">
            <h3><FileArchive :size="18" class="accent" /> 批量上传 ZIP 技能包</h3>
            <button class="close-btn" @click="closeUploadPanel"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <p class="upload-desc">拖拽或选择 .zip 文件，系统自动解析目录结构并校验 SKILL.md</p>

            <!-- Drop Zone -->
            <div
              class="drop-zone"
              :class="{ dragging: isDragging, disabled: isUploading }"
              @dragover.prevent="onDragOver"
              @dragleave.prevent="onDragLeave"
              @drop.prevent="onDrop"
              @click="fileInputRef?.click()"
            >
              <input ref="fileInputRef" type="file" accept=".zip" multiple hidden @change="onFileInputChange" />
              <template v-if="!isUploading">
                <ArrowUpFromLine :size="40" class="drop-icon" :class="{ active: isDragging }" />
                <p class="drop-text">将 ZIP 文件拖放到此处，或点击选择文件</p>
                <p class="drop-hint">支持同时上传多个 .zip 文件，每个压缩包可包含多个技能文件夹</p>
              </template>
              <template v-else>
                <div class="spinner"></div>
                <p class="drop-text">正在解析并注册技能...</p>
              </template>
            </div>

            <!-- Selected Files -->
            <div v-if="selectedFiles.length > 0" class="file-list-section">
              <div class="section-header">
                <strong>已选文件 ({{ selectedFiles.length }})</strong>
                <button class="btn-text danger" @click="clearAllFiles">清空全部</button>
              </div>
              <div class="file-list">
                <div v-for="(file, idx) in selectedFiles" :key="idx + file.name" class="file-item">
                  <FileArchive :size="18" class="file-icon" />
                  <span class="file-name">{{ file.name }}</span>
                  <span class="file-size">{{ formatFileSize(file.size) }}</span>
                  <button class="icon-btn sm" @click="removeFile(idx)" title="移除"><XCircle :size="16" /></button>
                </div>
              </div>
              <div class="upload-actions">
                <button class="btn primary" @click="handleUpload" :disabled="isUploading || selectedFiles.length === 0">
                  <Upload :size="16" /> {{ isUploading ? '处理中...' : `开始上传 (${selectedFiles.length} 个文件)` }}
                </button>
              </div>
            </div>

            <!-- Error -->
            <div v-if="uploadError" class="alert error">{{ uploadError }}</div>

            <!-- Results -->
            <div v-if="uploadResults.length > 0" class="results-section">
              <div class="results-header">
                <h3>上传结果</h3>
                <div class="summary-badges">
                  <span v-if="uploadSummary.registered > 0" class="badge success">
                    <CheckCircle :size="13" class="badge-icon" /> +{{ uploadSummary.registered }} 注册成功
                  </span>
                  <span v-if="uploadSummary.skipped > 0" class="badge warning">
                    <AlertTriangle :size="13" class="badge-icon" /> {{ uploadSummary.skipped }} 跳过重复
                  </span>
                  <span v-if="uploadSummary.errors > 0" class="badge error">
                    <XCircle :size="13" class="badge-icon" /> {{ uploadSummary.errors }} 校验失败
                  </span>
                </div>
              </div>
              <div v-for="result in uploadResults" :key="result.zipFile" class="result-group">
                <div class="result-zip-name">
                  <FileArchive :size="16" class="accent" /> {{ result.zipFile }}
                </div>
                <div class="result-items">
                  <div
                    v-for="skill in result.skills"
                    :key="skill.name + skill.status"
                    class="result-item"
                    :class="{ [skill.status]: true }"
                  >
                    <component
                      :is="skill.status === 'registered' ? CheckCircle : skill.status === 'skipped_duplicate' ? AlertTriangle : XCircle"
                      :size="17"
                      class="result-status-icon"
                    />
                    <div class="result-info">
                      <span class="result-name">{{ skill.name }}</span>
                      <span class="result-msg">{{ skill.message }}</span>
                    </div>
                    <span :class="['result-badge', skill.status]">
                      {{ skill.status === 'registered' ? '已注册' : skill.status === 'skipped_duplicate' ? '已跳过' : '错误' }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- File Browser Dialog -->
    <Teleport to="body">
      <div v-if="showFileBrowser" class="modal-backdrop" @click.self="showFileBrowser = false">
        <div class="modal-content modal-lg">
          <div class="modal-header">
            <h3><FolderOpen :size="18" class="accent" /> 文件浏览 - {{ browserSkillName }}</h3>
            <button class="close-btn" @click="showFileBrowser = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <!-- Breadcrumb -->
            <div class="breadcrumb">
              <button
                v-for="(item, idx) in browserPathStack"
                :key="idx"
                class="breadcrumb-item"
                :class="{ current: idx === browserPathStack.length - 1 }"
                @click="navigateToBreadcrumb(idx)"
              >
                <ChevronRight v-if="idx > 0" :size="12" class="breadcrumb-sep" />
                {{ item.name }}
              </button>
            </div>

            <!-- Loading -->
            <div v-if="browserLoading" class="loading-state compact">
              <div class="spinner"></div>
              <p>加载中...</p>
            </div>

            <!-- File List -->
            <div v-else-if="browserFiles.length > 0" class="browser-file-list">
              <div
                v-for="entry in browserFiles"
                :key="entry.path"
                class="browser-file-item"
                @click="entry.is_dir ? navigateToFolder(entry) : openFileViewer(entry)"
              >
                <component :is="entry.is_dir ? Folder : File" :size="18" class="browser-file-icon" :class="{ folder: entry.is_dir }" />
                <span class="browser-file-name">{{ entry.name }}</span>
                <span v-if="entry.size" class="browser-file-size">{{ formatFileSize(entry.size) }}</span>
                <ChevronRight v-if="entry.is_dir" :size="14" class="browser-chevron" />
              </div>
            </div>

            <div v-else class="browser-empty">
              <FolderOpen :size="32" class="empty-icon" />
              <p>此目录为空</p>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- File Viewer/Editor Dialog -->
    <Teleport to="body">
      <div v-if="showFileViewer" class="modal-backdrop" @click.self="closeFileViewer">
        <div class="modal-content modal-lg">
          <div class="modal-header">
            <h3><FileText :size="18" class="accent" /> {{ viewerFileName }}</h3>
            <button class="close-btn" @click="closeFileViewer"><X :size="20" /></button>
          </div>
          <div class="modal-body viewer-body">
            <div v-if="viewerLoading" class="loading-state compact">
              <div class="spinner"></div>
              <p>加载中...</p>
            </div>
            <textarea
              v-else
              v-model="viewerContent"
              class="file-editor"
              :readonly="viewerIsReadonly"
              spellcheck="false"
            ></textarea>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="closeFileViewer">关闭</button>
            <button class="btn primary" :disabled="viewerSaving" @click="saveFileContent">
              <RefreshCw v-if="viewerSaving" :size="14" class="animate-spin" />
              <Save v-else :size="14" />
              {{ viewerSaving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Toast -->
    <Teleport to="body">
      <div v-if="toast.show" :class="['toast', toast.color]">{{ toast.message }}</div>
    </Teleport>
  </div>
</template>

<style scoped>
.skill-page { max-width: 1600px; margin: 0 auto; }

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  gap: 1rem;
}

@media (max-width: 768px) {
  .page-header { flex-direction: column; align-items: stretch; }
}

.page-header h1 {
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
}

.page-header p {
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

/* Toolbar */
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  gap: 1rem;
  flex-wrap: wrap;
}

.stats-bar {
  padding: 0.6rem 1rem;
  background: rgba(99,102,241,.08);
  border: 1px solid rgba(99,102,241,.15);
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.stats-bar strong { color: var(--accent-primary); font-weight: 700; }

.stat-icon { color: var(--text-muted); }
.stat-icon.active { color: var(--accent-primary); }

.search-box {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-box .form-control { padding-left: 32px; }

/* Loading */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 0;
  gap: 1rem;
  color: var(--text-secondary);
}

.loading-state.compact { padding: 2rem 0; }

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255,255,255,.1);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin .8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }
.animate-spin { animation: spin 1s linear infinite; }

/* Grid */
.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 1.25rem;
}

@media (max-width: 480px) {
  .skills-grid { grid-template-columns: 1fr; }
}

/* Card */
.skill-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  transition: all .2s ease-in-out;
  backdrop-filter: var(--glass-blur);
  overflow: hidden;
}

.skill-card:hover {
  border-color: var(--border-color-hover);
  transform: translateY(-2px);
  background: var(--bg-card-hover);
}

.skill-card.inactive { opacity: .6; }

.card-header {
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.title-info { flex-grow: 1; min-width: 0; }

.name-row {
  display: flex;
  align-items: center;
  gap: .5rem;
  margin-bottom: .35rem;
  flex-wrap: wrap;
}

.name-row h3 {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}

.accent { color: var(--accent-primary); flex-shrink: 0; }

.source-tag {
  font-size: .7rem;
  padding: .15rem .45rem;
  border-radius: 4px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.source-tag.local { background: rgba(16,185,129,.1); color: var(--accent-success); border: 1px solid rgba(16,185,129,.2); }
.source-tag.plugin { background: rgba(245,158,11,.1); color: var(--accent-warning); border: 1px solid rgba(245,158,11,.2); }
.source-tag.manual { background: rgba(99,102,241,.1); color: #818CF8; border: 1px solid rgba(99,102,241,.2); }
.source-tag.upload { background: rgba(34,197,94,.1); color: #22C55E; border: 1px solid rgba(34,197,94,.2); }
.source-tag.readonly { background: rgba(148,163,184,.1); color: #94A3B8; border: 1px solid rgba(148,163,184,.2); }

.description {
  font-size: .85rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-top: .35rem;
}

.card-body {
  padding: 1.25rem;
  flex-grow: 1;
}

.details-list { display: flex; flex-direction: column; gap: .85rem; }

.info-row { display: flex; flex-direction: column; gap: .25rem; }
.info-row .label { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
.info-row .value { font-size: .85rem; color: var(--text-primary); }

.status-row { display: flex; gap: 1.25rem; flex-wrap: wrap; margin-top: .25rem; }

.status-indicator-item {
  display: flex;
  align-items: center;
  gap: .35rem;
  font-size: .78rem;
  color: var(--text-muted);
}

.status-indicator-item.ok { color: var(--accent-success); }
.status-indicator-item:not(.ok) { color: #F59E0B; }

.toggle-icon { color: var(--text-muted); transition: color .15s ease; }
.toggle-icon.active { color: var(--accent-success); }

.card-footer {
  padding: .75rem 1.25rem;
  border-top: 1px solid var(--border-color);
  display: flex;
  gap: .5rem;
  flex-wrap: wrap;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .4rem;
  padding: .5rem 1rem;
  font-size: .9rem;
  font-weight: 500;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: all .15s ease-in-out;
  background: rgba(255,255,255,.05);
  color: var(--text-primary);
}

.btn:hover { background: rgba(255,255,255,.1); border-color: var(--border-color-hover); }
.btn.primary { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
.btn.primary:hover { background: var(--accent-primary-hover); }
.btn.primary-outline { background: transparent; border-color: var(--accent-primary); color: var(--accent-primary); }
.btn.primary-outline:hover { background: rgba(99,102,241,.1); }
.btn.danger { background: rgba(239,68,68,.12); border-color: rgba(239,68,68,.25); color: #FB7185; }
.btn.danger:hover { background: rgba(239,68,68,.2); border-color: rgba(239,68,68,.4); }
.btn.sm { padding: .35rem .75rem; font-size: .8rem; border-radius: 6px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }

.icon-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: .4rem;
  border-radius: 6px;
  transition: all .15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.icon-btn.sm { padding: .15rem; }
.icon-btn:hover { background: rgba(255,255,255,.05); color: var(--text-primary); }
.icon-btn.danger:hover { background: rgba(239,68,68,.15); border-color: rgba(239,68,68,.2); color: #FB7185; }

.btn-text {
  background: none;
  border: none;
  cursor: pointer;
  font-size: .8rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.btn-text:hover { color: #EF4444; }
.btn-text.danger { color: #EF4444; }

/* Modal */
.modal-backdrop {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  background: rgba(0,0,0,.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}

.modal-content {
  background: var(--bg-modal);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  width: 100%;
  max-width: 560px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: modalEnter .2s cubic-bezier(.16,1,.3,1) forwards;
}

.modal-content.modal-sm { max-width: 420px; }
.modal-content.modal-upload { max-width: 640px; }
.modal-content.modal-lg { max-width: 800px; }

@keyframes modalEnter {
  from { opacity: 0; transform: scale(.95) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: .5rem;
}

.close-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 6px;
  transition: all .15s;
}

.close-btn:hover { background: rgba(255,255,255,.05); color: var(--text-primary); }

.modal-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  max-height: 70vh;
  overflow-y: auto;
}

.modal-footer {
  padding: 1.25rem;
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: flex-end;
  gap: .75rem;
}

/* Form */
.form-group { display: flex; flex-direction: column; gap: .4rem; }
.form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
@media (max-width: 600px) { .form-row-2 { grid-template-columns: 1fr; } }

.form-group label { font-size: .9rem; font-weight: 600; color: var(--text-primary); }
.required { color: #EF4444; }

.form-control {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: .65rem .85rem;
  border-radius: 6px;
  font-size: .9rem;
  transition: all .2s ease;
  width: 100%;
  outline: none;
}

.form-control:focus { border-color: var(--accent-primary); box-shadow: 0 0 0 2px rgba(99,102,241,.2); }
.form-control.sm { font-size: .82rem; padding: .4rem .6rem; }
textarea.form-control { resize: vertical; min-height: 80px; }

select.form-control {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
  background-repeat: no-repeat;
  background-position: right .8rem center;
  background-size: 1rem;
  padding-right: 2.5rem;
}

.help-text { font-size: .8rem; color: var(--text-muted); line-height: 1.4; }
.font-mono { font-family: ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace; }
.text-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Confirm Dialog */
.confirm-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: .75rem;
}

.confirm-icon.danger { color: #F59E0B; }
.confirm-content p { font-size: .95rem; color: var(--text-primary); }
.confirm-content strong { color: var(--accent-primary); }

/* Upload */
.upload-desc { font-size: .85rem; color: var(--text-secondary); margin-bottom: .25rem; }

.drop-zone {
  border: 2px dashed var(--border-color);
  border-radius: 12px;
  padding: 3rem 2rem;
  text-align: center;
  cursor: pointer;
  transition: all .25s ease;
  background: rgba(99,102,241,.02);
}

.drop-zone:hover { border-color: var(--accent-primary); background: rgba(99,102,241,.06); }
.drop-zone.dragging { border-color: var(--accent-primary); background: rgba(99,102,241,.1); transform: scale(1.005); box-shadow: 0 0 30px rgba(99,102,241,.15); }
.drop-zone.disabled { opacity: .5; pointer-events: none; }

.drop-icon { color: var(--text-muted); transition: transform .25s ease; }
.drop-icon.active { color: var(--accent-primary); transform: translateY(-4px) scale(1.1); }
.drop-text { font-size: 1rem; font-weight: 500; color: var(--text-primary); margin-top: .75rem; }
.drop-hint { font-size: .82rem; color: var(--text-muted); margin-top: .35rem; }

.file-list-section { margin-top: 1.5rem; }
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: .75rem; font-size: .9rem; color: var(--text-primary); }
.file-list { display: flex; flex-direction: column; gap: .4rem; }

.file-item {
  display: flex;
  align-items: center;
  gap: .65rem;
  padding: .55rem .85rem;
  background: rgba(255,255,255,.03);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.file-icon { color: var(--accent-primary); flex-shrink: 0; }
.file-name { flex-grow: 1; font-size: .88rem; color: var(--text-primary); font-family: ui-monospace,SFMono-Regular,monospace; }
.file-size { font-size: .78rem; color: var(--text-muted); flex-shrink: 0; }
.upload-actions { margin-top: 1rem; display: flex; justify-content: flex-end; }

.alert { padding: .7rem 1rem; border-radius: 8px; font-size: .88rem; }
.alert.error { background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.2); color: #FCA5A5; }

.results-section { margin-top: 1.5rem; }
.results-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: .5rem; }
.results-header h3 { font-size: 1rem; font-weight: 600; color: var(--text-primary); }
.summary-badges { display: flex; gap: .5rem; flex-wrap: wrap; }

.badge {
  display: inline-flex;
  align-items: center;
  gap: .3rem;
  font-size: .78rem;
  font-weight: 600;
  padding: .25rem .65rem;
  border-radius: 20px;
}

.badge.success { background: rgba(16,185,129,.1); color: var(--accent-success); border: 1px solid rgba(16,185,129,.2); }
.badge.warning { background: rgba(245,158,11,.1); color: var(--accent-warning); border: 1px solid rgba(245,158,11,.2); }
.badge.error { background: rgba(239,68,68,.1); color: #FB7185; border: 1px solid rgba(239,68,68,.2); }
.badge-icon { flex-shrink: 0; }

.result-group { margin-bottom: 1rem; }
.result-zip-name { font-size: .88rem; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: .4rem; margin-bottom: .5rem; padding-left: .25rem; }
.result-items { display: flex; flex-direction: column; gap: .35rem; }

.result-item {
  display: flex;
  align-items: center;
  gap: .65rem;
  padding: .6rem .85rem;
  border-radius: 8px;
  border: 1px solid transparent;
  transition: background .15s ease;
}

.result-item.registered { background: rgba(16,185,129,.04); border-color: rgba(16,185,129,.12); }
.result-item.skipped_duplicate { background: rgba(245,158,11,.04); border-color: rgba(245,158,11,.12); }
.result-item.error { background: rgba(239,68,68,.04); border-color: rgba(239,68,68,.12); }

.result-status-icon { flex-shrink: 0; }
.result-item.registered .result-status-icon { color: var(--accent-success); }
.result-item.skipped_duplicate .result-status-icon { color: var(--accent-warning); }
.result-item.error .result-status-icon { color: #EF4444; }

.result-info { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
.result-name { font-size: .87rem; font-weight: 600; color: var(--text-primary); }
.result-msg { font-size: .78rem; color: var(--text-muted); }

.result-badge { font-size: .7rem; font-weight: 600; padding: .15rem .5rem; border-radius: 4px; flex-shrink: 0; white-space: nowrap; }
.result-badge.registered { background: rgba(16,185,129,.15); color: var(--accent-success); }
.result-badge.skipped_duplicate { background: rgba(245,158,11,.15); color: var(--accent-warning); }
.result-badge.error { background: rgba(239,68,68,.15); color: #EF4444; }

/* File Browser */
.breadcrumb {
  display: flex;
  align-items: center;
  gap: .25rem;
  flex-wrap: wrap;
  padding: .5rem .75rem;
  background: rgba(255,255,255,.03);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: .85rem;
}

.breadcrumb-item {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: .2rem .35rem;
  border-radius: 4px;
  transition: all .15s;
  display: inline-flex;
  align-items: center;
  gap: .25rem;
  font-size: .85rem;
}

.breadcrumb-item:hover { color: var(--accent-primary); background: rgba(99,102,241,.08); }
.breadcrumb-item.current { color: var(--text-primary); font-weight: 600; cursor: default; }
.breadcrumb-item.current:hover { background: transparent; }
.breadcrumb-sep { color: var(--text-muted); }

.browser-file-list { display: flex; flex-direction: column; gap: .25rem; }

.browser-file-item {
  display: flex;
  align-items: center;
  gap: .65rem;
  padding: .6rem .85rem;
  border-radius: 8px;
  cursor: pointer;
  transition: all .15s ease;
  border: 1px solid transparent;
}

.browser-file-item:hover { background: rgba(99,102,241,.06); border-color: rgba(99,102,241,.12); }

.browser-file-icon { flex-shrink: 0; color: var(--text-muted); }
.browser-file-icon.folder { color: var(--accent-primary); }
.browser-file-name { flex-grow: 1; font-size: .88rem; color: var(--text-primary); }
.browser-file-size { font-size: .78rem; color: var(--text-muted); }
.browser-chevron { color: var(--text-muted); }

.browser-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  gap: .75rem;
  color: var(--text-muted);
}

.empty-icon { opacity: .4; }

/* File Viewer */
.viewer-body { padding: 0 !important; }

.file-editor {
  width: 100%;
  min-height: 400px;
  max-height: 60vh;
  background: var(--bg-input);
  color: var(--text-primary);
  border: none;
  padding: 1.25rem;
  font-family: ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;
  font-size: .85rem;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  tab-size: 2;
}

.file-editor:focus { box-shadow: inset 0 0 0 1px var(--accent-primary); }

/* No Data */
.no-data-card {
  grid-column: 1/-1;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 3.5rem 2rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  backdrop-filter: var(--glass-blur);
}

.no-data-card h3 { font-size: 1.2rem; font-weight: 600; color: var(--text-primary); }
.no-data-card p { color: var(--text-secondary); font-size: .9rem; max-width: 520px; line-height: 1.6; margin-bottom: .25rem; }
.no-data-card code { background: rgba(99,102,241,.12); color: #818CF8; padding: .1rem .35rem; border-radius: 4px; font-size: .82rem; font-family: ui-monospace,SFMono-Regular,monospace; }

.format-hints { display: flex; gap: 1rem; flex-wrap: wrap; justify-content: center; margin: .5rem 0; }
.format-hint { background: rgba(255,255,255,.03); border: 1px solid var(--border-color); border-radius: 8px; padding: .7rem 1rem; text-align: left; max-width: 220px; }
.format-hint strong { display: block; font-size: .8rem; color: var(--text-primary); margin-bottom: .35rem; }
.format-hint code { display: block; font-size: .72rem; color: var(--text-muted); line-height: 1.5; white-space: pre-wrap; word-break: break-all; background: transparent; padding: 0; border: none; font-family: ui-monospace,SFMono-Regular,monospace; }
.empty-actions { display: flex; gap: .75rem; justify-content: center; margin-top: .25rem; }

/* Toast */
.toast {
  position: fixed;
  top: 20px;
  right: 20px;
  padding: 12px 20px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  z-index: 9999;
  animation: toastIn .2s ease-out;
  max-width: 400px;
}

.toast.success { background: rgba(16,185,129,.15); border: 1px solid rgba(16,185,129,.3); color: var(--accent-success); }
.toast.error { background: rgba(239,68,68,.15); border: 1px solid rgba(239,68,68,.3); color: #FB7185; }
.toast.info { background: rgba(99,102,241,.15); border: 1px solid rgba(99,102,241,.3); color: var(--accent-primary); }

@keyframes toastIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
