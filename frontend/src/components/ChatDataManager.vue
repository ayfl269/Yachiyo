<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
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
  AlertTriangle
} from 'lucide-vue-next';

interface Conversation {
  id: string;
  unifiedMsgOrigin: string;
  personaId: string | null;
  history: string;
  platformId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  tokenUsage: number | null;
}

interface ChatMessage {
  role: string;
  content: string;
}

const conversations = ref<Conversation[]>([]);
const totalCount = ref(0);
const currentPage = ref(1);
const pageSize = ref(10);
const searchQuery = ref('');
const isLoadingList = ref(false);
const errorMsg = ref('');

const selectedConvId = ref<string | null>(null);
const selectedConv = ref<Conversation | null>(null);
const messages = ref<ChatMessage[]>([]);
const isLoadingDetails = ref(false);

// ── Edit state ──
const editingIndex = ref<number | null>(null);
const editContent = ref('');
const isSaving = ref(false);
const hasUnsavedChanges = ref(false);

// ── Fetching ──

const fetchConversations = async (page = 1) => {
  isLoadingList.value = true;
  errorMsg.value = '';
  try {
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize.value),
      searchQuery: searchQuery.value
    });
    const res = await fetch(`/api/conversations?${query}`);
    if (!res.ok) throw new Error('获取会话列表失败');
    const data = await res.json();
    conversations.value = data.list;
    totalCount.value = data.total;
    currentPage.value = page;
  } catch (err: any) {
    errorMsg.value = err.message || '加载对话数据失败';
  } finally {
    isLoadingList.value = false;
  }
};

const fetchConversationDetails = async (id: string) => {
  isLoadingDetails.value = true;
  selectedConvId.value = id;
  selectedConv.value = null;
  messages.value = [];
  editingIndex.value = null;
  hasUnsavedChanges.value = false;
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error('获取会话详情失败');
    const data = await res.json();
    selectedConv.value = data;
    try {
      messages.value = JSON.parse(data.history || '[]');
    } catch {
      messages.value = [];
    }
  } catch (err: any) {
    alert(err.message || '加载会话详情失败');
  } finally {
    isLoadingDetails.value = false;
  }
};

const deleteConversation = async (id: string) => {
  if (!confirm('确定要永久删除此对话历史记录吗？')) return;
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('删除会话失败');
    if (selectedConvId.value === id) {
      selectedConvId.value = null;
      selectedConv.value = null;
      messages.value = [];
      hasUnsavedChanges.value = false;
      editingIndex.value = null;
    }
    await fetchConversations(currentPage.value);
  } catch (err: any) {
    alert(err.message);
  }
};

// ── Edit / Delete message ──

const startEdit = (index: number) => {
  editingIndex.value = index;
  editContent.value = messages.value[index].content;
  nextTick(() => {
    const textarea = document.querySelector(`[data-edit-index="${index}"]`) as HTMLTextAreaElement;
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  });
};

const cancelEdit = () => {
  editingIndex.value = null;
  editContent.value = '';
};

const confirmEdit = () => {
  if (editingIndex.value === null) return;
  const trimmed = editContent.value.trimEnd();
  if (!trimmed) {
    if (!confirm('内容为空将删除此条消息，确定吗？')) return;
    messages.value.splice(editingIndex.value, 1);
  } else {
    messages.value[editingIndex.value].content = trimmed;
  }
  hasUnsavedChanges.value = true;
  editingIndex.value = null;
  editContent.value = '';
};

const deleteMessage = (index: number) => {
  if (!confirm(`确定要删除第 ${index + 1} 条消息（${messages.value[index].role === 'user' ? '用户' : '助手'}）？`)) return;
  messages.value.splice(index, 1);
  if (editingIndex.value === index) {
    editingIndex.value = null;
    editContent.value = '';
  } else if (editingIndex.value !== null && editingIndex.value > index) {
    editingIndex.value--;
  }
  hasUnsavedChanges.value = true;
};

const saveAllToServer = async () => {
  if (!selectedConvId.value) return;
  isSaving.value = true;
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(selectedConvId.value)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: messages.value })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '保存失败');
    }
    hasUnsavedChanges.value = false;
  } catch (err: any) {
    alert(err.message || '保存失败');
  } finally {
    isSaving.value = false;
  }
};

const formatTime = (isoString: string) => {
  if (!isoString) return '';
  const date = new Date(isoString);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

watch(searchQuery, () => {
  fetchConversations(1);
});

onMounted(() => {
  fetchConversations(1);
});
</script>

<template>
  <div class="chat-container animate-fade-in">
    <!-- Left Sidebar: Session List -->
    <div class="session-sidebar">
      <div class="sidebar-header">
        <div class="title-row">
          <h3>对话数据</h3>
          <button class="refresh-btn" @click="fetchConversations(currentPage)" :disabled="isLoadingList">
            <RefreshCw :class="{ 'animate-spin': isLoadingList }" class="refresh-icon" />
          </button>
        </div>
        <div class="search-box">
          <Search class="search-icon" />
          <input 
            type="text" 
            v-model="searchQuery" 
            placeholder="搜索标题、消息源 UMO..." 
            class="search-input"
          />
        </div>
      </div>

      <div class="sidebar-body">
        <div v-if="isLoadingList && conversations.length === 0" class="sidebar-loading">
          <div class="spinner"></div>
          <span>加载中...</span>
        </div>

        <div v-else-if="conversations.length === 0" class="sidebar-empty">
          <Inbox class="empty-icon" />
          <span>暂无对话会话</span>
        </div>

        <div v-else class="session-list">
          <div 
            v-for="conv in conversations" 
            :key="conv.id" 
            :class="['session-item', { active: selectedConvId === conv.id }]"
            @click="fetchConversationDetails(conv.id)"
          >
            <div class="session-item-header">
              <span class="session-origin" :title="conv.unifiedMsgOrigin">
                {{ conv.title || conv.unifiedMsgOrigin || '未命名会话' }}
              </span>
              <button class="delete-btn" @click.stop="deleteConversation(conv.id)" title="删除对话">
                <Trash2 class="delete-icon" />
              </button>
            </div>
            
            <div class="session-meta">
              <span class="session-time">
                <Clock class="meta-icon" />
                {{ formatTime(conv.updatedAt) }}
              </span>
              <span class="session-tokens" v-if="conv.tokenUsage">
                <Coins class="meta-icon" />
                {{ conv.tokenUsage }} tokens
              </span>
            </div>
            
            <div class="session-platform-tag" v-if="conv.platformId">
              {{ conv.platformId }}
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div class="sidebar-footer" v-if="totalCount > pageSize">
        <button 
          class="page-btn" 
          :disabled="currentPage === 1" 
          @click="fetchConversations(currentPage - 1)"
        >
          上一页
        </button>
        <span class="page-info">{{ currentPage }} / {{ Math.ceil(totalCount / pageSize) }}</span>
        <button 
          class="page-btn" 
          :disabled="currentPage * pageSize >= totalCount" 
          @click="fetchConversations(currentPage + 1)"
        >
          下一页
        </button>
      </div>
    </div>

    <!-- Right Area: Conversation History -->
    <div class="chat-main">
      <div v-if="isLoadingDetails" class="chat-loading">
        <div class="spinner"></div>
        <span>正在加载对话记录...</span>
      </div>

      <div v-else-if="!selectedConv" class="chat-placeholder">
        <MessageCircle class="placeholder-icon" />
        <h3>选择一个会话</h3>
        <p>在左侧列表中点击任意会话，查看和编辑其消息历史，防止上下文污染。</p>
      </div>

      <div v-else class="chat-thread-container">
        <!-- Thread Header -->
        <div class="thread-header">
          <div class="thread-title-info">
            <h2>{{ selectedConv.title || '对话详情' }}</h2>
            <div class="thread-meta-row">
              <span class="meta-item">
                <strong>消息源 (UMO):</strong> <code>{{ selectedConv.unifiedMsgOrigin }}</code>
              </span>
              <span class="meta-item" v-if="selectedConv.personaId">
                <strong>绑定角色:</strong> <code>{{ selectedConv.personaId }}</code>
              </span>
              <span class="meta-item">
                <strong>创建时间:</strong> {{ formatTime(selectedConv.createdAt) }}
              </span>
              <span class="meta-item">
                <strong>消息数:</strong> {{ messages.length }}
              </span>
            </div>
          </div>
          <div class="thread-actions">
            <div v-if="hasUnsavedChanges" class="unsaved-badge">
              <AlertTriangle class="badge-icon-sm" />
              有未保存的修改
            </div>
            <button 
              class="btn primary save-btn" 
              :disabled="isSaving || !hasUnsavedChanges"
              @click="saveAllToServer"
            >
              <Save class="icon-inline" /> {{ isSaving ? '保存中...' : '保存修改' }}
            </button>
          </div>
        </div>

        <!-- Messages Area -->
        <div class="thread-messages">
          <div v-if="messages.length === 0" class="no-messages">
            <span>该会话暂无历史消息记录</span>
          </div>

          <div 
            v-for="(msg, index) in messages" 
            :key="index" 
            :class="['message-bubble', msg.role === 'user' ? 'user-message' : 'assistant-message']"
          >
            <div class="message-content-wrapper">
              <div class="message-info">
                <span class="msg-index">#{{ index + 1 }}</span>
                <div class="msg-actions">
                  <button 
                    v-if="editingIndex !== index"
                    class="action-btn edit-btn" 
                    title="编辑此消息" 
                    @click="startEdit(index)"
                  >
                    <Pencil class="icon-xs" />
                  </button>
                  <template v-if="editingIndex === index">
                    <button class="action-btn confirm-btn" title="确认编辑" @click="confirmEdit">
                      <Check class="icon-xs" />
                    </button>
                    <button class="action-btn cancel-btn" title="取消编辑" @click="cancelEdit">
                      <X class="icon-xs" />
                    </button>
                  </template>
                  <button 
                    v-if="editingIndex !== index"
                    class="action-btn delete-msg-btn" 
                    title="删除此消息" 
                    @click="deleteMessage(index)"
                  >
                    <Trash2 class="icon-xs" />
                  </button>
                </div>
              </div>

              <!-- Normal view -->
              <div v-if="editingIndex !== index" class="message-text">
                {{ msg.content }}
              </div>

              <!-- Edit mode -->
              <div v-else class="edit-area">
                <textarea
                  :data-edit-index="index"
                  v-model="editContent"
                  class="edit-textarea font-mono"
                  rows="4"
                  placeholder="输入新的消息内容..."
                  @keydown.ctrl.enter="confirmEdit"
                  @keydown.meta.enter="confirmEdit"
                  @keydown.escape="cancelEdit"
                ></textarea>
                <div class="edit-hint">
                  <kbd>Ctrl+Enter</kbd> 确认 &nbsp; <kbd>Esc</kbd> 取消 &nbsp; 清空则删除该消息
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-container {
  display: flex;
  height: calc(100vh - 64px - 5rem);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  backdrop-filter: var(--glass-blur);
}

/* Left Sidebar */
.session-sidebar {
  width: 320px;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
}

body.light-theme .session-sidebar {
  background: rgba(15, 23, 42, 0.02);
}

.sidebar-header {
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.title-row h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.refresh-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 4px;
}
.refresh-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.refresh-icon { width: 16px; height: 16px; }

.search-box {
  display: flex;
  align-items: center;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}

.search-icon { width: 16px; height: 16px; color: var(--text-muted); margin-right: 0.5rem; }

.search-input {
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 0.85rem;
  outline: none;
  width: 100%;
}
body.light-theme .search-input { color: #0F172A !important; }

.sidebar-body { flex-grow: 1; overflow-y: auto; }

.sidebar-loading, .sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
  color: var(--text-muted);
  gap: 0.75rem;
  font-size: 0.9rem;
}

.empty-icon { width: 32px; height: 32px; }

.session-list { display: flex; flex-direction: column; }

.session-item {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}
.session-item:hover { background: rgba(255, 255, 255, 0.02); }
.session-item.active {
  background: rgba(99, 102, 241, 0.1);
  border-left: 3px solid var(--accent-primary);
}

.session-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.4rem;
}

.session-origin {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 80%;
}

.delete-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.2rem;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.2s, color 0.2s;
}
.session-item:hover .delete-btn { opacity: 1; }
.delete-btn:hover { color: var(--accent-danger); background: rgba(239, 68, 68, 0.1); }
.delete-icon { width: 14px; height: 14px; }

.session-meta { display: flex; gap: 0.75rem; font-size: 0.75rem; color: var(--text-muted); }
.session-time, .session-tokens { display: inline-flex; align-items: center; gap: 0.25rem; }
.meta-icon { width: 12px; height: 12px; }

.session-platform-tag {
  position: absolute;
  right: 1.25rem;
  bottom: 0.6rem;
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-muted);
}

.sidebar-footer {
  padding: 0.75rem;
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(17, 17, 19, 0.2);
}

.page-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  font-size: 0.8rem;
  cursor: pointer;
}
.page-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); color: var(--text-primary); }
.page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.page-info { font-size: 0.8rem; color: var(--text-muted); }

/* Right Chat Area */
.chat-main { flex-grow: 1; display: flex; flex-direction: column; background: rgba(17, 17, 19, 0.15); }
body.light-theme .chat-main { background: rgba(15, 23, 42, 0.01); }

.chat-loading, .chat-placeholder {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  gap: 1rem;
  padding: 2rem;
}

.placeholder-icon { width: 48px; height: 48px; color: var(--text-muted); margin-bottom: 0.5rem; }
.chat-placeholder h3 { font-size: 1.2rem; color: var(--text-primary); }
.chat-placeholder p { font-size: 0.9rem; max-width: 380px; text-align: center; color: var(--text-muted); line-height: 1.5; }

.spinner {
  width: 24px; height: 24px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-left-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.chat-thread-container { display: flex; flex-direction: column; height: 100%; }

/* Thread Header */
.thread-header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
  background: rgba(17, 17, 19, 0.3);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}

.thread-title-info h2 { font-size: 1.2rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.35rem; }
.thread-meta-row { display: flex; flex-wrap: wrap; gap: 1rem; font-size: 0.78rem; color: var(--text-secondary); }
.meta-item code { font-family: monospace; background: rgba(255, 255, 255, 0.05); padding: 0.1rem 0.3rem; border-radius: 4px; color: var(--accent-primary); }

.thread-actions { display: flex; align-items: center; gap: 0.65rem; flex-shrink: 0; }

.unsaved-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.78rem;
  font-weight: 500;
  color: #F59E0B;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.2);
  padding: 0.28rem 0.6rem;
  border-radius: 20px;
  animation: pulse-badge 2s ease-in-out infinite;
}
.badge-icon-sm { width: 13px; height: 13px; }
@keyframes pulse-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.45rem 0.85rem;
  font-size: 0.82rem;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease-in-out;
}
.btn.primary { background: var(--accent-primary); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-primary-hover); }
.btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.icon-inline { width: 14px; height: 14px; flex-shrink: 0; }
.save-btn { white-space: nowrap; }

/* Messages */
.thread-messages {
  flex-grow: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.no-messages { text-align: center; color: var(--text-muted); font-size: 0.9rem; padding: 3rem; }

/* Message Bubbles */
.message-bubble {
  display: flex;
  gap: 1rem;
  max-width: 85%;
  align-self: flex-start;
  position: relative;
  transition: box-shadow 0.2s ease;
}
.message-bubble:hover { border-radius: 12px; }

.user-message { align-self: flex-end; flex-direction: row-reverse; }

.message-sender-avatar {
  width: 36px; height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.avatar-icon { width: 18px; height: 18px; }
.text-indigo { color: var(--accent-primary); }
.text-emerald { color: var(--accent-success); }

.message-content-wrapper { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }

.message-info {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}
.user-message .message-info { flex-direction: row-reverse; }
.sender-name { font-weight: 550; }
.msg-index { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.68rem; color: var(--text-muted); opacity: 0.6; }

.msg-actions {
  display: flex;
  gap: 0.15rem;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.message-bubble:hover .msg-actions { opacity: 1; }

.action-btn {
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  padding: 0.22rem;
  border-radius: 4px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  transition: all 0.15s ease;
}
.action-btn:hover { background: rgba(255, 255, 255, 0.06); color: var(--text-primary); }
.action-btn.edit-btn:hover { color: #818CF8; background: rgba(99, 102, 241, 0.1); border-color: rgba(99, 102, 241, 0.2); }
.action-btn.confirm-btn:hover { color: #34D399; background: rgba(52, 211, 153, 0.1); border-color: rgba(52, 211, 153, 0.2); }
.action-btn.cancel-btn:hover { color: #FCA5A5; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); }
.action-btn.delete-msg-btn:hover { color: #FB7185; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); }
.icon-xs { width: 13px; height: 13px; }

.message-text {
  padding: 0.85rem 1.1rem;
  border-radius: 12px;
  font-size: 0.95rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.user-message .message-text {
  background: linear-gradient(135deg, var(--accent-primary) 0%, #4f46e5 100%);
  color: #fff;
  border-top-right-radius: 2px;
}

.assistant-message .message-text {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  border-top-left-radius: 2px;
  border: 1px solid var(--border-color);
}
body.light-theme .assistant-message .message-text {
  background: #FFFFFF;
  color: #0F172A !important;
  border-color: rgba(15, 23, 42, 0.12);
}

/* Edit Mode */
.edit-area {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.edit-textarea {
  width: 100%;
  padding: 0.75rem 1rem;
  border-radius: 10px;
  font-size: 0.92rem;
  line-height: 1.55;
  resize: vertical;
  min-height: 80px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.user-message .edit-textarea {
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.4);
  color: #fff;
}
.user-message .edit-textarea::placeholder { color: rgba(255, 255, 255, 0.4); }
.user-message .edit-textarea:focus {
  border-color: var(--accent-primary);
  outline: none;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
}

.assistant-message .edit-textarea {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--accent-primary);
  color: var(--text-primary);
}
.assistant-message .edit-textarea:focus {
  border-color: var(--accent-primary);
  outline: none;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
}
body.light-theme .assistant-message .edit-textarea {
  background: #FFF;
  color: #0F172A;
  border-color: #6366f1;
}

.edit-hint {
  font-size: 0.72rem;
  color: var(--text-muted);
  text-align: right;
  user-select: none;
}
.edit-hint kbd {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 0 0.3rem;
  font-size: 0.68rem;
  font-family: ui-monospace, SFMono-Regular, monospace;
}
</style>
