<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  Plus, X, Trash2, Search, Brain, Clock, Tag, Save,
  CheckCircle, AlertCircle, ChevronDown, ChevronUp, Key,
  FileText, Hash, RefreshCw, Layers, Zap, Settings, BarChart3
} from 'lucide-vue-next'

// ===== Types =====
type MemoryType = 'short_term' | 'long_term' | 'persona' | 'user_profile'
type MemoryScope = 'global' | 'persona' | 'user' | 'session'

interface MemoryEntry {
  key: string
  value: string
  tags: string[]
  memoryType: MemoryType
  scope: MemoryScope
  scopeId: string
  priority: number
  accessCount: number
  lastAccessedAt: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

interface MemoryStats {
  total: number
  byType: Record<MemoryType, number>
  byScope: Record<MemoryScope, number>
}

interface ConsolidationConfig {
  interval: string
  enabled: boolean
  agingAccessThreshold: number
  agingMaxAgeDays: number
  promoteOnSessionEnd: boolean
  shortTermMaxAgeMs: number
  maxMemoryLength: number
  maxRetries: number
  bufferMinMessages: number
}

// ===== State =====
const memories = ref<MemoryEntry[]>([])
const total = ref(0)
const loading = ref(true)
const searchQuery = ref('')
const searching = ref(false)
const filterType = ref<MemoryType | ''>('')
const stats = ref<MemoryStats | null>(null)
const consolidating = ref(false)
const consolidationConfig = ref<ConsolidationConfig | null>(null)

// Detail view
const expandedKey = ref<string | null>(null)

// Create/Edit dialog
const showModal = ref(false)
const isEditing = ref(false)
const editingMemory = ref<{
  key: string; value: string; tags: string;
  memoryType: MemoryType; scope: MemoryScope; scopeId: string; priority: number;
} | null>(null)
const saving = ref(false)

// Delete confirm dialog
const showDeleteConfirm = ref(false)
const deleteTarget = ref<{ key: string } | null>(null)

// Clear confirm dialog
const showClearConfirm = ref(false)
const clearing = ref(false)

// Consolidation result dialog
const showConsolidationResult = ref(false)
const consolidationResult = ref<any>(null)

// Toast
const toast = ref({ show: false, message: '', color: 'success' })
let toastTimer: number | null = null

function showMessage(message: string, color = 'success') {
  toast.value = { show: true, message, color }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value.show = false }, 3000)
}

// ===== Memory Type Labels =====
const memoryTypeLabels: Record<MemoryType, string> = {
  short_term: '短期记忆',
  long_term: '长期记忆',
  persona: '角色记忆',
  user_profile: '用户资料',
}

const memoryTypeColors: Record<MemoryType, string> = {
  short_term: '#F59E0B',
  long_term: '#10B981',
  persona: '#8B5CF6',
  user_profile: '#3B82F6',
}

const scopeLabels: Record<MemoryScope, string> = {
  global: '全局',
  persona: '角色',
  user: '用户',
  session: '会话',
}

// ===== Computed =====
const displayMemories = computed(() => memories.value)

// ===== API =====
async function fetchMemories() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    params.set('limit', '200')
    if (searchQuery.value.trim()) {
      params.set('search', searchQuery.value.trim())
    }
    if (filterType.value) {
      params.set('memory_type', filterType.value)
    }
    const res = await fetch(`/api/memories?${params}`)
    if (res.ok) {
      const data = await res.json()
      memories.value = data.memories || []
      total.value = data.total || 0
    }
  } catch (error) {
    console.error('获取记忆列表失败:', error)
    showMessage('获取记忆列表失败', 'error')
  } finally {
    loading.value = false
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/memories/stats')
    if (res.ok) {
      stats.value = await res.json()
    }
  } catch (error) {
    console.error('获取记忆统计失败:', error)
  }
}

async function fetchConsolidationConfig() {
  try {
    const res = await fetch('/api/memories/consolidation-config')
    if (res.ok) {
      consolidationConfig.value = await res.json()
    }
  } catch (error) {
    console.error('获取整理配置失败:', error)
  }
}

async function handleSearch() {
  searching.value = true
  try {
    await fetchMemories()
  } finally {
    searching.value = false
  }
}

function clearSearch() {
  searchQuery.value = ''
  fetchMemories()
}

function handleFilterType(type: MemoryType | '') {
  filterType.value = type
  fetchMemories()
}

// ===== Actions =====
function handleCreate() {
  isEditing.value = false
  editingMemory.value = {
    key: '', value: '', tags: '',
    memoryType: 'long_term', scope: 'global', scopeId: '', priority: 0,
  }
  showModal.value = true
}

function handleEdit(memory: MemoryEntry) {
  isEditing.value = true
  editingMemory.value = {
    key: memory.key,
    value: memory.value,
    tags: memory.tags.join(', '),
    memoryType: memory.memoryType,
    scope: memory.scope,
    scopeId: memory.scopeId,
    priority: memory.priority,
  }
  showModal.value = true
}

async function handleSave() {
  if (!editingMemory.value) return
  if (!editingMemory.value.key.trim()) {
    showMessage('Key 不能为空', 'error')
    return
  }

  saving.value = true
  try {
    const tags = editingMemory.value.tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)

    const res = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: editingMemory.value.key.trim(),
        value: editingMemory.value.value,
        tags,
        memory_type: editingMemory.value.memoryType,
        scope: editingMemory.value.scope,
        scope_id: editingMemory.value.scopeId,
        priority: editingMemory.value.priority,
      })
    })

    if (res.ok) {
      const data = await res.json()
      if (data.success) {
        showModal.value = false
        editingMemory.value = null
        showMessage(isEditing.value ? '记忆已更新' : '记忆已创建')
        await fetchMemories()
        await fetchStats()
      } else {
        showMessage(data.error || '操作失败', 'error')
      }
    } else {
      showMessage('操作失败', 'error')
    }
  } catch (error) {
    console.error('保存记忆失败:', error)
    showMessage('保存记忆失败', 'error')
  } finally {
    saving.value = false
  }
}

function confirmDelete(key: string) {
  deleteTarget.value = { key }
  showDeleteConfirm.value = true
}

async function handleDelete() {
  if (!deleteTarget.value) return
  try {
    const res = await fetch(`/api/memories/${encodeURIComponent(deleteTarget.value.key)}`, {
      method: 'DELETE'
    })
    if (res.ok) {
      const data = await res.json()
      if (data.success) {
        showMessage('记忆已删除')
        if (expandedKey.value === deleteTarget.value.key) {
          expandedKey.value = null
        }
        await fetchMemories()
        await fetchStats()
      } else {
        showMessage('删除失败', 'error')
      }
    }
  } catch (error) {
    console.error('删除记忆失败:', error)
    showMessage('删除记忆失败', 'error')
  } finally {
    showDeleteConfirm.value = false
    deleteTarget.value = null
  }
}

function confirmClear() {
  showClearConfirm.value = true
}

async function handleClear() {
  clearing.value = true
  try {
    const res = await fetch('/api/memories/clear', { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      if (data.success) {
        showMessage(`已清空 ${data.deletedCount} 条记忆`)
        expandedKey.value = null
        await fetchMemories()
        await fetchStats()
      } else {
        showMessage('清空失败', 'error')
      }
    }
  } catch (error) {
    console.error('清空记忆失败:', error)
    showMessage('清空记忆失败', 'error')
  } finally {
    clearing.value = false
    showClearConfirm.value = false
  }
}

async function handleConsolidate() {
  consolidating.value = true
  try {
    const res = await fetch('/api/memories/consolidate', { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      if (data.success) {
        consolidationResult.value = data.result
        showConsolidationResult.value = true
        showMessage('记忆整理完成')
        await fetchMemories()
        await fetchStats()
      } else {
        showMessage(data.error || '整理失败', 'error')
      }
    }
  } catch (error) {
    console.error('记忆整理失败:', error)
    showMessage('记忆整理失败', 'error')
  } finally {
    consolidating.value = false
  }
}

function toggleExpand(key: string) {
  expandedKey.value = expandedKey.value === key ? null : key
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString('zh-CN')
  } catch {
    return dateStr
  }
}

function truncateValue(value: string, maxLen: number = 120): string {
  if (value.length <= maxLen) return value
  return value.slice(0, maxLen) + '...'
}

// ===== Lifecycle =====
onMounted(() => {
  fetchMemories()
  fetchStats()
  fetchConsolidationConfig()
})
</script>

<template>
  <div class="memory-page animate-fade-in">
    <!-- Page Header -->
    <div class="page-header">
      <div>
        <h1>记忆管理</h1>
        <p>分层记忆架构：短期/长期/角色/用户资料，支持自动整理与老化机制。</p>
      </div>
      <div class="header-actions">
        <button class="btn" @click="fetchMemories(); fetchStats()" :disabled="loading" title="刷新">
          <RefreshCw :size="16" :class="{ 'animate-spin': loading }" />
        </button>
        <button class="btn accent" @click="handleConsolidate" :disabled="consolidating" title="手动整理记忆">
          <Zap :size="16" />
          <span v-if="consolidating">整理中...</span>
          <span v-else>整理记忆</span>
        </button>
        <button class="btn danger" @click="confirmClear" :disabled="memories.length === 0">
          <Trash2 :size="16" /> 清空全部
        </button>
        <button class="btn primary" @click="handleCreate">
          <Plus :size="16" /> 新建记忆
        </button>
      </div>
    </div>

    <!-- Stats Bar -->
    <div v-if="stats" class="stats-panel">
      <div class="stat-card total">
        <BarChart3 :size="18" />
        <div class="stat-info">
          <span class="stat-value">{{ stats.total }}</span>
          <span class="stat-label">总记忆数</span>
        </div>
      </div>
      <div
        v-for="(label, type) in memoryTypeLabels"
        :key="type"
        :class="['stat-card', 'type-card', { active: filterType === type }]"
        @click="handleFilterType(filterType === type ? '' : type as MemoryType)"
      >
        <div class="type-dot" :style="{ background: memoryTypeColors[type as MemoryType] }"></div>
        <div class="stat-info">
          <span class="stat-value">{{ stats.byType[type as MemoryType] ?? 0 }}</span>
          <span class="stat-label">{{ label }}</span>
        </div>
      </div>
    </div>

    <!-- Search Bar -->
    <div class="search-bar">
      <div class="search-input-wrapper">
        <Search :size="16" class="search-icon" />
        <input
          type="text"
          v-model="searchQuery"
          placeholder="搜索记忆内容、Key 或标签..."
          class="search-input"
          @keydown.enter="handleSearch"
        />
        <button v-if="searchQuery" class="search-clear" @click="clearSearch">
          <X :size="14" />
        </button>
      </div>
      <button class="btn primary" @click="handleSearch" :disabled="searching">
        <Search :size="14" />
        <span v-if="searching">搜索中...</span>
        <span v-else>搜索</span>
      </button>
      <button v-if="filterType" class="btn" @click="handleFilterType('')">
        <X :size="14" /> 清除筛选
      </button>
    </div>

    <!-- Consolidation Config -->
    <div v-if="consolidationConfig" class="consolidation-info">
      <Settings :size="14" />
      <span>自动整理: {{ consolidationConfig.enabled ? '已启用' : '已禁用' }}</span>
      <span class="sep">|</span>
      <span>间隔: {{ consolidationConfig.interval }}</span>
      <span class="sep">|</span>
      <span>老化阈值: {{ consolidationConfig.agingMaxAgeDays }}天 / 访问<{{ consolidationConfig.agingAccessThreshold }}</span>
      <span class="sep">|</span>
      <span>记忆长度限制: {{ consolidationConfig.maxMemoryLength }}字</span>
      <span class="sep">|</span>
      <span>失败重试: {{ consolidationConfig.maxRetries }}次</span>
      <span class="sep">|</span>
      <span>缓冲区阈值: {{ consolidationConfig.bufferMinMessages }}条</span>
    </div>

    <!-- Loading -->
    <div v-if="loading && memories.length === 0" class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- Memory List -->
    <div v-else class="memory-list">
      <div
        v-for="memory in displayMemories"
        :key="memory.key"
        :class="['memory-card', { expanded: expandedKey === memory.key }]"
      >
        <div class="memory-card-header" @click="toggleExpand(memory.key)">
          <div class="memory-main-info">
            <div class="memory-key-row">
              <span
                class="type-badge"
                :style="{ background: memoryTypeColors[memory.memoryType] + '20', color: memoryTypeColors[memory.memoryType], borderColor: memoryTypeColors[memory.memoryType] + '40' }"
              >
                {{ memoryTypeLabels[memory.memoryType] }}
              </span>
              <Key :size="14" class="key-icon" />
              <span class="memory-key">{{ memory.key }}</span>
            </div>
            <div class="memory-value-preview">
              {{ truncateValue(memory.value) }}
            </div>
            <div class="memory-meta-row">
              <span v-if="memory.tags.length > 0" class="memory-tags-preview">
                <Tag :size="12" class="tag-icon" />
                <span v-for="tag in memory.tags.slice(0, 3)" :key="tag" class="tag-chip">{{ tag }}</span>
                <span v-if="memory.tags.length > 3" class="tag-more">+{{ memory.tags.length - 3 }}</span>
              </span>
              <span class="scope-badge">{{ scopeLabels[memory.scope] }}{{ memory.scopeId ? `/${memory.scopeId.slice(0, 8)}` : '' }}</span>
              <span v-if="memory.priority > 0" class="priority-badge">P{{ memory.priority }}</span>
            </div>
          </div>
          <div class="memory-meta">
            <span class="meta-time"><Clock :size="12" /> {{ formatDate(memory.updatedAt) }}</span>
            <span class="meta-access">访问 {{ memory.accessCount }} 次</span>
            <component :is="expandedKey === memory.key ? ChevronUp : ChevronDown" :size="16" class="expand-icon" />
          </div>
        </div>

        <!-- Expanded Detail -->
        <div v-if="expandedKey === memory.key" class="memory-detail">
          <div class="detail-section">
            <div class="detail-label"><Key :size="14" /> Key</div>
            <div class="detail-value font-mono">{{ memory.key }}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label"><FileText :size="14" /> Value</div>
            <pre class="detail-value content-block">{{ memory.value }}</pre>
          </div>
          <div class="detail-section inline">
            <div class="detail-row">
              <span class="detail-label-sm"><Layers :size="12" /> 类型</span>
              <span class="detail-value-sm">{{ memoryTypeLabels[memory.memoryType] }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label-sm"><Hash :size="12" /> 作用域</span>
              <span class="detail-value-sm">{{ scopeLabels[memory.scope] }}{{ memory.scopeId ? ` / ${memory.scopeId}` : '' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label-sm">优先级</span>
              <span class="detail-value-sm">{{ memory.priority }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label-sm">访问次数</span>
              <span class="detail-value-sm">{{ memory.accessCount }}</span>
            </div>
          </div>
          <div class="detail-section">
            <div class="detail-label"><Tag :size="14" /> Tags</div>
            <div class="detail-value">
              <div v-if="memory.tags.length > 0" class="tags-list">
                <span v-for="tag in memory.tags" :key="tag" class="tag-chip">{{ tag }}</span>
              </div>
              <span v-else class="no-tags">无标签</span>
            </div>
          </div>
          <div class="detail-section inline">
            <div class="detail-row">
              <span class="detail-label-sm"><Clock :size="12" /> 创建时间</span>
              <span class="detail-value-sm">{{ formatDate(memory.createdAt) }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label-sm"><Clock :size="12" /> 更新时间</span>
              <span class="detail-value-sm">{{ formatDate(memory.updatedAt) }}</span>
            </div>
            <div v-if="memory.lastAccessedAt" class="detail-row">
              <span class="detail-label-sm"><Clock :size="12" /> 最后访问</span>
              <span class="detail-value-sm">{{ formatDate(memory.lastAccessedAt) }}</span>
            </div>
            <div v-if="memory.expiresAt" class="detail-row">
              <span class="detail-label-sm">过期时间</span>
              <span class="detail-value-sm">{{ formatDate(memory.expiresAt) }}</span>
            </div>
          </div>
          <div class="detail-actions">
            <button class="btn sm" @click="handleEdit(memory)">
              编辑
            </button>
            <button class="btn danger sm" @click="confirmDelete(memory.key)">
              <Trash2 :size="14" /> 删除
            </button>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div v-if="memories.length === 0 && !loading" class="empty-state">
        <Brain :size="48" class="empty-icon" />
        <h3>{{ searchQuery || filterType ? '未找到匹配的记忆' : '暂无记忆' }}</h3>
        <p>{{ searchQuery || filterType ? '尝试调整搜索关键词或筛选条件' : 'Agent 在对话中会自动保存记忆，你也可以手动创建。' }}</p>
        <button v-if="!searchQuery && !filterType" class="btn primary" @click="handleCreate">
          <Plus :size="16" /> 创建第一条记忆
        </button>
        <button v-else class="btn" @click="searchQuery = ''; filterType = ''; fetchMemories()">
          清除筛选
        </button>
      </div>
    </div>

    <!-- ===== Create/Edit Modal ===== -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-backdrop" @click="showModal = false">
        <div class="modal-content" @click.stop>
          <div class="modal-header">
            <h3>{{ isEditing ? '编辑记忆' : '新建记忆' }}</h3>
            <button class="close-btn" @click="showModal = false"><X :size="20" /></button>
          </div>
          <div class="modal-body" v-if="editingMemory">
            <div class="form-group">
              <label>Key <span class="required">*</span></label>
              <input
                type="text"
                v-model="editingMemory.key"
                placeholder="记忆的唯一标识，例如: user_preference_theme"
                class="form-control"
                :disabled="isEditing"
              />
              <span class="help-text">Key 是记忆的唯一标识，创建后不可修改</span>
            </div>
            <div class="form-group">
              <label>Value</label>
              <textarea
                v-model="editingMemory.value"
                placeholder="记忆内容..."
                class="form-control content-textarea"
                rows="5"
              ></textarea>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>记忆类型</label>
                <select v-model="editingMemory.memoryType" class="form-control">
                  <option value="short_term">短期记忆</option>
                  <option value="long_term">长期记忆</option>
                  <option value="persona">角色记忆</option>
                  <option value="user_profile">用户资料</option>
                </select>
              </div>
              <div class="form-group">
                <label>作用域</label>
                <select v-model="editingMemory.scope" class="form-control">
                  <option value="global">全局</option>
                  <option value="persona">角色</option>
                  <option value="user">用户</option>
                  <option value="session">会话</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>作用域 ID</label>
                <input
                  type="text"
                  v-model="editingMemory.scopeId"
                  placeholder="可选，如 Persona ID"
                  class="form-control"
                />
              </div>
              <div class="form-group">
                <label>优先级 (0-10)</label>
                <input
                  type="number"
                  v-model.number="editingMemory.priority"
                  min="0"
                  max="10"
                  class="form-control"
                />
              </div>
            </div>
            <div class="form-group">
              <label>Tags</label>
              <input
                type="text"
                v-model="editingMemory.tags"
                placeholder="标签，用逗号分隔，例如: 偏好, 主题, UI"
                class="form-control"
              />
              <span class="help-text">用逗号分隔多个标签，方便分类和检索</span>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showModal = false">取消</button>
            <button class="btn primary" :disabled="saving || !editingMemory?.key.trim()" @click="handleSave">
              <div v-if="saving" class="btn-loading">
                <div class="spinner mini white"></div>
                <span>保存中...</span>
              </div>
              <template v-else>
                <Save :size="14" /> {{ isEditing ? '保存修改' : '创建记忆' }}
              </template>
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
              <p>确定要删除记忆 <strong>"{{ deleteTarget?.key }}"</strong> 吗？</p>
              <p class="confirm-warn">此操作不可撤销。</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showDeleteConfirm = false">取消</button>
            <button class="btn danger" @click="handleDelete">确认删除</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== Clear Confirm Modal ===== -->
    <Teleport to="body">
      <div v-if="showClearConfirm" class="modal-backdrop" @click="showClearConfirm = false">
        <div class="modal-content modal-sm" @click.stop>
          <div class="modal-header">
            <h3>确认清空</h3>
            <button class="close-btn" @click="showClearConfirm = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="confirm-content">
              <AlertCircle :size="32" class="confirm-icon danger" />
              <p>确定要清空所有 <strong>{{ total }} 条</strong> 记忆吗？</p>
              <p class="confirm-warn">此操作将不可逆地删除所有记忆数据！</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showClearConfirm = false">取消</button>
            <button class="btn danger" :disabled="clearing" @click="handleClear">
              <div v-if="clearing" class="btn-loading">
                <div class="spinner mini white"></div>
                <span>清空中...</span>
              </div>
              <template v-else>确认清空</template>
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== Consolidation Result Modal ===== -->
    <Teleport to="body">
      <div v-if="showConsolidationResult" class="modal-backdrop" @click="showConsolidationResult = false">
        <div class="modal-content modal-sm" @click.stop>
          <div class="modal-header">
            <h3>记忆整理结果</h3>
            <button class="close-btn" @click="showConsolidationResult = false"><X :size="20" /></button>
          </div>
          <div class="modal-body" v-if="consolidationResult">
            <div class="consolidation-result">
              <div v-if="consolidationResult.extractionFailed" class="result-item">
                <AlertCircle :size="16" class="result-icon warning" />
                <span>LLM 提取失败，短期缓冲区已保留等待下次重试</span>
              </div>
              <div class="result-item">
                <CheckCircle :size="16" class="result-icon success" />
                <span>提取新记忆: <strong>{{ consolidationResult.extracted }}</strong> 条</span>
              </div>
              <div class="result-item">
                <CheckCircle :size="16" class="result-icon success" />
                <span>合并重复: <strong>{{ consolidationResult.merged }}</strong> 条</span>
              </div>
              <div class="result-item">
                <CheckCircle :size="16" class="result-icon success" />
                <span>过期清理: <strong>{{ consolidationResult.expired }}</strong> 条</span>
              </div>
              <div class="result-item">
                <CheckCircle :size="16" class="result-icon success" />
                <span>老化降权: <strong>{{ consolidationResult.aged?.demoted ?? 0 }}</strong> 条</span>
              </div>
              <div class="result-item">
                <CheckCircle :size="16" class="result-icon success" />
                <span>老化归档: <strong>{{ consolidationResult.aged?.archived ?? 0 }}</strong> 条</span>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn primary" @click="showConsolidationResult = false">确定</button>
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
.memory-page {
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

.header-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
  flex-wrap: wrap;
}

/* ===== Stats Panel ===== */
.stats-panel {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  backdrop-filter: var(--glass-blur);
}

.stat-card.total {
  border-color: rgba(99, 102, 241, 0.3);
  background: rgba(99, 102, 241, 0.08);
}

.stat-card.type-card {
  cursor: pointer;
  transition: all 0.15s ease;
}

.stat-card.type-card:hover {
  border-color: var(--border-color-hover);
}

.stat-card.type-card.active {
  border-color: rgba(99, 102, 241, 0.5);
  background: rgba(99, 102, 241, 0.12);
}

.type-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.stat-info {
  display: flex;
  flex-direction: column;
}

.stat-value {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-label {
  font-size: 0.72rem;
  color: var(--text-muted);
}

/* ===== Search Bar ===== */
.search-bar {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

.search-input-wrapper {
  flex: 1;
  min-width: 200px;
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 0.8rem;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.6rem 2.2rem 0.6rem 2.2rem;
  color: var(--text-primary);
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s ease;
}

.search-input:focus {
  border-color: var(--accent-primary);
}

.search-clear {
  position: absolute;
  right: 0.5rem;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}

.search-clear:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.05);
}

/* ===== Consolidation Info ===== */
.consolidation-info {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  flex-wrap: wrap;
}

.consolidation-info .sep {
  color: var(--border-color);
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

.animate-spin {
  animation: spin 1s linear infinite;
}

/* ===== Memory List ===== */
.memory-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.memory-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  backdrop-filter: var(--glass-blur);
  overflow: hidden;
  transition: all 0.2s ease;
}

.memory-card:hover {
  border-color: var(--border-color-hover);
}

.memory-card.expanded {
  border-color: rgba(99, 102, 241, 0.3);
}

.memory-card-header {
  padding: 1rem 1.25rem;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  cursor: pointer;
  transition: background 0.15s;
}

.memory-card-header:hover {
  background: rgba(255, 255, 255, 0.02);
}

.memory-main-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.memory-key-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.type-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  border: 1px solid;
  white-space: nowrap;
}

.key-icon {
  color: var(--accent-primary);
  flex-shrink: 0;
}

.memory-key {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}

.memory-value-preview {
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.memory-meta-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.15rem;
}

.memory-tags-preview {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.tag-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.tag-chip {
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.15);
  color: #818CF8;
  font-size: 0.72rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: nowrap;
}

.tag-more {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.scope-badge {
  font-size: 0.7rem;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-color);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}

.priority-badge {
  font-size: 0.7rem;
  font-weight: 600;
  color: #F59E0B;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.2);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}

.memory-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.3rem;
  flex-shrink: 0;
}

.meta-time {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.meta-access {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.expand-icon {
  color: var(--text-muted);
  transition: color 0.15s;
}

.memory-card-header:hover .expand-icon {
  color: var(--text-primary);
}

/* ===== Memory Detail ===== */
.memory-detail {
  padding: 0 1.25rem 1.25rem;
  border-top: 1px solid var(--border-color);
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.detail-section {
  margin-top: 1rem;
}

.detail-section.inline {
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;
}

.detail-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.35rem;
}

.detail-value {
  font-size: 0.9rem;
  color: var(--text-primary);
}

.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.content-block {
  background: rgba(0, 0, 0, 0.15);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  font-size: 0.85rem;
  line-height: 1.5;
}

body.light-theme .content-block {
  background: rgba(0, 0, 0, 0.03);
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.no-tags {
  font-size: 0.85rem;
  color: var(--text-muted);
  font-style: italic;
}

.detail-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.detail-label-sm {
  font-size: 0.8rem;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.detail-value-sm {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.detail-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border-color);
}

/* ===== Empty State ===== */
.empty-state {
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

/* ===== Form Shared ===== */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.form-row {
  display: flex;
  gap: 1rem;
}

.form-row .form-group {
  flex: 1;
}

.form-group label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.required {
  color: var(--accent-danger);
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

select.form-control {
  appearance: auto;
}

textarea.form-control {
  resize: vertical;
}

.content-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.85rem;
  line-height: 1.4;
}

.help-text {
  font-size: 0.75rem;
  color: var(--text-muted);
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
  white-space: nowrap;
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

.btn.accent {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
  color: #F59E0B;
}

.btn.accent:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.2);
  border-color: rgba(245, 158, 11, 0.4);
}

.btn.danger {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #FB7185;
}

.btn.danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.4);
}

.btn.danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  border-radius: 6px;
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

/* ===== Confirm ===== */
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

/* ===== Consolidation Result ===== */
.consolidation-result {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.result-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: var(--text-primary);
}

.result-icon.success {
  color: var(--accent-success);
  flex-shrink: 0;
}

.result-icon.warning {
  color: #F59E0B;
  flex-shrink: 0;
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
