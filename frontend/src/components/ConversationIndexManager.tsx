import { useEffect, useState } from 'react'
import {
  FileText, Search, RefreshCw, Trash2, Clock, Tag, X
} from 'lucide-react'
import { useToast, ToastPortal } from './shared'
import { apiFetch } from '../lib/api'

interface ConversationIndexEntry {
  id: number
  title: string
  topics: string[]
  conversationId: string
  timestamp: string
  createdAt: string
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString('zh-CN')
  } catch {
    return dateStr
  }
}

export default function ConversationIndexManager() {
  const [indices, setIndices] = useState<ConversationIndexEntry[]>([])
  const [indicesTotal, setIndicesTotal] = useState(0)
  const [indicesLoading, setIndicesLoading] = useState(false)
  const [indicesSearch, setIndicesSearch] = useState('')
  const { toast, showMessage } = useToast()

  const fetchIndices = async (search?: string) => {
    const q = search !== undefined ? search : indicesSearch
    setIndicesLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', '100')
      if (q.trim()) params.set('search', q.trim())
      const res = await apiFetch(`/api/conversation-indices?${params}`)
      if (res.ok) {
        const data = await res.json()
        setIndices(data.indices || [])
        setIndicesTotal(data.total || 0)
      }
    } catch (error) {
      console.error('获取对话索引失败:', error)
      showMessage('获取对话索引失败', 'error')
    } finally {
      setIndicesLoading(false)
    }
  }

  const handleDeleteIndex = async (id: number) => {
    try {
      const res = await apiFetch(`/api/conversation-indices/${id}`, { method: 'DELETE' })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          showMessage('索引已删除')
          await fetchIndices()
        } else {
          showMessage('删除失败', 'error')
        }
      }
    } catch (error) {
      console.error('删除对话索引失败:', error)
      showMessage('删除对话索引失败', 'error')
    }
  }

  const handleClearIndices = async () => {
    if (!window.confirm('确定要清空全部对话历史索引吗？此操作不可恢复。')) {
      return
    }
    try {
      const res = await apiFetch('/api/conversation-indices/clear', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          showMessage(`已清空 ${data.deletedCount} 条对话索引`)
          await fetchIndices()
        }
      }
    } catch (error) {
      console.error('清空对话索引失败:', error)
      showMessage('清空对话索引失败', 'error')
    }
  }

  useEffect(() => {
    fetchIndices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="memory-page animate-fade-in">
      <div className="page-header">
        <div>
          <h1>对话历史索引</h1>
          <p>整理器自动从对话中提炼的检索标题与关键词，当前共 {indicesTotal} 条</p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => fetchIndices()} disabled={indicesLoading} title="刷新">
            <RefreshCw size={16} className={indicesLoading ? 'animate-spin' : ''} />
          </button>
          <button className="btn danger" onClick={handleClearIndices} disabled={indices.length === 0}>
            <Trash2 size={16} /> 清空全部
          </button>
        </div>
      </div>

      <div className="indices-body">
        <div className="search-bar" style={{ marginBottom: '1.5rem', display: 'flex', gap: '0.5rem' }}>
          <div className="search-input-wrapper" style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
            <Search size={16} className="search-icon" style={{ position: 'absolute', left: '0.75rem', color: 'var(--text-muted)' }} />
            <input
              type="text"
              value={indicesSearch}
              onChange={e => setIndicesSearch(e.target.value)}
              placeholder="搜索对话标题或关键词..."
              className="search-input"
              style={{ width: '100%', paddingLeft: '2.2rem' }}
              onKeyDown={e => { if (e.key === 'Enter') fetchIndices() }}
            />
            {indicesSearch && (
              <button
                className="search-clear"
                onClick={() => { setIndicesSearch(''); fetchIndices('') }}
                style={{ position: 'absolute', right: '0.5rem', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <button className="btn primary" onClick={() => fetchIndices()} disabled={indicesLoading}>
            <Search size={14} />
            {indicesLoading ? <span>搜索中...</span> : <span>搜索</span>}
          </button>
        </div>

        {indicesLoading && indices.length === 0 ? (
          <div className="loading-state">
            <div className="spinner"></div>
            <p>加载中...</p>
          </div>
        ) : indices.length === 0 ? (
          <div className="empty-state">
            <FileText size={48} className="empty-icon" />
            <h3>暂无对话索引</h3>
            <p>整理器在自动整理时会从对话中提炼检索标题与关键词</p>
          </div>
        ) : (
          <div className="memory-list">
            {indices.map(idx => (
              <div key={idx.id} className="memory-card" style={{ padding: '1rem 1.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <FileText size={16} className="key-icon" style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                      <span className="memory-key" style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>{idx.title || '(无标题)'}</span>
                    </div>
                    {idx.topics.length > 0 && (
                      <div className="memory-tags-preview" style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
                        <Tag size={12} className="tag-icon" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                        {idx.topics.map(t => (
                          <span key={t} className="tag-chip" style={{
                            background: 'rgba(99, 102, 241, 0.08)',
                            border: '1px solid rgba(99, 102, 241, 0.15)',
                            color: '#818CF8',
                            fontSize: '0.72rem',
                            padding: '0.1rem 0.45rem',
                            borderRadius: '4px',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                            whiteSpace: 'nowrap'
                          }}>{t}</span>
                        ))}
                      </div>
                    )}
                    {idx.conversationId && (
                      <div className="memory-meta-row" style={{ marginTop: '0.15rem' }}>
                        <span className="scope-badge" style={{
                          fontSize: '0.7rem',
                          color: 'var(--text-muted)',
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid var(--border-color)',
                          padding: '0.1rem 0.35rem',
                          borderRadius: '4px'
                        }}>会话 ID: {idx.conversationId}</span>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
                    <span className="meta-time" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                      <Clock size={12} /> {formatDate(idx.timestamp)}
                    </span>
                    <button
                      className="btn danger sm"
                      onClick={() => handleDeleteIndex(idx.id)}
                      style={{ padding: '0.25rem 0.5rem' }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <ToastPortal toast={toast} />
    </div>
  )
}
