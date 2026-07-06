import { useEffect, useMemo, useState } from 'react'
import {
  Plus, Trash2, BookOpen, FileText, ChevronLeft, ChevronRight,
  Upload, Clock, Layers, Search, Settings, Info, Database,
  Save, Hash, SlidersHorizontal, AlertCircle
} from 'lucide-react'
import { useToast, ToastPortal, Modal, useAsyncEffect } from './shared'
import { apiFetch } from '../lib/api'

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
  doc_count?: number
  chunk_count?: number
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
  metadata?: Record<string, unknown>
}

interface EditingKb {
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
}

type DetailTab = 'overview' | 'documents' | 'retrieve' | 'settings'

// ===== Emoji Picker =====
const EMOJI_LIST = [
  '📚', '📖', '📝', '📋', '🗂️', '📁', '💾', '🗄️',
  '🧠', '💡', '🔬', '🎯', '🚀', '⚙️', '🔧', '🛠️',
  '🏢', '🏠', '💻', '📱', '🌐', '🔒', '🔑', '📊',
  '📈', '📉', '🗂️', '📰', '📑', '📄', '📃', '📜',
  '🎓', '🏫', '🧪', '💊', '🏥', '🏦', '💰', '🏷️',
  '🤖', '🧩', '🎨', '🎵', '🌍', '✈️', '🚗', '⚡'
]

export default function KnowledgeManager() {
  // ===== State =====
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [providersList, setProvidersList] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)

  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null)
  const [selectedKbDetail, setSelectedKbDetail] = useState<KnowledgeBase | null>(null)
  const [documents, setDocuments] = useState<KBDocument[]>([])
  const [loadingDocs, setLoadingDocs] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')

  // Create KB dialog
  const [showModal, setShowModal] = useState(false)
  const [isNewKb, setIsNewKb] = useState(false)
  const [editingKb, setEditingKb] = useState<EditingKb | null>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [savingKb, setSavingKb] = useState(false)

  // Delete confirm dialog
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  // Document upload
  const [uploadingDoc, setUploadingDoc] = useState(false)
  const [docForm, setDocForm] = useState({ name: '', content: '' })

  // Retrieve
  const [retrieveQuery, setRetrieveQuery] = useState('')
  const [retrieveTopK, setRetrieveTopK] = useState(5)
  const [retrieving, setRetrieving] = useState(false)
  const [retrieveResults, setRetrieveResults] = useState<RetrieveResult[]>([])

  // Settings saving
  const [savingSettings, setSavingSettings] = useState(false)

  // Toast
  const { toast, showMessage } = useToast()

  // ===== Computed =====
  const embeddingProviders = useMemo(
    () => providersList.filter(p => p.provider_type === 'embedding'),
    [providersList]
  )

  const rerankProviders = useMemo(
    () => providersList.filter(p => p.provider_type === 'rerank'),
    [providersList]
  )

  // ===== API =====
  async function fetchKbs() {
    setLoading(true)
    try {
      const res = await apiFetch('/api/kb/list')
      if (res.ok) {
        setKbs(await res.json())
      }
    } catch (error) {
      console.error('获取知识库列表失败:', error)
      showMessage('获取知识库列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function fetchProviders() {
    try {
      const res = await apiFetch('/api/config/provider/list?provider_type=embedding,rerank')
      if (res.ok) {
        const data = await res.json()
        setProvidersList(Array.isArray(data) ? data : (data.providers || []))
      }
    } catch (error) {
      console.error('获取提供商列表失败:', error)
    }
  }

  async function fetchKbDetail(kbId: string): Promise<KnowledgeBase | null> {
    try {
      const res = await apiFetch(`/api/kb/get?kb_id=${encodeURIComponent(kbId)}`)
      if (res.ok) {
        const data = await res.json()
        setSelectedKbDetail(data)
        return data
      }
    } catch (error) {
      console.error('获取知识库详情失败:', error)
    }
    return null
  }

  async function fetchDocuments(kbId?: string) {
    const id = kbId ?? selectedKb?.id
    if (!id) return
    setLoadingDocs(true)
    try {
      const res = await apiFetch(`/api/kb/document/list?kb_id=${encodeURIComponent(id)}`)
      if (res.ok) {
        setDocuments(await res.json())
      }
    } catch (error) {
      console.error('获取文档列表失败:', error)
    } finally {
      setLoadingDocs(false)
    }
  }

  // ===== Helpers =====
  function updateEditingField<K extends keyof EditingKb>(key: K, value: EditingKb[K]) {
    setEditingKb(prev => (prev ? { ...prev, [key]: value } : prev))
  }

  function updateDetailField<K extends keyof KnowledgeBase>(key: K, value: KnowledgeBase[K]) {
    setSelectedKbDetail(prev => (prev ? { ...prev, [key]: value } : prev))
  }

  // ===== Actions =====
  function handleCreateKb() {
    setIsNewKb(true)
    setEditingKb({
      name: '',
      description: '',
      emoji: '📚',
      embeddingProviderId: embeddingProviders[0]?.id || '',
      rerankProviderId: '',
      chunkSize: 500,
      chunkOverlap: 50,
      topKDense: 10,
      topKSparse: 10,
      topMFinal: 5
    })
    setShowModal(true)
  }

  async function handleSaveKb() {
    if (!editingKb) return
    if (!editingKb.name.trim()) {
      showMessage('知识库名称不能为空', 'error')
      return
    }
    if (!editingKb.embeddingProviderId) {
      showMessage('请选择嵌入模型提供商', 'error')
      return
    }

    const wasNewKb = isNewKb
    setSavingKb(true)
    try {
      const payload: Record<string, string | number> = {
        name: editingKb.name.trim(),
        description: editingKb.description.trim(),
        emoji: editingKb.emoji,
        embeddingProviderId: editingKb.embeddingProviderId,
        chunkSize: editingKb.chunkSize,
        chunkOverlap: editingKb.chunkOverlap,
        topKDense: editingKb.topKDense,
        topKSparse: editingKb.topKSparse,
        topMFinal: editingKb.topMFinal
      }
      if (editingKb.rerankProviderId) {
        payload.rerankProviderId = editingKb.rerankProviderId
      }

      let res: Response
      if (wasNewKb) {
        res = await apiFetch('/api/kb/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
      } else {
        payload.kb_id = selectedKb!.id
        res = await apiFetch('/api/kb/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
      }

      if (res.ok) {
        setShowModal(false)
        setEditingKb(null)
        showMessage(wasNewKb ? '知识库创建成功' : '知识库更新成功')
        await fetchKbs()
        if (!wasNewKb && selectedKb) {
          const detail = await fetchKbDetail(selectedKb.id)
          if (detail) setSelectedKb(detail)
        }
      } else {
        const err = await res.json().catch(() => ({}))
        showMessage(err.message || '操作失败', 'error')
      }
    } catch (error) {
      console.error('保存知识库失败:', error)
      showMessage('保存知识库失败', 'error')
    } finally {
      setSavingKb(false)
    }
  }

  function confirmDeleteKb(id: string, name: string) {
    setDeleteTarget({ id, name })
    setShowDeleteConfirm(true)
  }

  async function handleDeleteKb() {
    if (!deleteTarget) return
    try {
      const res = await apiFetch('/api/kb/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kb_id: deleteTarget.id })
      })
      if (res.ok) {
        if (selectedKb?.id === deleteTarget.id) {
          setSelectedKb(null)
          setSelectedKbDetail(null)
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
      setShowDeleteConfirm(false)
      setDeleteTarget(null)
    }
  }

  async function selectKb(kb: KnowledgeBase) {
    setSelectedKb(kb)
    setDetailTab('overview')
    setRetrieveResults([])
    await fetchKbDetail(kb.id)
    await fetchDocuments(kb.id)
  }

  function goBack() {
    setSelectedKb(null)
    setSelectedKbDetail(null)
    setDocuments([])
    setRetrieveResults([])
  }

  async function handleUploadDoc() {
    if (!selectedKb) return
    if (!docForm.name.trim()) {
      showMessage('文档标题不能为空', 'error')
      return
    }
    if (!docForm.content.trim()) {
      showMessage('文档内容不能为空', 'error')
      return
    }

    setUploadingDoc(true)
    try {
      const res = await apiFetch('/api/kb/document/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kb_id: selectedKb.id,
          doc_name: docForm.name.trim(),
          text: docForm.content.trim()
        })
      })
      if (res.ok) {
        setDocForm({ name: '', content: '' })
        showMessage('文档上传成功')
        await fetchDocuments()
        await fetchKbDetail(selectedKb.id)
      } else {
        const err = await res.json().catch(() => ({}))
        showMessage(err.message || '上传失败', 'error')
      }
    } catch (error) {
      console.error('上传文档失败:', error)
      showMessage('上传文档失败', 'error')
    } finally {
      setUploadingDoc(false)
    }
  }

  async function handleDeleteDoc(docId: string, docName: string) {
    if (!window.confirm(`确定要删除文档 "${docName}" 吗？`)) return
    try {
      const res = await apiFetch('/api/kb/document/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: docId })
      })
      if (res.ok) {
        showMessage('文档已删除')
        await fetchDocuments()
        if (selectedKb) await fetchKbDetail(selectedKb.id)
      } else {
        showMessage('删除文档失败', 'error')
      }
    } catch (error) {
      console.error('删除文档失败:', error)
      showMessage('删除文档失败', 'error')
    }
  }

  async function handleRetrieve() {
    if (!selectedKb) return
    if (!retrieveQuery.trim()) {
      showMessage('请输入检索查询', 'error')
      return
    }

    setRetrieving(true)
    setRetrieveResults([])
    try {
      const res = await apiFetch('/api/kb/retrieve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: retrieveQuery.trim(),
          kb_names: [selectedKb.name],
          top_k: retrieveTopK
        })
      })
      if (res.ok) {
        const data = await res.json()
        const results = Array.isArray(data) ? data : (data.results || [])
        setRetrieveResults(results)
        if (results.length === 0) {
          showMessage('未找到相关结果', 'info')
        }
      } else {
        showMessage('检索失败', 'error')
      }
    } catch (error) {
      console.error('检索失败:', error)
      showMessage('检索失败', 'error')
    } finally {
      setRetrieving(false)
    }
  }

  async function handleSaveSettings() {
    if (!selectedKbDetail) return
    setSavingSettings(true)
    try {
      const res = await apiFetch('/api/kb/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kb_id: selectedKbDetail.id,
          chunkSize: selectedKbDetail.chunkSize,
          chunkOverlap: selectedKbDetail.chunkOverlap,
          topKDense: selectedKbDetail.topKDense,
          topKSparse: selectedKbDetail.topKSparse,
          topMFinal: selectedKbDetail.topMFinal,
          rerankProviderId: selectedKbDetail.rerankProviderId || undefined
        })
      })
      if (res.ok) {
        showMessage('设置已保存')
        const detail = await fetchKbDetail(selectedKbDetail.id)
        if (detail) setSelectedKb(detail)
      } else {
        showMessage('保存设置失败', 'error')
      }
    } catch (error) {
      console.error('保存设置失败:', error)
      showMessage('保存设置失败', 'error')
    } finally {
      setSavingSettings(false)
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
  useAsyncEffect(async (signal) => {
    await Promise.all([fetchKbs(), fetchProviders()])
    if (signal.aborted) return
  }, [])

  // ===== Render =====
  return (
    <div className="kb-page animate-fade-in">
      {/* ===== List View ===== */}
      {!selectedKb && (
        <>
          <div className="page-header">
            <div>
              <h1>知识库管理</h1>
              <p>基于 RAG 技术创建知识库并持久化向量索引，让 Agent 能够检索私有文件内容</p>
            </div>
            <button className="btn primary" onClick={handleCreateKb}>
              <Plus size={16} /> 新建知识库
            </button>
          </div>

          {/* Loading */}
          {loading && kbs.length === 0 && (
            <div className="loading-state">
              <div className="spinner"></div>
              <p>加载中...</p>
            </div>
          )}

          {/* KB Grid */}
          {!(loading && kbs.length === 0) && (
            <div className="kbs-grid">
              {kbs.map(kb => (
                <div
                  key={kb.id}
                  className="kb-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => selectKb(kb)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectKb(kb) } }}
                >
                  <div className="card-header">
                    <div className="title-section">
                      <span className="emoji-avatar">{kb.emoji}</span>
                      <div className="title-text">
                        <h3>{kb.name}</h3>
                        <p className="desc-text">{kb.description || '暂无描述信息'}</p>
                      </div>
                    </div>
                    <button
                      className="icon-btn danger"
                      title="删除"
                      onClick={(e) => { e.stopPropagation(); confirmDeleteKb(kb.id, kb.name) }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="card-body">
                    <div className="stats-row">
                      <div className="stat-item">
                        <FileText size={14} className="stat-icon" />
                        <span className="stat-value">{kb.doc_count ?? '-'}</span>
                        <span className="stat-label">文档</span>
                      </div>
                      <div className="stat-item">
                        <Layers size={14} className="stat-icon" />
                        <span className="stat-value">{kb.chunk_count ?? '-'}</span>
                        <span className="stat-label">分块</span>
                      </div>
                    </div>
                    <div className="meta-tags">
                      <span className="kb-badge">{kb.embeddingProviderId}</span>
                      {kb.rerankProviderId && (
                        <span className="kb-badge rerank">{kb.rerankProviderId}</span>
                      )}
                      <span className="kb-badge dim">切片 {kb.chunkSize}</span>
                      <span className="kb-badge dim">重叠 {kb.chunkOverlap}</span>
                    </div>
                  </div>
                </div>
              ))}

              {/* Empty State */}
              {kbs.length === 0 && (
                <div className="empty-state">
                  <BookOpen size={48} className="empty-icon" />
                  <h3>没有知识库</h3>
                  <p>创建一个知识库并选择合适的嵌入模型，即可向其上传文本并进行向量检索。</p>
                  <button className="btn primary" onClick={handleCreateKb}>
                    <Plus size={16} /> 创建第一个知识库
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ===== Detail View ===== */}
      {selectedKb && (
        <>
          {/* Breadcrumb */}
          <div className="breadcrumb">
            <button className="breadcrumb-btn" onClick={goBack}>
              <ChevronLeft size={16} />
              <span>知识库列表</span>
            </button>
            <ChevronRight size={14} className="breadcrumb-sep" />
            <span className="breadcrumb-current">{selectedKb.emoji} {selectedKb.name}</span>
          </div>

          {/* KB Info Bar */}
          <div className="kb-info-bar">
            <span className="emoji-avatar lg">{selectedKb.emoji}</span>
            <div className="kb-info-text">
              <h2>{selectedKb.name}</h2>
              <p>{selectedKb.description || '暂无描述'}</p>
            </div>
          </div>

          {/* Detail Tabs */}
          <div className="tabs-container">
            <button className={`tab-btn${detailTab === 'overview' ? ' active' : ''}`} onClick={() => setDetailTab('overview')}>
              <Info size={14} /> 概览
            </button>
            <button className={`tab-btn${detailTab === 'documents' ? ' active' : ''}`} onClick={() => setDetailTab('documents')}>
              <FileText size={14} /> 文档
            </button>
            <button className={`tab-btn${detailTab === 'retrieve' ? ' active' : ''}`} onClick={() => setDetailTab('retrieve')}>
              <Search size={14} /> 检索
            </button>
            <button className={`tab-btn${detailTab === 'settings' ? ' active' : ''}`} onClick={() => setDetailTab('settings')}>
              <Settings size={14} /> 设置
            </button>
          </div>

          {/* Tab: Overview */}
          {detailTab === 'overview' && (
            <div className="tab-panel">
              <div className="km-overview-grid">
                <div className="km-overview-card">
                  <div className="km-overview-card-header">
                    <Database size={16} />
                    <h3>基本信息</h3>
                  </div>
                  <div className="km-overview-card-body">
                    <div className="info-row">
                      <span className="info-label">知识库 ID</span>
                      <span className="info-value font-mono">{selectedKbDetail?.id || selectedKb.id}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">名称</span>
                      <span className="info-value">{selectedKbDetail?.name || selectedKb.name}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">描述</span>
                      <span className="info-value">{selectedKbDetail?.description || selectedKb.description || '-'}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">嵌入模型</span>
                      <span className="info-value font-mono">{selectedKbDetail?.embeddingProviderId || selectedKb.embeddingProviderId}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">重排序模型</span>
                      <span className="info-value font-mono">{selectedKbDetail?.rerankProviderId || selectedKb.rerankProviderId || '未配置'}</span>
                    </div>
                  </div>
                </div>

                <div className="km-overview-card">
                  <div className="km-overview-card-header">
                    <Layers size={16} />
                    <h3>统计信息</h3>
                  </div>
                  <div className="km-overview-card-body">
                    <div className="info-row">
                      <span className="info-label">文档数量</span>
                      <span className="info-value">{documents.length}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">总分块数</span>
                      <span className="info-value">{documents.reduce((sum, d) => sum + d.chunkCount, 0)}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">分块大小</span>
                      <span className="info-value">{selectedKbDetail?.chunkSize || selectedKb.chunkSize} 字</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">分块重叠</span>
                      <span className="info-value">{selectedKbDetail?.chunkOverlap || selectedKb.chunkOverlap} 字</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">Dense Top-K</span>
                      <span className="info-value">{selectedKbDetail?.topKDense || selectedKb.topKDense}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">Sparse Top-K</span>
                      <span className="info-value">{selectedKbDetail?.topKSparse || selectedKb.topKSparse}</span>
                    </div>
                    <div className="info-row">
                      <span className="info-label">Final Top-M</span>
                      <span className="info-value">{selectedKbDetail?.topMFinal || selectedKb.topMFinal}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab: Documents */}
          {detailTab === 'documents' && (
            <div className="tab-panel">
              <div className="docs-layout">
                {/* Document List */}
                <div className="docs-list-panel">
                  <div className="panel-header">
                    <h3><FileText size={16} className="accent-icon" /> 已上传文档</h3>
                    <span className="docs-count">{documents.length} 个文档</span>
                  </div>

                  {loadingDocs && (
                    <div className="panel-loading">
                      <div className="spinner mini"></div>
                      <span>加载中...</span>
                    </div>
                  )}

                  {!loadingDocs && (
                    <div className="panel-body">
                      {documents.map(doc => (
                        <div key={doc.id} className="doc-item">
                          <div className="doc-info">
                            <div className="doc-title-row">
                              <FileText size={14} className="doc-icon" />
                              <span className="doc-name" title={doc.name}>{doc.name}</span>
                            </div>
                            <div className="doc-meta">
                              <span className="meta-tag"><Layers size={12} /> {doc.chunkCount} 分块</span>
                              <span className="meta-tag"><Clock size={12} /> {formatDate(doc.createdAt)}</span>
                            </div>
                          </div>
                          <button
                            className="icon-btn danger"
                            title="删除文档"
                            onClick={() => handleDeleteDoc(doc.id, doc.name)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}

                      {documents.length === 0 && (
                        <div className="panel-empty">
                          <FileText size={36} className="empty-icon" />
                          <p>暂无文档，请在右侧上传</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Upload Form */}
                <div className="docs-upload-panel">
                  <div className="panel-header">
                    <h3><Upload size={16} className="accent-icon" /> 上传文本</h3>
                  </div>
                  <div className="panel-body">
                    <div className="form-group">
                      <label>文档标题</label>
                      <input
                        type="text"
                        value={docForm.name}
                        onChange={(e) => setDocForm(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="例如: 产品说明书_v2.txt"
                        className="form-control"
                        disabled={uploadingDoc}
                      />
                    </div>
                    <div className="form-group flex-grow">
                      <label>文档内容</label>
                      <textarea
                        value={docForm.content}
                        onChange={(e) => setDocForm(prev => ({ ...prev, content: e.target.value }))}
                        placeholder="在此粘贴你想录入的文本内容，系统将根据知识库的分块大小进行智能切片，并通过嵌入模型向量化存入数据库..."
                        className="form-control content-textarea"
                        disabled={uploadingDoc}
                      />
                    </div>
                    <button
                      className="btn primary w-full"
                      disabled={uploadingDoc || !docForm.name.trim() || !docForm.content.trim()}
                      onClick={handleUploadDoc}
                    >
                      {uploadingDoc ? (
                        <div className="btn-loading">
                          <div className="spinner mini white"></div>
                          <span>切片计算中...</span>
                        </div>
                      ) : (
                        <><Upload size={14} /> 生成向量切片并上传</>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab: Retrieve */}
          {detailTab === 'retrieve' && (
            <div className="tab-panel">
              <div className="retrieve-panel">
                <div className="retrieve-form">
                  <div className="form-group">
                    <label>检索查询</label>
                    <textarea
                      value={retrieveQuery}
                      onChange={(e) => setRetrieveQuery(e.target.value)}
                      placeholder="输入你想检索的内容..."
                      className="form-control"
                      rows={3}
                      onKeyDown={(e) => { if (e.ctrlKey && e.key === 'Enter') handleRetrieve() }}
                    />
                    <span className="help-text">按 Ctrl+Enter 快速检索</span>
                  </div>
                  <div className="retrieve-actions">
                    <div className="form-group inline-group">
                      <label>Top K</label>
                      <input
                        type="number"
                        value={retrieveTopK}
                        onChange={(e) => setRetrieveTopK(Number(e.target.value))}
                        className="form-control sm"
                        min={1}
                        max={50}
                      />
                    </div>
                    <button
                      className="btn primary"
                      disabled={retrieving || !retrieveQuery.trim()}
                      onClick={handleRetrieve}
                    >
                      <Search size={14} />
                      {retrieving ? <span>检索中...</span> : <span>检索</span>}
                    </button>
                  </div>
                </div>

                {/* Retrieve Results */}
                {retrieveResults.length > 0 && (
                  <div className="retrieve-results">
                    <div className="results-header">
                      <h3>检索结果</h3>
                      <span className="results-count">{retrieveResults.length} 条</span>
                    </div>
                    <div className="results-list">
                      {retrieveResults.map((result, idx) => (
                        <div key={idx} className="result-item">
                          <div className="result-header">
                            <span className="result-index">#{idx + 1}</span>
                            <span className="result-score" style={{ color: scoreColor(result.score) }}>
                              {(result.score * 100).toFixed(1)}%
                            </span>
                            <span className="result-label" style={{ color: scoreColor(result.score) }}>
                              {scoreLabel(result.score)}
                            </span>
                          </div>
                          <div className="result-content">{result.content}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {retrieveResults.length === 0 && !retrieving && (
                  <div className="panel-empty">
                    <Search size={36} className="empty-icon" />
                    <p>输入查询内容进行知识库检索</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab: Settings */}
          {detailTab === 'settings' && selectedKbDetail && (
            <div className="tab-panel">
              <div className="settings-panel">
                <div className="settings-section">
                  <div className="km-section-title"><SlidersHorizontal size={16} /> 分块参数</div>
                  <div className="form-grid">
                    <div className="form-group">
                      <label>分块大小 (Chunk Size)</label>
                      <input
                        type="number"
                        value={selectedKbDetail.chunkSize}
                        onChange={(e) => updateDetailField('chunkSize', Number(e.target.value))}
                        className="form-control"
                        min={100}
                        max={10000}
                      />
                      <span className="help-text">每个切片段落的最大字数限制</span>
                    </div>
                    <div className="form-group">
                      <label>分块重叠 (Chunk Overlap)</label>
                      <input
                        type="number"
                        value={selectedKbDetail.chunkOverlap}
                        onChange={(e) => updateDetailField('chunkOverlap', Number(e.target.value))}
                        className="form-control"
                        min={0}
                        max={2000}
                      />
                      <span className="help-text">相邻切片首尾重叠重合字数</span>
                    </div>
                  </div>
                </div>

                <div className="config-divider"></div>

                <div className="settings-section">
                  <div className="km-section-title"><Hash size={16} /> 检索参数</div>
                  <div className="form-grid">
                    <div className="form-group">
                      <label>Dense Top-K</label>
                      <input
                        type="number"
                        value={selectedKbDetail.topKDense}
                        onChange={(e) => updateDetailField('topKDense', Number(e.target.value))}
                        className="form-control"
                        min={1}
                        max={100}
                      />
                      <span className="help-text">稠密向量检索返回数量</span>
                    </div>
                    <div className="form-group">
                      <label>Sparse Top-K</label>
                      <input
                        type="number"
                        value={selectedKbDetail.topKSparse}
                        onChange={(e) => updateDetailField('topKSparse', Number(e.target.value))}
                        className="form-control"
                        min={1}
                        max={100}
                      />
                      <span className="help-text">稀疏向量检索返回数量</span>
                    </div>
                    <div className="form-group">
                      <label>Final Top-M</label>
                      <input
                        type="number"
                        value={selectedKbDetail.topMFinal}
                        onChange={(e) => updateDetailField('topMFinal', Number(e.target.value))}
                        className="form-control"
                        min={1}
                        max={100}
                      />
                      <span className="help-text">最终返回给模型上下文的切片数量</span>
                    </div>
                    <div className="form-group">
                      <label>重排序模型</label>
                      <select
                        value={selectedKbDetail.rerankProviderId ?? ''}
                        onChange={(e) => updateDetailField('rerankProviderId', e.target.value || null)}
                        className="form-control"
                      >
                        <option value="">不使用</option>
                        {rerankProviders.map(p => (
                          <option key={p.id} value={p.id}>{p.id}</option>
                        ))}
                      </select>
                      <span className="help-text">可选的重排序服务提供商</span>
                    </div>
                  </div>
                </div>

                <div className="settings-footer">
                  <button className="btn primary" disabled={savingSettings} onClick={handleSaveSettings}>
                    {savingSettings ? (
                      <div className="btn-loading">
                        <div className="spinner mini white"></div>
                        <span>保存中...</span>
                      </div>
                    ) : (
                      <><Save size={14} /> 保存设置</>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ===== Create/Edit KB Modal ===== */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={isNewKb ? '新建知识库' : '编辑知识库'}
        footer={
          <>
            <button className="btn" onClick={() => setShowModal(false)}>取消</button>
            <button className="btn primary" disabled={savingKb} onClick={handleSaveKb}>
              {savingKb ? (
                <div className="btn-loading">
                  <div className="spinner mini white"></div>
                  <span>保存中...</span>
                </div>
              ) : (
                isNewKb ? '创建知识库' : '保存修改'
              )}
            </button>
          </>
        }
      >
        {editingKb && (
          <>
            {/* Emoji + Name */}
            <div className="form-row-2">
              <div className="form-group" style={{ maxWidth: '100px' }}>
                <label>图标</label>
                <div className="emoji-input-wrapper">
                  <button className="emoji-trigger" onClick={() => setShowEmojiPicker(!showEmojiPicker)}>
                    {editingKb.emoji}
                  </button>
                  {showEmojiPicker && (
                    <div className="emoji-picker" onClick={(e) => e.stopPropagation()}>
                      {EMOJI_LIST.map(emoji => (
                        <button
                          key={emoji}
                          className={`emoji-option${editingKb.emoji === emoji ? ' active' : ''}`}
                          onClick={() => { updateEditingField('emoji', emoji); setShowEmojiPicker(false) }}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="form-group">
                <label>知识库名称 <span className="required">*</span></label>
                <input
                  type="text"
                  value={editingKb.name}
                  onChange={(e) => updateEditingField('name', e.target.value)}
                  placeholder="知识库名称"
                  className="form-control"
                />
              </div>
            </div>

            {/* Description */}
            <div className="form-group">
              <label>描述</label>
              <textarea
                value={editingKb.description}
                onChange={(e) => updateEditingField('description', e.target.value)}
                placeholder="描述"
                rows={2}
                className="form-control"
              />
            </div>

            {/* Providers */}
            <div className="form-row-2">
              <div className="form-group">
                <label>嵌入模型 <span className="required">*</span></label>
                <select
                  value={editingKb.embeddingProviderId}
                  onChange={(e) => updateEditingField('embeddingProviderId', e.target.value)}
                  className="form-control"
                >
                  <option value="" disabled>选择嵌入模型</option>
                  {embeddingProviders.map(p => (
                    <option key={p.id} value={p.id}>{p.id}</option>
                  ))}
                  {embeddingProviders.length === 0 && (
                    <option value="" disabled>(无可用嵌入模型)</option>
                  )}
                </select>
              </div>
              <div className="form-group">
                <label>重排序模型 <span className="muted">(可选)</span></label>
                <select
                  value={editingKb.rerankProviderId}
                  onChange={(e) => updateEditingField('rerankProviderId', e.target.value)}
                  className="form-control"
                >
                  <option value="">不使用</option>
                  {rerankProviders.map(p => (
                    <option key={p.id} value={p.id}>{p.id}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Chunk Settings */}
            <div className="form-row-2">
              <div className="form-group">
                <label>分块大小</label>
                <input
                  type="number"
                  value={editingKb.chunkSize}
                  onChange={(e) => updateEditingField('chunkSize', Number(e.target.value))}
                  className="form-control"
                  min={100}
                  max={10000}
                />
                <span className="help-text">每个切片的最大字数</span>
              </div>
              <div className="form-group">
                <label>分块重叠</label>
                <input
                  type="number"
                  value={editingKb.chunkOverlap}
                  onChange={(e) => updateEditingField('chunkOverlap', Number(e.target.value))}
                  className="form-control"
                  min={0}
                  max={2000}
                />
                <span className="help-text">相邻切片重叠字数</span>
              </div>
            </div>

            {/* Retrieve Settings */}
            <div className="form-row-3">
              <div className="form-group">
                <label>Dense Top-K</label>
                <input
                  type="number"
                  value={editingKb.topKDense}
                  onChange={(e) => updateEditingField('topKDense', Number(e.target.value))}
                  className="form-control"
                  min={1}
                />
              </div>
              <div className="form-group">
                <label>Sparse Top-K</label>
                <input
                  type="number"
                  value={editingKb.topKSparse}
                  onChange={(e) => updateEditingField('topKSparse', Number(e.target.value))}
                  className="form-control"
                  min={1}
                />
              </div>
              <div className="form-group">
                <label>Final Top-M</label>
                <input
                  type="number"
                  value={editingKb.topMFinal}
                  onChange={(e) => updateEditingField('topMFinal', Number(e.target.value))}
                  className="form-control"
                  min={1}
                />
              </div>
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
            <button className="btn danger" onClick={handleDeleteKb}>确认删除</button>
          </>
        }
      >
        <div className="confirm-content">
          <AlertCircle size={32} className="confirm-icon danger" />
          <p>确定要删除知识库 <strong>"{deleteTarget?.name}"</strong> 吗？</p>
          <p className="confirm-warn">此操作将不可逆地删除知识库下的所有切片和文档数据！</p>
        </div>
      </Modal>

      {/* ===== Toast ===== */}
      <ToastPortal toast={toast} />
    </div>
  )
}
