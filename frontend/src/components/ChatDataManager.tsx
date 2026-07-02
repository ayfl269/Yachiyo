import { useEffect, useRef, useState } from 'react'
import {
  MessageCircle,
  Trash2,
  Search,
  Clock,
  Coins,
  RefreshCw,
  Inbox,
  Pencil,
  Check,
  X,
  Save,
  AlertTriangle,
} from 'lucide-react'
import { useToast, ToastPortal } from './shared'

interface Conversation {
  id: string
  unifiedMsgOrigin: string
  personaId: string | null
  history: string
  platformId: string
  title: string
  createdAt: string
  updatedAt: string
  tokenUsage: number | null
}

interface ChatMessage {
  id: string
  role: string
  content: string
}

function formatTime(isoString: string): string {
  if (!isoString) return ''
  const date = new Date(isoString)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function ChatDataManager() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize] = useState(10)
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoadingList, setIsLoadingList] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const [selectedConvId, setSelectedConvId] = useState<string | null>(null)
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoadingDetails, setIsLoadingDetails] = useState(false)

  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editContent, setEditContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  const editTextareaRef = useRef<HTMLTextAreaElement>(null)
  const { toast, showMessage } = useToast()

  // ── Fetching ──

  const fetchConversations = async (page = 1) => {
    setIsLoadingList(true)
    setErrorMsg('')
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        searchQuery,
      })
      const res = await fetch(`/api/conversations?${query}`)
      if (!res.ok) throw new Error('获取会话列表失败')
      const data = await res.json()
      setConversations(data.list)
      setTotalCount(data.total)
      setCurrentPage(page)
    } catch (err) {
      setErrorMsg((err as Error).message || '加载对话数据失败')
    } finally {
      setIsLoadingList(false)
    }
  }

  const fetchConversationDetails = async (id: string) => {
    setIsLoadingDetails(true)
    setSelectedConvId(id)
    setSelectedConv(null)
    setMessages([])
    setEditingIndex(null)
    setHasUnsavedChanges(false)
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`)
      if (!res.ok) throw new Error('获取会话详情失败')
      const data = await res.json()
      setSelectedConv(data)
      try {
        const parsed = JSON.parse(data.history || '[]') as Array<
          Omit<ChatMessage, 'id'>
        >
        setMessages(
          parsed.map((msg, i) => ({ ...msg, id: `msg-${i}` })),
        )
      } catch {
        setMessages([])
      }
    } catch (err) {
      showMessage((err as Error).message || '加载会话详情失败', 'error')
    } finally {
      setIsLoadingDetails(false)
    }
  }

  const deleteConversation = async (id: string) => {
    if (!confirm('确定要永久删除此对话历史记录吗？')) return
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('删除会话失败')
      if (selectedConvId === id) {
        setSelectedConvId(null)
        setSelectedConv(null)
        setMessages([])
        setHasUnsavedChanges(false)
        setEditingIndex(null)
      }
      await fetchConversations(currentPage)
    } catch (err) {
      showMessage((err as Error).message, 'error')
    }
  }

  // ── Edit / Delete message ──

  const startEdit = (index: number) => {
    setEditingIndex(index)
    setEditContent(messages[index].content)
  }

  // Focus textarea when entering edit mode (replaces Vue's nextTick)
  useEffect(() => {
    if (editingIndex !== null && editTextareaRef.current) {
      editTextareaRef.current.focus()
      editTextareaRef.current.setSelectionRange(
        editTextareaRef.current.value.length,
        editTextareaRef.current.value.length,
      )
    }
  }, [editingIndex])

  const cancelEdit = () => {
    setEditingIndex(null)
    setEditContent('')
  }

  const confirmEdit = () => {
    if (editingIndex === null) return
    const trimmed = editContent.trimEnd()
    if (!trimmed) {
      if (!confirm('内容为空将删除此条消息，确定吗？')) return
      setMessages(prev => prev.filter((_, i) => i !== editingIndex))
    } else {
      setMessages(prev =>
        prev.map((m, i) => (i === editingIndex ? { ...m, content: trimmed } : m)),
      )
    }
    setHasUnsavedChanges(true)
    setEditingIndex(null)
    setEditContent('')
  }

  const deleteMessage = (index: number) => {
    if (
      !confirm(
        `确定要删除第 ${index + 1} 条消息（${messages[index].role === 'user' ? '用户' : '助手'}）？`,
      )
    )
      return
    setMessages(prev => prev.filter((_, i) => i !== index))
    if (editingIndex === index) {
      setEditingIndex(null)
      setEditContent('')
    } else if (editingIndex !== null && editingIndex > index) {
      setEditingIndex(editingIndex - 1)
    }
    setHasUnsavedChanges(true)
  }

  const saveAllToServer = async () => {
    if (!selectedConvId) return
    setIsSaving(true)
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(selectedConvId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history: messages.map(m => ({ role: m.role, content: m.content })),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '保存失败')
      }
      setHasUnsavedChanges(false)
    } catch (err) {
      showMessage((err as Error).message || '保存失败', 'error')
    } finally {
      setIsSaving(false)
    }
  }

  // Combined onMounted + watch(searchQuery): fires on mount and when searchQuery changes
  useEffect(() => {
    fetchConversations(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  return (
    <div className="chat-container animate-fade-in">
      {/* Left Sidebar: Session List */}
      <div className="session-sidebar">
        <div className="sidebar-header">
          <div className="title-row">
            <h3>对话数据</h3>
            <button
              className="refresh-btn"
              onClick={() => fetchConversations(currentPage)}
              disabled={isLoadingList}
            >
              <RefreshCw className={`refresh-icon${isLoadingList ? ' animate-spin' : ''}`} />
            </button>
          </div>
          <p className="sidebar-subtitle">查看和管理历史会话记录</p>
          <div className="search-box">
            <Search className="search-icon" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="搜索标题、消息源 UMO..."
              className="sidebar-search-input"
            />
          </div>
        </div>

        <div className="sidebar-body">
          {isLoadingList && conversations.length === 0 ? (
            <div className="sidebar-loading">
              <div className="spinner"></div>
              <span>加载中...</span>
            </div>
          ) : errorMsg && conversations.length === 0 ? (
            <div className="error-state">
              <AlertTriangle className="empty-icon" />
              <p>{errorMsg}</p>
              <button
                onClick={() => {
                  setErrorMsg('')
                  fetchConversations(currentPage)
                }}
              >
                重试
              </button>
            </div>
          ) : conversations.length === 0 ? (
            <div className="sidebar-empty">
              <Inbox className="empty-icon" />
              <span>暂无对话会话</span>
            </div>
          ) : (
            <div className="session-list">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`session-item${selectedConvId === conv.id ? ' active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => fetchConversationDetails(conv.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      fetchConversationDetails(conv.id)
                    }
                  }}
                >
                  <div className="session-item-header">
                    <span className="session-origin" title={conv.unifiedMsgOrigin}>
                      {conv.title || conv.unifiedMsgOrigin || '未命名会话'}
                    </span>
                    <button
                      className="delete-btn"
                      onClick={e => {
                        e.stopPropagation()
                        deleteConversation(conv.id)
                      }}
                      title="删除对话"
                    >
                      <Trash2 className="delete-icon" />
                    </button>
                  </div>

                  <div className="session-meta">
                    <span className="session-time">
                      <Clock className="meta-icon" />
                      {formatTime(conv.updatedAt)}
                    </span>
                    {conv.tokenUsage && (
                      <span className="session-tokens">
                        <Coins className="meta-icon" />
                        {conv.tokenUsage} tokens
                      </span>
                    )}
                  </div>

                  {conv.platformId && (
                    <div className="session-platform-tag">{conv.platformId}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalCount > pageSize && (
          <div className="sidebar-footer">
            <button
              className="page-btn"
              disabled={currentPage === 1}
              onClick={() => fetchConversations(currentPage - 1)}
            >
              上一页
            </button>
            <span className="page-info">
              {currentPage} / {Math.ceil(totalCount / pageSize)}
            </span>
            <button
              className="page-btn"
              disabled={currentPage * pageSize >= totalCount}
              onClick={() => fetchConversations(currentPage + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* Right Area: Conversation History */}
      <div className="chat-main">
        {isLoadingDetails ? (
          <div className="chat-loading">
            <div className="spinner"></div>
            <span>正在加载对话记录...</span>
          </div>
        ) : !selectedConv ? (
          <div className="chat-placeholder">
            <MessageCircle className="placeholder-icon" />
            <h3>选择一个会话</h3>
            <p>在左侧列表中点击任意会话，查看和编辑其消息历史，防止上下文污染。</p>
          </div>
        ) : (
          <div className="chat-thread-container">
            {/* Thread Header */}
            <div className="thread-header">
              <div className="thread-title-info">
                <h2>{selectedConv.title || '对话详情'}</h2>
                <div className="thread-meta-row">
                  <span className="meta-item">
                    <strong>消息源 (UMO):</strong> <code>{selectedConv.unifiedMsgOrigin}</code>
                  </span>
                  {selectedConv.personaId && (
                    <span className="meta-item">
                      <strong>绑定角色:</strong> <code>{selectedConv.personaId}</code>
                    </span>
                  )}
                  <span className="meta-item">
                    <strong>创建时间:</strong> {formatTime(selectedConv.createdAt)}
                  </span>
                  <span className="meta-item">
                    <strong>消息数:</strong> {messages.length}
                  </span>
                </div>
              </div>
              <div className="thread-actions">
                {hasUnsavedChanges && (
                  <div className="unsaved-badge">
                    <AlertTriangle className="badge-icon-sm" />
                    有未保存的修改
                  </div>
                )}
                <button
                  className="btn primary save-btn"
                  disabled={isSaving || !hasUnsavedChanges}
                  onClick={saveAllToServer}
                >
                  <Save className="icon-inline" /> {isSaving ? '保存中...' : '保存修改'}
                </button>
              </div>
            </div>

            {/* Messages Area */}
            <div className="thread-messages">
              {messages.length === 0 ? (
                <div className="no-messages">
                  <span>该会话暂无历史消息记录</span>
                </div>
              ) : (
                messages.map((msg, index) => (
                  <div
                    key={msg.id}
                    className={`message-bubble ${msg.role === 'user' ? 'user-message' : 'assistant-message'}`}
                  >
                    <div className="message-content-wrapper">
                      <div className="message-info">
                        <span className="msg-index">#{index + 1}</span>
                        <div className="msg-actions">
                          {editingIndex !== index && (
                            <button
                              className="action-btn edit-btn"
                              title="编辑此消息"
                              onClick={() => startEdit(index)}
                            >
                              <Pencil className="icon-xs" />
                            </button>
                          )}
                          {editingIndex === index && (
                            <>
                              <button
                                className="action-btn confirm-btn"
                                title="确认编辑"
                                onClick={confirmEdit}
                              >
                                <Check className="icon-xs" />
                              </button>
                              <button
                                className="action-btn cancel-btn"
                                title="取消编辑"
                                onClick={cancelEdit}
                              >
                                <X className="icon-xs" />
                              </button>
                            </>
                          )}
                          {editingIndex !== index && (
                            <button
                              className="action-btn delete-msg-btn"
                              title="删除此消息"
                              onClick={() => deleteMessage(index)}
                            >
                              <Trash2 className="icon-xs" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Normal view */}
                      {editingIndex !== index ? (
                        <div className="message-text">{msg.content}</div>
                      ) : (
                        /* Edit mode */
                        <div className="edit-area">
                          <textarea
                            ref={editTextareaRef}
                            data-edit-index={index}
                            value={editContent}
                            onChange={e => setEditContent(e.target.value)}
                            className="edit-textarea font-mono"
                            rows={4}
                            placeholder="输入新的消息内容..."
                            onKeyDown={e => {
                              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') confirmEdit()
                              if (e.key === 'Escape') cancelEdit()
                            }}
                          />
                          <div className="edit-hint">
                            <kbd>Ctrl+Enter</kbd> 确认 &nbsp; <kbd>Esc</kbd> 取消 &nbsp; 清空则删除该消息
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <ToastPortal toast={toast} />
    </div>
  )
}
