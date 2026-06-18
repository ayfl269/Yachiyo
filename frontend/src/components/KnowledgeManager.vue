<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  Plus, X, Trash2, BookOpen, FileText, ChevronLeft, ChevronRight,
  Upload, Clock, Layers, Search, Settings, Info, Database,
  Save, Hash, SlidersHorizontal, CheckCircle, AlertCircle
} from 'lucide-vue-next'

// ===== Types =====
interface KnowledgeBase {
  id: string
  name: string
  description: string
  emoji: string
  embeddingProviderId: string
  rerankProviderId: string | null
  chunkSize: number
  chunkOverlap: number
  topKDense: number
  topKSparse: number
  topMFinal: number
}

interface KBDocument {
  id: string
  kbId: string
  name: string
  url: string | null
  type: string
  createdAt: number
  chunkCount: number
}

interface Provider {
  id: string
  type: string
  provider_type: string
  provider: string
}

interface RetrieveResult {
  content: string
  score: number
  metadata?: Record<string, any>
}

// ===== Emoji Picker =====
const EMOJI_LIST = [
  '📚', '📖', '📝', '📋', '🗂️', '📁', '💾', '🗄️',
  '🧠', '💡', '🔬', '🎯', '🚀', '⚙️', '🔧', '🛠️',
  '🏢', '🏠', '💻', '📱', '🌐', '🔒', '🔑', '📊',
  '📈', '📉', '🗂️', '📰', '📑', '📄', '📃', '📜',
  '🎓', '🏫', '🧪', '💊', '🏥', '🏦', '💰', '🏷️',
  '🤖', '🧩', '🎨', '🎵', '🌍', '✈️', '🚗', '⚡'
]

// ===== State =====
const kbs = ref<KnowledgeBase[]>([])
const providersList = ref<Provider[]>([])
const loading = ref(true)

const selectedKb = ref<KnowledgeBase | null>(null)
const selectedKbDetail = ref<KnowledgeBase | null>(null)
const documents = ref<KBDocument[]>([])
const loadingDocs = ref(false)
const detailTab = ref<'overview' | 'documents' | 'retrieve' | 'settings'>('overview')

// Create KB dialog
const showModal = ref(false)
const isNewKb = ref(false)
const editingKb = ref<{
  name: string
  description: string
  emoji: string
  embeddingProviderId: string
  rerankProviderId: string
  chunkSize: number
  chunkOverlap: number
  topKDense: number
  topKSparse: number
  topMFinal: number
} | null>(null)
const showEmojiPicker = ref(false)
const savingKb = ref(false)

// Delete confirm dialog
const showDeleteConfirm = ref(false)
const deleteTarget = ref<{ id: string; name: string } | null>(null)

// Document upload
const uploadingDoc = ref(false)
const docForm = ref({ name: '', content: '' })

// Retrieve
const retrieveQuery = ref('')
const retrieveTopK = ref(5)
const retrieving = ref(false)
const retrieveResults = ref<RetrieveResult[]>([])

// Settings saving
const savingSettings = ref(false)

// Toast
const toast = ref({ show: false, message: '', color: 'success' })
let toastTimer: number | null = null

function showMessage(message: string, color = 'success') {
  toast.value = { show: true, message, color }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value.show = false }, 3000)
}

// ===== Computed =====
const embeddingProviders = computed(() =>
  providersList.value.filter(p => p.provider_type === 'embedding')
)

const rerankProviders = computed(() =>
  providersList.value.filter(p => p.provider_type === 'rerank')
)

// ===== API =====
async function fetchKbs() {
  loading.value = true
  try {
    const res = await fetch('/api/kb/list')
    if (res.ok) {
      kbs.value = await res.json()
    }
  } catch (error) {
    console.error('获取知识库列表失败:', error)
    showMessage('获取知识库列表失败', 'error')
  } finally {
    loading.value = false
  }
}

async function fetchProviders() {
  try {
    const res = await fetch('/api/config/provider/list?provider_type=embedding,rerank')
    if (res.ok) {
      const data = await res.json()
      providersList.value = Array.isArray(data) ? data : (data.providers || [])
    }
  } catch (error) {
    console.error('获取提供商列表失败:', error)
  }
}

async function fetchKbDetail(kbId: string) {
  try {
    const res = await fetch(`/api/kb/get?kb_id=${encodeURIComponent(kbId)}`)
    if (res.ok) {
      selectedKbDetail.value = await res.json()
    }
  } catch (error) {
    console.error('获取知识库详情失败:', error)
  }
}

async function fetchDocuments() {
  if (!selectedKb.value) return
  loadingDocs.value = true
  try {
    const res = await fetch(`/api/kb/document/list?kb_id=${encodeURIComponent(selectedKb.value.id)}`)
    if (res.ok) {
      documents.value = await res.json()
    }
  } catch (error) {
    console.error('获取文档列表失败:', error)
  } finally {
    loadingDocs.value = false
  }
}

// ===== Actions =====
function handleCreateKb() {
  isNewKb.value = true
  editingKb.value = {
    name: '',
    description: '',
    emoji: '📚',
    embeddingProviderId: embeddingProviders.value[0]?.id || '',
    rerankProviderId: '',
    chunkSize: 500,
    chunkOverlap: 50,
    topKDense: 10,
    topKSparse: 10,
    topMFinal: 5
  }
  showModal.value = true
}

/*
function handleEditSettings() {
  if (!selectedKbDetail.value) return
  isNewKb.value = false
  editingKb.value = {
    name: selectedKbDetail.value.name,
    description: selectedKbDetail.value.description,
    emoji: selectedKbDetail.value.emoji,
    embeddingProviderId: selectedKbDetail.value.embeddingProviderId,
    rerankProviderId: selectedKbDetail.value.rerankProviderId || '',
    chunkSize: selectedKbDetail.value.chunkSize,
    chunkOverlap: selectedKbDetail.value.chunkOverlap,
    topKDense: selectedKbDetail.value.topKDense,
    topKSparse: selectedKbDetail.value.topKSparse,
    topMFinal: selectedKbDetail.value.topMFinal
  }
  showModal.value = true
}
*/

async function handleSaveKb() {
  if (!editingKb.value) return
  if (!editingKb.value.name.trim()) {
    showMessage('知识库名称不能为空', 'error')
    return
  }
  if (!editingKb.value.embeddingProviderId) {
    showMessage('请选择嵌入模型提供商', 'error')
    return
  }

  savingKb.value = true
  try {
    const payload: Record<string, any> = {
      name: editingKb.value.name.trim(),
      description: editingKb.value.description.trim(),
      emoji: editingKb.value.emoji,
      embeddingProviderId: editingKb.value.embeddingProviderId,
      chunkSize: editingKb.value.chunkSize,
      chunkOverlap: editingKb.value.chunkOverlap,
      topKDense: editingKb.value.topKDense,
      topKSparse: editingKb.value.topKSparse,
      topMFinal: editingKb.value.topMFinal
    }
    if (editingKb.value.rerankProviderId) {
      payload.rerankProviderId = editingKb.value.rerankProviderId
    }

    let res: Response
    if (isNewKb.value) {
      res = await fetch('/api/kb/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
    } else {
      payload.kb_id = selectedKb.value!.id
      res = await fetch('/api/kb/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
    }

    if (res.ok) {
      showModal.value = false
      editingKb.value = null
      showMessage(isNewKb.value ? '知识库创建成功' : '知识库更新成功')
      await fetchKbs()
      if (!isNewKb.value && selectedKb.value) {
        await fetchKbDetail(selectedKb.value.id)
        selectedKb.value = selectedKbDetail.value
      }
    } else {
      const err = await res.json().catch(() => ({}))
      showMessage(err.message || '操作失败', 'error')
    }
  } catch (error) {
    console.error('保存知识库失败:', error)
    showMessage('保存知识库失败', 'error')
  } finally {
    savingKb.value = false
  }
}

function confirmDeleteKb(id: string, name: string) {
  deleteTarget.value = { id, name }
  showDeleteConfirm.value = true
}

async function handleDeleteKb() {
  if (!deleteTarget.value) return
  try {
    const res = await fetch('/api/kb/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kb_id: deleteTarget.value.id })
    })
    if (res.ok) {
      if (selectedKb.value?.id === deleteTarget.value.id) {
        selectedKb.value = null
        selectedKbDetail.value = null
      }
      showMessage('知识库已删除')
      await fetchKbs()
    } else {
      showMessage('删除失败', 'error')
    }
  } catch (error) {
    console.error('删除知识库失败:', error)
    showMessage('删除知识库失败', 'error')
  } finally {
    showDeleteConfirm.value = false
    deleteTarget.value = null
  }
}

async function selectKb(kb: KnowledgeBase) {
  selectedKb.value = kb
  detailTab.value = 'overview'
  retrieveResults.value = []
  await fetchKbDetail(kb.id)
  await fetchDocuments()
}

function goBack() {
  selectedKb.value = null
  selectedKbDetail.value = null
  documents.value = []
  retrieveResults.value = []
}

async function handleUploadDoc() {
  if (!selectedKb.value) return
  if (!docForm.value.name.trim()) {
    showMessage('文档标题不能为空', 'error')
    return
  }
  if (!docForm.value.content.trim()) {
    showMessage('文档内容不能为空', 'error')
    return
  }

  uploadingDoc.value = true
  try {
    const res = await fetch('/api/kb/document/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kb_id: selectedKb.value.id,
        doc_name: docForm.value.name.trim(),
        text: docForm.value.content.trim()
      })
    })
    if (res.ok) {
      docForm.value.name = ''
      docForm.value.content = ''
      showMessage('文档上传成功')
      await fetchDocuments()
      await fetchKbDetail(selectedKb.value.id)
    } else {
      const err = await res.json().catch(() => ({}))
      showMessage(err.message || '上传失败', 'error')
    }
  } catch (error) {
    console.error('上传文档失败:', error)
    showMessage('上传文档失败', 'error')
  } finally {
    uploadingDoc.value = false
  }
}

async function handleDeleteDoc(docId: string, docName: string) {
  if (!confirm(`确定要删除文档 "${docName}" 吗？`)) return
  try {
    const res = await fetch('/api/kb/document/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc_id: docId })
    })
    if (res.ok) {
      showMessage('文档已删除')
      await fetchDocuments()
      if (selectedKb.value) await fetchKbDetail(selectedKb.value.id)
    } else {
      showMessage('删除文档失败', 'error')
    }
  } catch (error) {
    console.error('删除文档失败:', error)
    showMessage('删除文档失败', 'error')
  }
}

async function handleRetrieve() {
  if (!selectedKb.value) return
  if (!retrieveQuery.value.trim()) {
    showMessage('请输入检索查询', 'error')
    return
  }

  retrieving.value = true
  retrieveResults.value = []
  try {
    const res = await fetch('/api/kb/retrieve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: retrieveQuery.value.trim(),
        kb_names: [selectedKb.value.name],
        top_k: retrieveTopK.value
      })
    })
    if (res.ok) {
      const data = await res.json()
      retrieveResults.value = Array.isArray(data) ? data : (data.results || [])
      if (retrieveResults.value.length === 0) {
        showMessage('未找到相关结果', 'info')
      }
    } else {
      showMessage('检索失败', 'error')
    }
  } catch (error) {
    console.error('检索失败:', error)
    showMessage('检索失败', 'error')
  } finally {
    retrieving.value = false
  }
}

async function handleSaveSettings() {
  if (!selectedKbDetail.value) return
  savingSettings.value = true
  try {
    const res = await fetch('/api/kb/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kb_id: selectedKbDetail.value.id,
        chunkSize: selectedKbDetail.value.chunkSize,
        chunkOverlap: selectedKbDetail.value.chunkOverlap,
        topKDense: selectedKbDetail.value.topKDense,
        topKSparse: selectedKbDetail.value.topKSparse,
        topMFinal: selectedKbDetail.value.topMFinal,
        rerankProviderId: selectedKbDetail.value.rerankProviderId || undefined
      })
    })
    if (res.ok) {
      showMessage('设置已保存')
      await fetchKbDetail(selectedKbDetail.value.id)
      selectedKb.value = selectedKbDetail.value
    } else {
      showMessage('保存设置失败', 'error')
    }
  } catch (error) {
    console.error('保存设置失败:', error)
    showMessage('保存设置失败', 'error')
  } finally {
    savingSettings.value = false
  }
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN')
}

function scoreColor(score: number): string {
  if (score >= 0.8) return '#10B981'
  if (score >= 0.6) return '#F59E0B'
  if (score >= 0.4) return '#F97316'
  return '#EF4444'
}

function scoreLabel(score: number): string {
  if (score >= 0.8) return '高相关'
  if (score >= 0.6) return '中相关'
  if (score >= 0.4) return '低相关'
  return '弱相关'
}

// ===== Lifecycle =====
onMounted(async () => {
  await Promise.all([fetchKbs(), fetchProviders()])
})
</script>

<template>
  <div class="kb-page animate-fade-in">
    <!-- ===== List View ===== -->
    <template v-if="!selectedKb">
      <div class="page-header">
        <div>
          <h1>知识库管理</h1>
          <p>基于检索增强生成 (RAG) 技术，支持创建独立的知识库、分块切片并持久化向量，让 Agent 能够搜索私有文件内容。</p>
        </div>
        <button class="btn primary" @click="handleCreateKb">
          <Plus :size="16" /> 新建知识库
        </button>
      </div>

      <!-- Loading -->
      <div v-if="loading && kbs.length === 0" class="loading-state">
        <div class="spinner"></div>
        <p>加载中...</p>
      </div>

      <!-- KB Grid -->
      <div v-else class="kbs-grid">
        <div v-for="kb in kbs" :key="kb.id" class="kb-card" @click="selectKb(kb)">
          <div class="card-header">
            <div class="title-section">
              <span class="emoji-avatar">{{ kb.emoji }}</span>
              <div class="title-text">
                <h3>{{ kb.name }}</h3>
                <p class="desc-text">{{ kb.description || '暂无描述信息' }}</p>
              </div>
            </div>
            <button class="icon-btn danger" title="删除" @click.stop="confirmDeleteKb(kb.id, kb.name)">
              <Trash2 :size="14" />
            </button>
          </div>

          <div class="card-body">
            <div class="stats-row">
              <div class="stat-item">
                <FileText :size="14" class="stat-icon" />
                <span class="stat-value">{{ (kb as any).doc_count ?? '-' }}</span>
                <span class="stat-label">文档</span>
              </div>
              <div class="stat-item">
                <Layers :size="14" class="stat-icon" />
                <span class="stat-value">{{ (kb as any).chunk_count ?? '-' }}</span>
                <span class="stat-label">分块</span>
              </div>
            </div>
            <div class="meta-tags">
              <span class="kb-badge">{{ kb.embeddingProviderId }}</span>
              <span v-if="kb.rerankProviderId" class="kb-badge rerank">{{ kb.rerankProviderId }}</span>
              <span class="kb-badge dim">切片 {{ kb.chunkSize }}</span>
              <span class="kb-badge dim">重叠 {{ kb.chunkOverlap }}</span>
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div v-if="kbs.length === 0" class="empty-state">
          <BookOpen :size="48" class="empty-icon" />
          <h3>没有知识库</h3>
          <p>创建一个知识库并选择合适的嵌入模型，即可向其上传文本并进行向量检索。</p>
          <button class="btn primary" @click="handleCreateKb">
            <Plus :size="16" /> 创建第一个知识库
          </button>
        </div>
      </div>
    </template>

    <!-- ===== Detail View ===== -->
    <template v-else>
      <!-- Breadcrumb -->
      <div class="breadcrumb">
        <button class="breadcrumb-btn" @click="goBack">
          <ChevronLeft :size="16" />
          <span>知识库列表</span>
        </button>
        <ChevronRight :size="14" class="breadcrumb-sep" />
        <span class="breadcrumb-current">{{ selectedKb.emoji }} {{ selectedKb.name }}</span>
      </div>

      <!-- KB Info Bar -->
      <div class="kb-info-bar">
        <span class="emoji-avatar lg">{{ selectedKb.emoji }}</span>
        <div class="kb-info-text">
          <h2>{{ selectedKb.name }}</h2>
          <p>{{ selectedKb.description || '暂无描述' }}</p>
        </div>
      </div>

      <!-- Detail Tabs -->
      <div class="tabs-container">
        <button :class="['tab-btn', { active: detailTab === 'overview' }]" @click="detailTab = 'overview'">
          <Info :size="14" /> 概览
        </button>
        <button :class="['tab-btn', { active: detailTab === 'documents' }]" @click="detailTab = 'documents'">
          <FileText :size="14" /> 文档
        </button>
        <button :class="['tab-btn', { active: detailTab === 'retrieve' }]" @click="detailTab = 'retrieve'">
          <Search :size="14" /> 检索
        </button>
        <button :class="['tab-btn', { active: detailTab === 'settings' }]" @click="detailTab = 'settings'">
          <Settings :size="14" /> 设置
        </button>
      </div>

      <!-- Tab: Overview -->
      <div v-if="detailTab === 'overview'" class="tab-panel">
        <div class="overview-grid">
          <div class="overview-card">
            <div class="overview-card-header">
              <Database :size="16" />
              <h3>基本信息</h3>
            </div>
            <div class="overview-card-body">
              <div class="info-row">
                <span class="info-label">知识库 ID</span>
                <span class="info-value font-mono">{{ selectedKbDetail?.id || selectedKb.id }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">名称</span>
                <span class="info-value">{{ selectedKbDetail?.name || selectedKb.name }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">描述</span>
                <span class="info-value">{{ selectedKbDetail?.description || selectedKb.description || '-' }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">嵌入模型</span>
                <span class="info-value font-mono">{{ selectedKbDetail?.embeddingProviderId || selectedKb.embeddingProviderId }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">重排序模型</span>
                <span class="info-value font-mono">{{ selectedKbDetail?.rerankProviderId || selectedKb.rerankProviderId || '未配置' }}</span>
              </div>
            </div>
          </div>

          <div class="overview-card">
            <div class="overview-card-header">
              <Layers :size="16" />
              <h3>统计信息</h3>
            </div>
            <div class="overview-card-body">
              <div class="info-row">
                <span class="info-label">文档数量</span>
                <span class="info-value">{{ documents.length }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">总分块数</span>
                <span class="info-value">{{ documents.reduce((sum, d) => sum + d.chunkCount, 0) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">分块大小</span>
                <span class="info-value">{{ selectedKbDetail?.chunkSize || selectedKb.chunkSize }} 字</span>
              </div>
              <div class="info-row">
                <span class="info-label">分块重叠</span>
                <span class="info-value">{{ selectedKbDetail?.chunkOverlap || selectedKb.chunkOverlap }} 字</span>
              </div>
              <div class="info-row">
                <span class="info-label">Dense Top-K</span>
                <span class="info-value">{{ selectedKbDetail?.topKDense || selectedKb.topKDense }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Sparse Top-K</span>
                <span class="info-value">{{ selectedKbDetail?.topKSparse || selectedKb.topKSparse }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Final Top-M</span>
                <span class="info-value">{{ selectedKbDetail?.topMFinal || selectedKb.topMFinal }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab: Documents -->
      <div v-if="detailTab === 'documents'" class="tab-panel">
        <div class="docs-layout">
          <!-- Document List -->
          <div class="docs-list-panel">
            <div class="panel-header">
              <h3><FileText :size="16" class="accent-icon" /> 已上传文档</h3>
              <span class="docs-count">{{ documents.length }} 个文档</span>
            </div>

            <div v-if="loadingDocs" class="panel-loading">
              <div class="spinner mini"></div>
              <span>加载中...</span>
            </div>

            <div v-else class="panel-body">
              <div v-for="doc in documents" :key="doc.id" class="doc-item">
                <div class="doc-info">
                  <div class="doc-title-row">
                    <FileText :size="14" class="doc-icon" />
                    <span class="doc-name" :title="doc.name">{{ doc.name }}</span>
                  </div>
                  <div class="doc-meta">
                    <span class="meta-tag"><Layers :size="12" /> {{ doc.chunkCount }} 分块</span>
                    <span class="meta-tag"><Clock :size="12" /> {{ formatDate(doc.createdAt) }}</span>
                  </div>
                </div>
                <button class="icon-btn danger" title="删除文档" @click="handleDeleteDoc(doc.id, doc.name)">
                  <Trash2 :size="14" />
                </button>
              </div>

              <div v-if="documents.length === 0" class="panel-empty">
                <FileText :size="36" class="empty-icon" />
                <p>暂无文档，请在右侧上传</p>
              </div>
            </div>
          </div>

          <!-- Upload Form -->
          <div class="docs-upload-panel">
            <div class="panel-header">
              <h3><Upload :size="16" class="accent-icon" /> 上传文本</h3>
            </div>
            <div class="panel-body">
              <div class="form-group">
                <label>文档标题</label>
                <input
                  type="text"
                  v-model="docForm.name"
                  placeholder="例如: 产品说明书_v2.txt"
                  class="form-control"
                  :disabled="uploadingDoc"
                />
              </div>
              <div class="form-group flex-grow">
                <label>文档内容</label>
                <textarea
                  v-model="docForm.content"
                  placeholder="在此粘贴你想录入的文本内容，系统将根据知识库的分块大小进行智能切片，并通过嵌入模型向量化存入数据库..."
                  class="form-control content-textarea"
                  :disabled="uploadingDoc"
                ></textarea>
              </div>
              <button
                class="btn primary w-full"
                :disabled="uploadingDoc || !docForm.name.trim() || !docForm.content.trim()"
                @click="handleUploadDoc"
              >
                <div v-if="uploadingDoc" class="btn-loading">
                  <div class="spinner mini white"></div>
                  <span>切片计算中...</span>
                </div>
                <template v-else>
                  <Upload :size="14" /> 生成向量切片并上传
                </template>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab: Retrieve -->
      <div v-if="detailTab === 'retrieve'" class="tab-panel">
        <div class="retrieve-panel">
          <div class="retrieve-form">
            <div class="form-group">
              <label>检索查询</label>
              <textarea
                v-model="retrieveQuery"
                placeholder="输入你想检索的内容..."
                class="form-control"
                rows="3"
                @keydown.ctrl.enter="handleRetrieve"
              ></textarea>
              <span class="help-text">按 Ctrl+Enter 快速检索</span>
            </div>
            <div class="retrieve-actions">
              <div class="form-group inline-group">
                <label>Top K</label>
                <input type="number" v-model.number="retrieveTopK" class="form-control sm" min="1" max="50" />
              </div>
              <button class="btn primary" :disabled="retrieving || !retrieveQuery.trim()" @click="handleRetrieve">
                <Search :size="14" />
                <span v-if="retrieving">检索中...</span>
                <span v-else>检索</span>
              </button>
            </div>
          </div>

          <!-- Retrieve Results -->
          <div v-if="retrieveResults.length > 0" class="retrieve-results">
            <div class="results-header">
              <h3>检索结果</h3>
              <span class="results-count">{{ retrieveResults.length }} 条</span>
            </div>
            <div class="results-list">
              <div v-for="(result, idx) in retrieveResults" :key="idx" class="result-item">
                <div class="result-header">
                  <span class="result-index">#{{ idx + 1 }}</span>
                  <span class="result-score" :style="{ color: scoreColor(result.score) }">
                    {{ (result.score * 100).toFixed(1) }}%
                  </span>
                  <span class="result-label" :style="{ color: scoreColor(result.score) }">
                    {{ scoreLabel(result.score) }}
                  </span>
                </div>
                <div class="result-content">{{ result.content }}</div>
              </div>
            </div>
          </div>

          <div v-else-if="!retrieving" class="panel-empty">
            <Search :size="36" class="empty-icon" />
            <p>输入查询内容进行知识库检索</p>
          </div>
        </div>
      </div>

      <!-- Tab: Settings -->
      <div v-if="detailTab === 'settings'" class="tab-panel">
        <div class="settings-panel" v-if="selectedKbDetail">
          <div class="settings-section">
            <div class="section-title"><SlidersHorizontal :size="16" /> 分块参数</div>
            <div class="form-grid">
              <div class="form-group">
                <label>分块大小 (Chunk Size)</label>
                <input type="number" v-model.number="selectedKbDetail.chunkSize" class="form-control" min="100" max="10000" />
                <span class="help-text">每个切片段落的最大字数限制</span>
              </div>
              <div class="form-group">
                <label>分块重叠 (Chunk Overlap)</label>
                <input type="number" v-model.number="selectedKbDetail.chunkOverlap" class="form-control" min="0" max="2000" />
                <span class="help-text">相邻切片首尾重叠重合字数</span>
              </div>
            </div>
          </div>

          <div class="config-divider"></div>

          <div class="settings-section">
            <div class="section-title"><Hash :size="16" /> 检索参数</div>
            <div class="form-grid">
              <div class="form-group">
                <label>Dense Top-K</label>
                <input type="number" v-model.number="selectedKbDetail.topKDense" class="form-control" min="1" max="100" />
                <span class="help-text">稠密向量检索返回数量</span>
              </div>
              <div class="form-group">
                <label>Sparse Top-K</label>
                <input type="number" v-model.number="selectedKbDetail.topKSparse" class="form-control" min="1" max="100" />
                <span class="help-text">稀疏向量检索返回数量</span>
              </div>
              <div class="form-group">
                <label>Final Top-M</label>
                <input type="number" v-model.number="selectedKbDetail.topMFinal" class="form-control" min="1" max="100" />
                <span class="help-text">最终返回给模型上下文的切片数量</span>
              </div>
              <div class="form-group">
                <label>重排序模型</label>
                <select v-model="selectedKbDetail.rerankProviderId" class="form-control">
                  <option :value="null">不使用</option>
                  <option v-for="p in rerankProviders" :key="p.id" :value="p.id">
                    {{ p.id }}
                  </option>
                </select>
                <span class="help-text">可选的重排序服务提供商</span>
              </div>
            </div>
          </div>

          <div class="settings-footer">
            <button class="btn primary" :disabled="savingSettings" @click="handleSaveSettings">
              <div v-if="savingSettings" class="btn-loading">
                <div class="spinner mini white"></div>
                <span>保存中...</span>
              </div>
              <template v-else>
                <Save :size="14" /> 保存设置
              </template>
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ===== Create/Edit KB Modal ===== -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-backdrop" @click="showModal = false">
        <div class="modal-content" @click.stop>
          <div class="modal-header">
            <h3>{{ isNewKb ? '新建知识库' : '编辑知识库' }}</h3>
            <button class="close-btn" @click="showModal = false"><X :size="20" /></button>
          </div>
          <div class="modal-body" v-if="editingKb">
            <!-- Emoji + Name -->
            <div class="form-row-2">
              <div class="form-group" style="max-width: 100px;">
                <label>图标</label>
                <div class="emoji-input-wrapper">
                  <button class="emoji-trigger" @click="showEmojiPicker = !showEmojiPicker">
                    {{ editingKb.emoji }}
                  </button>
                  <div v-if="showEmojiPicker" class="emoji-picker" @click.stop>
                    <button
                      v-for="emoji in EMOJI_LIST"
                      :key="emoji"
                      :class="['emoji-option', { active: editingKb.emoji === emoji }]"
                      @click="editingKb.emoji = emoji; showEmojiPicker = false"
                    >
                      {{ emoji }}
                    </button>
                  </div>
                </div>
              </div>
              <div class="form-group">
                <label>知识库名称 <span class="required">*</span></label>
                <input type="text" v-model="editingKb.name" placeholder="知识库名称" class="form-control" />
              </div>
            </div>

            <!-- Description -->
            <div class="form-group">
              <label>描述</label>
              <textarea v-model="editingKb.description" placeholder="描述" rows="2" class="form-control"></textarea>
            </div>

            <!-- Providers -->
            <div class="form-row-2">
              <div class="form-group">
                <label>嵌入模型 <span class="required">*</span></label>
                <select v-model="editingKb.embeddingProviderId" class="form-control">
                  <option value="" disabled>选择嵌入模型</option>
                  <option v-for="p in embeddingProviders" :key="p.id" :value="p.id">
                    {{ p.id }}
                  </option>
                  <option v-if="embeddingProviders.length === 0" value="" disabled>
                    (无可用嵌入模型)
                  </option>
                </select>
              </div>
              <div class="form-group">
                <label>重排序模型 <span class="muted">(可选)</span></label>
                <select v-model="editingKb.rerankProviderId" class="form-control">
                  <option value="">不使用</option>
                  <option v-for="p in rerankProviders" :key="p.id" :value="p.id">
                    {{ p.id }}
                  </option>
                </select>
              </div>
            </div>

            <!-- Chunk Settings -->
            <div class="form-row-2">
              <div class="form-group">
                <label>分块大小</label>
                <input type="number" v-model.number="editingKb.chunkSize" class="form-control" min="100" max="10000" />
                <span class="help-text">每个切片的最大字数</span>
              </div>
              <div class="form-group">
                <label>分块重叠</label>
                <input type="number" v-model.number="editingKb.chunkOverlap" class="form-control" min="0" max="2000" />
                <span class="help-text">相邻切片重叠字数</span>
              </div>
            </div>

            <!-- Retrieve Settings -->
            <div class="form-row-3">
              <div class="form-group">
                <label>Dense Top-K</label>
                <input type="number" v-model.number="editingKb.topKDense" class="form-control" min="1" />
              </div>
              <div class="form-group">
                <label>Sparse Top-K</label>
                <input type="number" v-model.number="editingKb.topKSparse" class="form-control" min="1" />
              </div>
              <div class="form-group">
                <label>Final Top-M</label>
                <input type="number" v-model.number="editingKb.topMFinal" class="form-control" min="1" />
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showModal = false">取消</button>
            <button class="btn primary" :disabled="savingKb" @click="handleSaveKb">
              <div v-if="savingKb" class="btn-loading">
                <div class="spinner mini white"></div>
                <span>保存中...</span>
              </div>
              <template v-else>{{ isNewKb ? '创建知识库' : '保存修改' }}</template>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== Delete Confirm Modal ===== -->
    <Teleport to="body">
      <div v-if="showDeleteConfirm" class="modal-backdrop" @click="showDeleteConfirm = false">
        <div class="modal-content modal-sm" @click.stop>
          <div class="modal-header">
            <h3>确认删除</h3>
            <button class="close-btn" @click="showDeleteConfirm = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="confirm-content">
              <AlertCircle :size="32" class="confirm-icon danger" />
              <p>确定要删除知识库 <strong>"{{ deleteTarget?.name }}"</strong> 吗？</p>
              <p class="confirm-warn">此操作将不可逆地删除知识库下的所有切片和文档数据！</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showDeleteConfirm = false">取消</button>
            <button class="btn danger" @click="handleDeleteKb">确认删除</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== Toast ===== -->
    <Teleport to="body">
      <div v-if="toast.show" :class="['toast', toast.color]">
        <CheckCircle v-if="toast.color === 'success'" :size="16" />
        <AlertCircle v-else :size="16" />
        {{ toast.message }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.kb-page {
  max-width: 1600px;
  margin: 0 auto;
}

/* ===== Page Header ===== */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  gap: 1rem;
}

@media (max-width: 600px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
  }
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

/* ===== Loading ===== */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 0;
  gap: 1rem;
  color: var(--text-secondary);
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner.mini {
  width: 16px;
  height: 16px;
  border-width: 2px;
}

.spinner.mini.white {
  border-top-color: #ffffff;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ===== KB Grid ===== */
.kbs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 1.5rem;
}

@media (max-width: 480px) {
  .kbs-grid {
    grid-template-columns: 1fr;
  }
}

.kb-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  transition: all 0.2s ease-in-out;
  backdrop-filter: var(--glass-blur);
  cursor: pointer;
  overflow: hidden;
}

.kb-card:hover {
  border-color: var(--border-color-hover);
  transform: translateY(-2px);
  background: var(--bg-card-hover);
}

.card-header {
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.title-section {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  flex-grow: 1;
  min-width: 0;
}

.emoji-avatar {
  font-size: 1.75rem;
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.12);
  border-radius: 10px;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.emoji-avatar.lg {
  width: 56px;
  height: 56px;
  font-size: 2rem;
}

.title-text {
  min-width: 0;
}

.title-text h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
}

.desc-text {
  font-size: 0.85rem;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.35;
}

.card-body {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.stats-row {
  display: flex;
  gap: 1.5rem;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.9rem;
}

.stat-icon {
  color: var(--text-muted);
}

.stat-value {
  font-weight: 600;
  color: var(--text-primary);
}

.stat-label {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.meta-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.kb-badge {
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.15);
  color: #818CF8;
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.kb-badge.rerank {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.15);
  color: #34D399;
}

.kb-badge.dim {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
  color: var(--text-muted);
}

/* ===== Empty State ===== */
.empty-state {
  grid-column: 1 / -1;
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

.empty-state h3 {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-state p {
  color: var(--text-secondary);
  font-size: 0.9rem;
  max-width: 420px;
  margin-bottom: 0.5rem;
}

.empty-icon {
  opacity: 0.4;
}

/* ===== Breadcrumb ===== */
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
  font-size: 0.9rem;
}

.breadcrumb-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: none;
  border: none;
  color: var(--accent-primary);
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  transition: background 0.15s;
}

.breadcrumb-btn:hover {
  background: rgba(99, 102, 241, 0.08);
}

.breadcrumb-sep {
  color: var(--text-muted);
}

.breadcrumb-current {
  color: var(--text-primary);
  font-weight: 500;
}

/* ===== KB Info Bar ===== */
.kb-info-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem 1.5rem;
  backdrop-filter: var(--glass-blur);
  margin-bottom: 1.25rem;
}

.kb-info-text h2 {
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--text-primary);
}

.kb-info-text p {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin-top: 0.15rem;
}

/* ===== Tabs ===== */
.tabs-container {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 0.5rem;
}

.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 0.6rem 1.2rem;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.tab-btn:hover {
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-primary);
}

.tab-btn.active {
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent-primary);
  font-weight: 600;
}

body.light-theme .tab-btn.active {
  background: rgba(99, 102, 241, 0.08);
}

/* ===== Tab Panel ===== */
.tab-panel {
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ===== Overview ===== */
.overview-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

@media (max-width: 768px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
}

.overview-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  backdrop-filter: var(--glass-blur);
  overflow: hidden;
}

.overview-card-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  color: var(--accent-primary);
}

.overview-card-header h3 {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
}

.overview-card-body {
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.85rem;
}

.info-label {
  color: var(--text-muted);
}

.info-value {
  color: var(--text-primary);
  text-align: right;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== Documents Layout ===== */
.docs-layout {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 1.5rem;
}

@media (max-width: 900px) {
  .docs-layout {
    grid-template-columns: 1fr;
  }
}

.docs-list-panel,
.docs-upload-panel {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  backdrop-filter: var(--glass-blur);
  display: flex;
  flex-direction: column;
  max-height: 600px;
  overflow: hidden;
}

.panel-header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-header h3 {
  font-size: 0.95rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-primary);
}

.accent-icon {
  color: var(--accent-primary);
}

.docs-count {
  font-size: 0.8rem;
  background: rgba(99, 102, 241, 0.08);
  padding: 0.15rem 0.5rem;
  border-radius: 10px;
  color: var(--accent-primary);
}

.panel-body {
  padding: 1rem 1.25rem;
  overflow-y: auto;
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.panel-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-grow: 1;
  gap: 0.75rem;
  color: var(--text-secondary);
  padding: 2rem;
}

.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex-grow: 1;
  color: var(--text-muted);
  text-align: center;
  padding: 3rem 1rem;
  gap: 0.75rem;
}

.panel-empty p {
  font-size: 0.85rem;
}

/* ===== Doc Item ===== */
.doc-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  gap: 1rem;
}

.doc-item:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: var(--border-color-hover);
}

.doc-info {
  flex-grow: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.doc-title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.doc-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.doc-name {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-meta {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}

/* ===== Upload Form ===== */
.content-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.85rem;
  min-height: 200px;
  line-height: 1.4;
  resize: vertical;
}

.flex-grow {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
}

.flex-grow textarea {
  flex-grow: 1;
}

/* ===== Retrieve ===== */
.retrieve-panel {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.retrieve-form {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1.25rem;
  backdrop-filter: var(--glass-blur);
}

.retrieve-actions {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
  margin-top: 0.75rem;
}

.inline-group {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}

.inline-group label {
  margin-bottom: 0;
  white-space: nowrap;
}

.retrieve-results {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  backdrop-filter: var(--glass-blur);
  overflow: hidden;
}

.results-header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.results-header h3 {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
}

.results-count {
  font-size: 0.8rem;
  background: rgba(99, 102, 241, 0.08);
  padding: 0.15rem 0.5rem;
  border-radius: 10px;
  color: var(--accent-primary);
}

.results-list {
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-height: 500px;
  overflow-y: auto;
}

.result-item {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  background: rgba(255, 255, 255, 0.02);
}

.result-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}

.result-index {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-muted);
}

.result-score {
  font-size: 0.85rem;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.result-label {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
}

.result-content {
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== Settings ===== */
.settings-panel {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  backdrop-filter: var(--glass-blur);
  overflow: hidden;
}

.settings-section {
  padding: 1.25rem;
}

.section-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.config-divider {
  height: 1px;
  background: var(--border-color);
}

.settings-footer {
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: flex-end;
}

/* ===== Form Shared ===== */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.25rem;
}

@media (max-width: 768px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}

.form-row-2 {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1.25rem;
}

.form-row-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1.25rem;
}

@media (max-width: 768px) {
  .form-row-2,
  .form-row-3 {
    grid-template-columns: 1fr;
  }
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.form-group label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.required {
  color: var(--accent-danger);
}

.muted {
  color: var(--text-muted);
  font-weight: 400;
}

.form-control {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
  color: var(--text-primary);
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s ease;
  width: 100%;
}

.form-control:focus {
  border-color: var(--accent-primary);
}

.form-control:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.form-control.sm {
  width: 80px;
  font-size: 0.85rem;
  padding: 0.4rem 0.6rem;
}

select.form-control {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
  background-repeat: no-repeat;
  background-position: right 0.8rem center;
  background-size: 1rem;
  padding-right: 2.5rem;
}

textarea.form-control {
  resize: vertical;
}

.help-text {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

/* ===== Emoji Picker ===== */
.emoji-input-wrapper {
  position: relative;
}

.emoji-trigger {
  width: 56px;
  height: 42px;
  font-size: 1.25rem;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s;
}

.emoji-trigger:hover {
  border-color: var(--accent-primary);
}

.emoji-picker {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  background: var(--bg-modal);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 8px;
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 4px;
  z-index: 100;
  max-height: 240px;
  overflow-y: auto;
}

.emoji-option {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1.1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.emoji-option:hover {
  background: rgba(99, 102, 241, 0.1);
}

.emoji-option.active {
  background: rgba(99, 102, 241, 0.2);
  outline: 2px solid var(--accent-primary);
}

/* ===== Buttons ===== */
.btn {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  transition: all 0.15s ease;
}

.btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--border-color-hover);
}

.btn.primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: #ffffff;
}

.btn.primary:hover:not(:disabled) {
  background: var(--accent-primary-hover);
}

.btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.danger {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #FB7185;
}

.btn.danger:hover {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.4);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  border-radius: 6px;
}

.w-full {
  width: 100%;
}

.icon-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.icon-btn.danger:hover {
  color: var(--accent-danger);
  background: rgba(239, 68, 68, 0.1);
}

.btn-loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* ===== Modal ===== */
.modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.6);
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
  max-width: 580px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: modalEnter 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.modal-content.modal-sm {
  max-width: 440px;
}

@keyframes modalEnter {
  from { opacity: 0; transform: scale(0.95) translateY(10px); }
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
}

.close-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 6px;
  transition: all 0.15s;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

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
  gap: 0.75rem;
}

/* ===== Delete Confirm ===== */
.confirm-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.75rem;
}

.confirm-icon.danger {
  color: var(--accent-danger);
}

.confirm-content p {
  font-size: 0.95rem;
  color: var(--text-primary);
}

.confirm-warn {
  font-size: 0.85rem !important;
  color: var(--text-muted) !important;
}

/* ===== Toast ===== */
.toast {
  position: fixed;
  top: 20px;
  right: 20px;
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  z-index: 9999;
  animation: toastIn 0.2s ease-out;
  max-width: 400px;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.toast.success {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: var(--accent-success);
}

.toast.error {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: var(--accent-danger);
}

.toast.info {
  background: rgba(99, 102, 241, 0.15);
  border: 1px solid rgba(99, 102, 241, 0.3);
  color: var(--accent-primary);
}

@keyframes toastIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
