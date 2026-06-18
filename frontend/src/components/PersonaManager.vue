<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  Plus, X, Search, Pencil, Trash2, Eye, Sparkles,
  MessageSquare, Smile, Wrench, BookOpen, AlertCircle,
  User, FileText, Zap
} from 'lucide-vue-next'

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

// ===== State =====
const personas = ref<Persona[]>([])
const loading = ref(true)
const searchQuery = ref('')

// Tools & Skills from API
const availableTools = ref<ToolItem[]>([])
const availableSkills = ref<SkillItem[]>([])
const toolsLoaded = ref(false)
const skillsLoaded = ref(false)

// Modal states
const showModal = ref(false)
const isNew = ref(false)
const activeFormTab = ref<'basic' | 'dialogs' | 'capabilities'>('basic')
const editingPersona = ref<Persona | null>(null)

// Detail modal
const showDetailModal = ref(false)
const detailPersona = ref<Persona | null>(null)

// Delete confirm modal
const showDeleteModal = ref(false)
const deleteTarget = ref<{ id: string; name: string } | null>(null)

// Capabilities mode
const toolsMode = ref<'all' | 'selected'>('all')
const skillsMode = ref<'all' | 'selected'>('all')
const toolSearch = ref('')
const skillSearch = ref('')

// Custom ID toggle
const showCustomId = ref(false)

// Toast
const toast = ref({ show: false, message: '', color: 'success' })
let toastTimer: number | null = null

function showMessage(message: string, color = 'success') {
  toast.value = { show: true, message, color }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value.show = false }, 3000)
}

// ===== Helpers =====
function slugifyName(name: string): string {
  return name.trim()
    .toLowerCase()
    .replace(/[\s]+/g, '_')
    .replace(/[^\w\u4e00-\u9fff]/g, '')
}

function onNameInput() {
  if (!editingPersona.value) return
  if (isNew.value && !showCustomId.value) {
    editingPersona.value.id = slugifyName(editingPersona.value.name)
  }
}

// ===== Computed =====
const filteredPersonas = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return personas.value
  return personas.value.filter(p =>
    p.id.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    p.prompt.toLowerCase().includes(q)
  )
})

const filteredAvailableTools = computed(() => {
  const q = toolSearch.value.trim().toLowerCase()
  if (!q) return availableTools.value
  return availableTools.value.filter(t =>
    t.name.toLowerCase().includes(q) ||
    (t.description && t.description.toLowerCase().includes(q))
  )
})

const filteredAvailableSkills = computed(() => {
  const q = skillSearch.value.trim().toLowerCase()
  if (!q) return availableSkills.value
  return availableSkills.value.filter(s =>
    s.name.toLowerCase().includes(q) ||
    (s.description && s.description.toLowerCase().includes(q))
  )
})

// ===== API =====
async function fetchPersonas() {
  loading.value = true
  try {
    const res = await fetch('/api/personas')
    if (res.ok) {
      personas.value = await res.json()
    }
  } catch (error) {
    console.error('获取设定列表失败:', error)
    showMessage('获取设定列表失败', 'error')
  } finally {
    loading.value = false
  }
}

async function fetchTools() {
  try {
    const res = await fetch('/api/tools/list')
    if (res.ok) {
      const data = await res.json()
      availableTools.value = Array.isArray(data)
        ? data.map((t: any) => typeof t === 'string' ? { name: t } : { name: t.name, description: t.description })
        : []
    }
  } catch (error) {
    console.error('获取工具列表失败:', error)
  } finally {
    toolsLoaded.value = true
  }
}

async function fetchSkills() {
  try {
    const res = await fetch('/api/skills')
    if (res.ok) {
      const data = await res.json()
      availableSkills.value = Array.isArray(data)
        ? data.map((s: any) => typeof s === 'string' ? { name: s } : { name: s.name, description: s.description })
        : []
    }
  } catch (error) {
    console.error('获取技能列表失败:', error)
  } finally {
    skillsLoaded.value = true
  }
}

// ===== Actions =====
function handleCreate() {
  isNew.value = true
  showCustomId.value = false
  editingPersona.value = {
    id: '',
    name: '',
    prompt: '',
    beginDialogs: [],
    moodImitationDialogs: [],
    tools: null,
    skills: null,
    customErrorMessage: null
  }
  toolsMode.value = 'all'
  skillsMode.value = 'all'
  activeFormTab.value = 'basic'
  showModal.value = true
  fetchTools()
  fetchSkills()
}

function handleEdit(persona: Persona) {
  isNew.value = false
  editingPersona.value = JSON.parse(JSON.stringify(persona))
  toolsMode.value = persona.tools === null ? 'all' : 'selected'
  skillsMode.value = persona.skills === null ? 'all' : 'selected'
  activeFormTab.value = 'basic'
  showModal.value = true
  fetchTools()
  fetchSkills()
}

function handleViewDetail(persona: Persona) {
  detailPersona.value = persona
  showDetailModal.value = true
}

function confirmDelete(id: string, name: string) {
  deleteTarget.value = { id, name }
  showDeleteModal.value = true
}

async function executeDelete() {
  if (!deleteTarget.value) return
  try {
    const res = await fetch(`/api/personas/${deleteTarget.value.id}`, { method: 'DELETE' })
    if (res.ok) {
      showMessage(`角色 "${deleteTarget.value.name}" 已删除`)
      showDeleteModal.value = false
      deleteTarget.value = null
      await fetchPersonas()
    } else {
      showMessage('删除失败', 'error')
    }
  } catch (error) {
    console.error('删除角色失败:', error)
    showMessage('删除失败', 'error')
  }
}

async function handleSave() {
  if (!editingPersona.value) return
  const p = editingPersona.value

  if (!p.name.trim()) { showMessage('角色名称不能为空', 'error'); return }
  if (!p.id.trim()) { p.id = slugifyName(p.name) }
  if (!p.id.trim()) { showMessage('角色 ID 不能为空', 'error'); return }
  if (!p.prompt.trim()) { showMessage('系统提示词不能为空', 'error'); return }

  // Apply tools/skills mode
  if (toolsMode.value === 'all') {
    p.tools = null
  } else if (p.tools && p.tools.length === 0) {
    p.tools = null
  }
  if (skillsMode.value === 'all') {
    p.skills = null
  } else if (p.skills && p.skills.length === 0) {
    p.skills = null
  }

  try {
    const url = isNew.value ? '/api/personas' : '/api/personas/update'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    })
    if (res.ok) {
      showMessage(isNew.value ? '设定创建成功' : '设定更新成功')
      showModal.value = false
      editingPersona.value = null
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

// ===== BeginDialogs helpers (paired: user/AI) =====
function addBeginDialogPair() {
  if (!editingPersona.value) return
  editingPersona.value.beginDialogs.push('', '')
}

function removeBeginDialogPair(index: number) {
  if (!editingPersona.value) return
  // Remove the pair at pairIndex
  const pairIndex = Math.floor(index / 2) * 2
  editingPersona.value.beginDialogs.splice(pairIndex, 2)
}

function getBeginDialogPairs(): Array<{ user: string; ai: string; userIndex: number; aiIndex: number }> {
  if (!editingPersona.value) return []
  const pairs: Array<{ user: string; ai: string; userIndex: number; aiIndex: number }> = []
  const arr = editingPersona.value.beginDialogs
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

// ===== Tool/Skill toggle helpers =====
function isToolSelected(toolName: string): boolean {
  if (!editingPersona.value?.tools) return false
  return editingPersona.value.tools.includes(toolName)
}

function toggleTool(toolName: string) {
  if (!editingPersona.value) return
  if (!editingPersona.value.tools) {
    editingPersona.value.tools = []
  }
  const idx = editingPersona.value.tools.indexOf(toolName)
  if (idx >= 0) {
    editingPersona.value.tools.splice(idx, 1)
  } else {
    editingPersona.value.tools.push(toolName)
  }
}

function isSkillSelected(skillName: string): boolean {
  if (!editingPersona.value?.skills) return false
  return editingPersona.value.skills.includes(skillName)
}

function toggleSkill(skillName: string) {
  if (!editingPersona.value) return
  if (!editingPersona.value.skills) {
    editingPersona.value.skills = []
  }
  const idx = editingPersona.value.skills.indexOf(skillName)
  if (idx >= 0) {
    editingPersona.value.skills.splice(idx, 1)
  } else {
    editingPersona.value.skills.push(skillName)
  }
}

function onToolsModeChange(mode: 'all' | 'selected') {
  toolsMode.value = mode
  if (mode === 'all' && editingPersona.value) {
    editingPersona.value.tools = null
  } else if (mode === 'selected' && editingPersona.value && editingPersona.value.tools === null) {
    editingPersona.value.tools = []
  }
}

function onSkillsModeChange(mode: 'all' | 'selected') {
  skillsMode.value = mode
  if (mode === 'all' && editingPersona.value) {
    editingPersona.value.skills = null
  } else if (mode === 'selected' && editingPersona.value && editingPersona.value.skills === null) {
    editingPersona.value.skills = []
  }
}

// ===== Detail helpers =====
function getDetailDialogPairs(persona: Persona): Array<{ user: string; ai: string }> {
  const pairs: Array<{ user: string; ai: string }> = []
  for (let i = 0; i < persona.beginDialogs.length; i += 2) {
    pairs.push({
      user: persona.beginDialogs[i] || '',
      ai: persona.beginDialogs[i + 1] || ''
    })
  }
  return pairs
}

/*
function getToolDisplayName(name: string): string {
  const tool = availableTools.value.find(t => t.name === name)
  return tool?.description ? `${name} - ${tool.description}` : name
}

function getSkillDisplayName(name: string): string {
  const skill = availableSkills.value.find(s => s.name === name)
  return skill?.description ? `${name} - ${skill.description}` : name
}
*/

onMounted(fetchPersonas)
</script>

<template>
  <div class="persona-page animate-fade-in">
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1>角色设定</h1>
        <p>管理助理的个性化 Prompt、开场对话、工具与技能权限，赋予助理独特的语气和专业领域知识。</p>
      </div>
      <button class="btn primary" @click="handleCreate">
        <Plus :size="16" /> 添加设定
      </button>
    </div>

    <!-- Search Bar -->
    <div class="search-bar">
      <Search :size="16" class="search-icon" />
      <input
        type="text"
        v-model="searchQuery"
        placeholder="搜索角色 ID、名称或提示词..."
        class="form-control"
      />
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- Persona Grid -->
    <template v-else>
      <div v-if="filteredPersonas.length > 0" class="personas-grid">
        <div v-for="persona in filteredPersonas" :key="persona.id" class="persona-card">
          <div class="card-header">
            <div class="title-info">
              <div class="name-row">
                <Sparkles :size="16" class="accent-icon" />
                <h3>{{ persona.name }}</h3>
                <span class="id-badge font-mono">{{ persona.id }}</span>
              </div>
              <p class="prompt-preview">{{ persona.prompt }}</p>
            </div>
          </div>

          <div class="card-body">
            <div class="tags-area">
              <div class="tag-group">
                <MessageSquare :size="12" class="tag-group-icon" />
                <span class="tag-label">{{ persona.beginDialogs.length }} 条预设对话</span>
              </div>
              <div class="tag-group">
                <Smile :size="12" class="tag-group-icon" />
                <span class="tag-label">{{ persona.moodImitationDialogs.length }} 条语气模仿</span>
              </div>
              <div class="tag-group">
                <Wrench :size="12" class="tag-group-icon tool-icon" />
                <span class="tag-label">{{ persona.tools ? persona.tools.length + ' 工具' : '全部工具' }}</span>
              </div>
              <div class="tag-group">
                <BookOpen :size="12" class="tag-group-icon skill-icon" />
                <span class="tag-label">{{ persona.skills ? persona.skills.length + ' 技能' : '全部技能' }}</span>
              </div>
            </div>
          </div>

          <div class="card-footer">
            <button class="btn sm" @click="handleViewDetail(persona)" title="查看详情">
              <Eye :size="14" /> 详情
            </button>
            <button class="btn sm" @click="handleEdit(persona)" title="编辑">
              <Pencil :size="14" /> 编辑
            </button>
            <button class="btn sm danger" @click="confirmDelete(persona.id, persona.name)" title="删除">
              <Trash2 :size="14" /> 删除
            </button>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div v-else class="empty-state">
        <User :size="48" class="empty-icon" />
        <h3>{{ searchQuery ? '没有匹配的角色设定' : '暂无角色设定' }}</h3>
        <p>{{ searchQuery ? '尝试调整搜索关键词' : '创建自定义角色设定，赋予系统智能不同的交互灵魂。' }}</p>
        <button v-if="!searchQuery" class="btn primary" @click="handleCreate">
          <Plus :size="16" /> 创建第一个角色设定
        </button>
      </div>
    </template>

    <!-- Create/Edit Modal -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-backdrop" @click="showModal = false">
        <div class="modal-content modal-lg" @click.stop>
          <div class="modal-header">
            <h3>{{ isNew ? '创建新设定' : '编辑设定' }}</h3>
            <button class="close-btn" @click="showModal = false"><X :size="20" /></button>
          </div>

          <!-- Tabs -->
          <div class="form-tabs">
            <button
              :class="['form-tab', { active: activeFormTab === 'basic' }]"
              @click="activeFormTab = 'basic'"
            >
              <FileText :size="14" /> 基本信息
            </button>
            <button
              :class="['form-tab', { active: activeFormTab === 'dialogs' }]"
              @click="activeFormTab = 'dialogs'"
            >
              <MessageSquare :size="14" /> 预设对话
            </button>
            <button
              :class="['form-tab', { active: activeFormTab === 'capabilities' }]"
              @click="activeFormTab = 'capabilities'"
            >
              <Zap :size="14" /> 能力配置
            </button>
          </div>

          <div class="modal-body">
            <!-- Basic Tab -->
            <div v-if="activeFormTab === 'basic'" class="tab-panel">
              <div class="form-grid">
                <div class="form-group">
                  <label>名称 <span class="required">*</span></label>
                  <input
                    type="text"
                    v-model="editingPersona!.name"
                    placeholder="例如: 智能助理, 资深架构师"
                    class="form-control"
                    @input="onNameInput"
                  />
                </div>

                <div v-if="!isNew" class="form-group">
                  <label>角色 ID</label>
                  <input
                    type="text"
                    :value="editingPersona!.id"
                    class="form-control font-mono"
                    disabled
                  />
                  <span class="help-text">唯一标识符，创建后不可修改</span>
                </div>
                <div v-else class="form-group">
                  <label>角色 ID</label>
                  <div v-if="showCustomId">
                    <input
                      type="text"
                      v-model="editingPersona!.id"
                      placeholder="自定义角色 ID"
                      class="form-control font-mono"
                    />
                    <span class="help-text">留空则自动从名称生成</span>
                  </div>
                  <div v-else class="id-inline-row">
                    <span class="help-text">ID: <code class="font-mono">{{ editingPersona!.id || '(将自动生成)' }}</code></span>
                    <button class="btn sm link-btn" @click="showCustomId = true">自定义</button>
                  </div>
                </div>
              </div>

              <div class="form-group">
                <label>系统提示词 <span class="required">*</span></label>
                <textarea
                  v-model="editingPersona!.prompt"
                  placeholder="你是一个经验丰富的高级软件工程师，在回答用户提问时总是使用简洁的语气..."
                  rows="10"
                  class="form-control"
                ></textarea>
                <span class="help-text">发送给模型的核心 System Prompt</span>
              </div>

              <div class="form-group">
                <label>自定义错误消息 <span class="optional">(可选)</span></label>
                <input
                  type="text"
                  v-model="editingPersona!.customErrorMessage"
                  placeholder="例如: 抱歉，我的思考链路在处理此请求时发生了中断，请稍后再试。"
                  class="form-control"
                />
                <span class="help-text">当模型服务发生异常时，对用户的友好应答</span>
              </div>
            </div>

            <!-- Dialogs Tab -->
            <div v-if="activeFormTab === 'dialogs'" class="tab-panel">
              <div class="section-block">
                <div class="section-block-header">
                  <div>
                    <h4>开场预设对话 (Begin Dialogs)</h4>
                    <p class="section-desc">成对的用户/AI 消息，偶数行为用户消息，奇数行为 AI 回复</p>
                  </div>
                  <button class="btn sm" @click="addBeginDialogPair">
                    <Plus :size="14" /> 添加对话对
                  </button>
                </div>

                <div v-if="getBeginDialogPairs().length > 0" class="dialog-pairs">
                  <div v-for="(pair, idx) in getBeginDialogPairs()" :key="idx" class="dialog-pair">
                    <div class="dialog-pair-header">
                      <span class="dialog-pair-index">对话对 #{{ idx + 1 }}</span>
                      <button class="btn sm danger-text" @click="removeBeginDialogPair(pair.userIndex)">
                        <Trash2 :size="12" /> 删除
                      </button>
                    </div>
                    <div class="dialog-pair-body">
                      <div class="form-group">
                        <label class="dialog-label user-label">
                          <User :size="12" /> 用户消息
                        </label>
                        <textarea
                          v-model="editingPersona!.beginDialogs[pair.userIndex]"
                          placeholder="用户说的话..."
                          rows="2"
                          class="form-control"
                        ></textarea>
                      </div>
                      <div class="form-group">
                        <label class="dialog-label ai-label">
                          <Sparkles :size="12" /> AI 回复
                        </label>
                        <textarea
                          v-model="editingPersona!.beginDialogs[pair.aiIndex]"
                          placeholder="AI 的回复..."
                          rows="2"
                          class="form-control"
                        ></textarea>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-else class="empty-hint">
                  <MessageSquare :size="24" class="empty-hint-icon" />
                  <p>暂无预设对话，点击上方按钮添加</p>
                </div>
              </div>

              <div class="section-block">
                <div class="section-block-header">
                  <div>
                    <h4>语气模仿对话 (Mood Imitation Dialogs)</h4>
                    <p class="section-desc">供 few-shot 语气参考的对话片段</p>
                  </div>
                </div>

                <div v-if="editingPersona!.moodImitationDialogs.length > 0" class="dialog-items">
                  <div v-for="(item, idx) in editingPersona!.moodImitationDialogs" :key="idx" class="dialog-item-row">
                    <span class="dialog-item-text">{{ item }}</span>
                    <button class="icon-btn danger" @click="editingPersona!.moodImitationDialogs.splice(idx, 1)">
                      <X :size="14" />
                    </button>
                  </div>
                </div>
                <div v-else class="empty-hint small">
                  <p>暂无语气模仿对话</p>
                </div>

                <div class="add-item-row">
                  <input
                    type="text"
                    placeholder="添加语气模仿示例..."
                    class="form-control"
                    @keyup.enter="($event: KeyboardEvent) => {
                      const input = $event.target as HTMLInputElement
                      if (input.value.trim() && editingPersona) {
                        editingPersona.moodImitationDialogs.push(input.value.trim())
                        input.value = ''
                      }
                    }"
                  />
                </div>
              </div>
            </div>

            <!-- Capabilities Tab -->
            <div v-if="activeFormTab === 'capabilities'" class="tab-panel">
              <!-- Tools -->
              <div class="section-block">
                <div class="section-block-header">
                  <h4>工具权限</h4>
                </div>

                <div class="mode-switch">
                  <label class="mode-option" :class="{ checked: toolsMode === 'all' }">
                    <input type="radio" name="toolsMode" :checked="toolsMode === 'all'" @change="onToolsModeChange('all')" class="sr-only" />
                    <span class="radio-indicator"></span>
                    <span class="mode-label">全部工具</span>
                    <span class="mode-desc">不限制，可使用所有工具</span>
                  </label>
                  <label class="mode-option" :class="{ checked: toolsMode === 'selected' }">
                    <input type="radio" name="toolsMode" :checked="toolsMode === 'selected'" @change="onToolsModeChange('selected')" class="sr-only" />
                    <span class="radio-indicator"></span>
                    <span class="mode-label">指定工具</span>
                    <span class="mode-desc">仅允许使用选中的工具</span>
                  </label>
                </div>

                <div v-if="toolsMode === 'selected'" class="selection-panel">
                  <div class="search-box">
                    <Search :size="14" class="search-icon" />
                    <input type="text" v-model="toolSearch" placeholder="搜索工具..." class="form-control sm" />
                  </div>
                  <div class="check-list">
                    <label
                      v-for="tool in filteredAvailableTools"
                      :key="tool.name"
                      class="check-item"
                    >
                      <input
                        type="checkbox"
                        :checked="isToolSelected(tool.name)"
                        @change="toggleTool(tool.name)"
                      />
                      <span class="check-item-name font-mono">{{ tool.name }}</span>
                      <span v-if="tool.description" class="check-item-desc">{{ tool.description }}</span>
                    </label>
                    <div v-if="filteredAvailableTools.length === 0" class="check-empty">
                      {{ toolsLoaded ? '没有可用的工具' : '加载中...' }}
                    </div>
                  </div>
                  <div v-if="editingPersona!.tools && editingPersona!.tools.length > 0" class="selected-tags">
                    <span class="selected-count">已选 {{ editingPersona!.tools.length }} 项</span>
                    <span v-for="name in editingPersona!.tools" :key="name" class="tag tool-tag">
                      {{ name }}
                      <X :size="10" class="tag-remove" @click="toggleTool(name)" />
                    </span>
                  </div>
                </div>
              </div>

              <!-- Skills -->
              <div class="section-block">
                <div class="section-block-header">
                  <h4>技能权限</h4>
                </div>

                <div class="mode-switch">
                  <label class="mode-option" :class="{ checked: skillsMode === 'all' }">
                    <input type="radio" name="skillsMode" :checked="skillsMode === 'all'" @change="onSkillsModeChange('all')" class="sr-only" />
                    <span class="radio-indicator"></span>
                    <span class="mode-label">全部技能</span>
                    <span class="mode-desc">不限制，可使用所有技能</span>
                  </label>
                  <label class="mode-option" :class="{ checked: skillsMode === 'selected' }">
                    <input type="radio" name="skillsMode" :checked="skillsMode === 'selected'" @change="onSkillsModeChange('selected')" class="sr-only" />
                    <span class="radio-indicator"></span>
                    <span class="mode-label">指定技能</span>
                    <span class="mode-desc">仅允许使用选中的技能</span>
                  </label>
                </div>

                <div v-if="skillsMode === 'selected'" class="selection-panel">
                  <div class="search-box">
                    <Search :size="14" class="search-icon" />
                    <input type="text" v-model="skillSearch" placeholder="搜索技能..." class="form-control sm" />
                  </div>
                  <div class="check-list">
                    <label
                      v-for="skill in filteredAvailableSkills"
                      :key="skill.name"
                      class="check-item"
                    >
                      <input
                        type="checkbox"
                        :checked="isSkillSelected(skill.name)"
                        @change="toggleSkill(skill.name)"
                      />
                      <span class="check-item-name font-mono">{{ skill.name }}</span>
                      <span v-if="skill.description" class="check-item-desc">{{ skill.description }}</span>
                    </label>
                    <div v-if="filteredAvailableSkills.length === 0" class="check-empty">
                      {{ skillsLoaded ? '没有可用的技能' : '加载中...' }}
                    </div>
                  </div>
                  <div v-if="editingPersona!.skills && editingPersona!.skills.length > 0" class="selected-tags">
                    <span class="selected-count">已选 {{ editingPersona!.skills.length }} 项</span>
                    <span v-for="name in editingPersona!.skills" :key="name" class="tag skill-tag">
                      {{ name }}
                      <X :size="10" class="tag-remove" @click="toggleSkill(name)" />
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn" @click="showModal = false">取消</button>
            <button class="btn primary" @click="handleSave">
              {{ isNew ? '创建' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Detail Modal -->
    <Teleport to="body">
      <div v-if="showDetailModal" class="modal-backdrop" @click="showDetailModal = false">
        <div class="modal-content modal-lg" @click.stop>
          <div class="modal-header">
            <h3>{{ detailPersona?.name }} — 详情</h3>
            <button class="close-btn" @click="showDetailModal = false"><X :size="20" /></button>
          </div>
          <div class="modal-body" v-if="detailPersona">
            <!-- Basic Info -->
            <div class="detail-section">
              <div class="detail-section-title">
                <FileText :size="16" /> 基本信息
              </div>
              <div class="detail-grid">
                <div class="detail-field">
                  <span class="detail-label">ID</span>
                  <span class="detail-value font-mono">{{ detailPersona.id }}</span>
                </div>
                <div class="detail-field">
                  <span class="detail-label">名称</span>
                  <span class="detail-value">{{ detailPersona.name }}</span>
                </div>
              </div>
              <div class="detail-field full">
                <span class="detail-label">系统提示词</span>
                <div class="detail-prompt">{{ detailPersona.prompt }}</div>
              </div>
              <div v-if="detailPersona.customErrorMessage" class="detail-field full">
                <span class="detail-label">自定义错误消息</span>
                <div class="detail-error-msg">{{ detailPersona.customErrorMessage }}</div>
              </div>
            </div>

            <!-- Dialogs -->
            <div class="detail-section">
              <div class="detail-section-title">
                <MessageSquare :size="16" /> 预设对话
              </div>
              <div v-if="getDetailDialogPairs(detailPersona).length > 0" class="detail-dialogs">
                <div v-for="(pair, idx) in getDetailDialogPairs(detailPersona)" :key="idx" class="detail-dialog-pair">
                  <div class="detail-dialog-bubble user-bubble">
                    <User :size="12" /> {{ pair.user || '(空)' }}
                  </div>
                  <div class="detail-dialog-bubble ai-bubble">
                    <Sparkles :size="12" /> {{ pair.ai || '(空)' }}
                  </div>
                </div>
              </div>
              <div v-else class="detail-empty">暂无预设对话</div>

              <div v-if="detailPersona.moodImitationDialogs.length > 0" style="margin-top: 1rem;">
                <span class="detail-label">语气模仿对话</span>
                <div class="detail-mood-items">
                  <div v-for="(item, idx) in detailPersona.moodImitationDialogs" :key="idx" class="detail-mood-item">
                    {{ item }}
                  </div>
                </div>
              </div>
            </div>

            <!-- Tools & Skills -->
            <div class="detail-section">
              <div class="detail-section-title">
                <Zap :size="16" /> 能力配置
              </div>
              <div class="detail-grid">
                <div class="detail-field">
                  <span class="detail-label">工具</span>
                  <span class="detail-value">
                    <template v-if="detailPersona.tools === null">全部工具</template>
                    <template v-else>
                      <span v-for="t in detailPersona.tools" :key="t" class="tag tool-tag">{{ t }}</span>
                      <span v-if="detailPersona.tools.length === 0" class="muted">无</span>
                    </template>
                  </span>
                </div>
                <div class="detail-field">
                  <span class="detail-label">技能</span>
                  <span class="detail-value">
                    <template v-if="detailPersona.skills === null">全部技能</template>
                    <template v-else>
                      <span v-for="s in detailPersona.skills" :key="s" class="tag skill-tag">{{ s }}</span>
                      <span v-if="detailPersona.skills.length === 0" class="muted">无</span>
                    </template>
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showDetailModal = false">关闭</button>
            <button class="btn primary" @click="showDetailModal = false; handleEdit(detailPersona!)">
              <Pencil :size="14" /> 编辑
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Confirm Modal -->
    <Teleport to="body">
      <div v-if="showDeleteModal" class="modal-backdrop" @click="showDeleteModal = false">
        <div class="modal-content modal-sm" @click.stop>
          <div class="modal-header">
            <h3>确认删除</h3>
            <button class="close-btn" @click="showDeleteModal = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="delete-confirm-content">
              <AlertCircle :size="32" class="delete-warn-icon" />
              <p>确定要删设定 <strong>{{ deleteTarget?.name }}</strong> (ID: <code class="font-mono">{{ deleteTarget?.id }}</code>) 吗？</p>
              <p class="delete-sub">此操作不可撤销</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showDeleteModal = false">取消</button>
            <button class="btn danger" @click="executeDelete">确认删除</button>
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
.persona-page {
  max-width: 1600px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
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

@media (max-width: 600px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }
}

/* Search */
.search-bar {
  position: relative;
  margin-bottom: 1.5rem;
}

.search-bar .search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

.search-bar .form-control {
  padding-left: 36px;
}

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

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Grid */
.personas-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 1.5rem;
}

@media (max-width: 480px) {
  .personas-grid {
    grid-template-columns: 1fr;
  }
}

/* Card */
.persona-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  transition: all 0.2s ease-in-out;
  backdrop-filter: var(--glass-blur);
  overflow: hidden;
}

.persona-card:hover {
  border-color: var(--border-color-hover);
  transform: translateY(-2px);
  background: var(--bg-card-hover);
}

.card-header {
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.title-info {
  min-width: 0;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
  flex-wrap: wrap;
}

.name-row h3 {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--text-primary);
}

.accent-icon {
  color: var(--accent-primary);
  flex-shrink: 0;
}

.id-badge {
  font-size: 0.7rem;
  background: rgba(255, 255, 255, 0.05);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  color: var(--text-secondary);
}

body.light-theme .id-badge {
  background: rgba(15, 23, 42, 0.06);
}

.prompt-preview {
  font-size: 0.85rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 0.25rem;
  line-height: 1.4;
}

.card-body {
  padding: 1rem 1.25rem;
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.tags-area {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
}

.tag-group {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.tag-group-icon {
  color: var(--accent-primary);
}

.tag-group-icon.tool-icon {
  color: #818CF8;
}

.tag-group-icon.skill-icon {
  color: var(--accent-success);
}

.card-footer {
  padding: 0.75rem 1.25rem;
  border-top: 1px solid var(--border-color);
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  gap: 1rem;
  text-align: center;
  background: rgba(255, 255, 255, 0.01);
  border: 1px dashed var(--border-color);
  border-radius: 12px;
}

.empty-icon {
  opacity: 0.4;
  color: var(--text-muted);
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
}

/* Buttons */
.btn {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
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
  color: #fff;
}

.btn.primary:hover {
  background: var(--accent-primary-hover);
}

.btn.sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  border-radius: 6px;
}

.btn.danger {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: var(--accent-danger);
}

.btn.danger:hover {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.5);
}

.btn.sm.danger-text {
  background: transparent;
  border: none;
  color: var(--accent-danger);
  padding: 0.2rem 0.5rem;
}

.btn.sm.danger-text:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* Form */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.25rem;
}

@media (max-width: 600px) {
  .form-grid {
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
  font-size: 0.82rem;
  padding: 0.4rem 0.6rem;
}

textarea.form-control {
  resize: vertical;
}

.required {
  color: var(--accent-danger);
}

.optional {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 0.8rem;
}

.id-inline-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0;
}

.id-inline-row code {
  background: rgba(255, 255, 255, 0.05);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  font-size: 0.8rem;
}

body.light-theme .id-inline-row code {
  background: rgba(15, 23, 42, 0.06);
}

.link-btn {
  background: transparent;
  border: none;
  color: var(--accent-primary);
  padding: 0.15rem 0.4rem;
  font-size: 0.78rem;
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
}

.help-text {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

/* Form Tabs */
.form-tabs {
  display: flex;
  gap: 0.5rem;
  padding: 0 1.5rem;
  border-bottom: 1px solid var(--border-color);
}

.form-tab {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 0.75rem 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.form-tab:hover {
  color: var(--text-primary);
}

.form-tab.active {
  color: var(--accent-primary);
  font-weight: 600;
}

.form-tab.active::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent-primary);
}

/* Tab Panel */
.tab-panel {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* Section Block */
.section-block {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.section-block-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.section-block-header h4 {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.section-desc {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin: 0.2rem 0 0;
}

/* Dialog Pairs */
.dialog-pairs {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.dialog-pair {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}

body.light-theme .dialog-pair {
  background: rgba(15, 23, 42, 0.02);
}

.dialog-pair-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid var(--border-color);
}

body.light-theme .dialog-pair-header {
  background: rgba(15, 23, 42, 0.02);
}

.dialog-pair-index {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.dialog-pair-body {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.dialog-label {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  font-weight: 600;
}

.dialog-label.user-label {
  color: #60A5FA;
}

.dialog-label.ai-label {
  color: var(--accent-primary);
}

/* Dialog Items (mood) */
.dialog-items {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.dialog-item-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  padding: 0.4rem 0.75rem;
  border-radius: 6px;
  font-size: 0.85rem;
}

body.light-theme .dialog-item-row {
  background: rgba(15, 23, 42, 0.02);
}

.dialog-item-text {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  margin-right: 0.5rem;
}

.add-item-row {
  display: flex;
  gap: 0.5rem;
}

/* Icon Button */
.icon-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.15s;
  display: inline-flex;
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

/* Empty Hints */
.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 1.5rem;
  color: var(--text-muted);
  font-size: 0.85rem;
  text-align: center;
}

.empty-h-icon {
  opacity: 0.4;
}

.empty-hint.small {
  padding: 0.75rem;
}

/* Mode Switch */
.mode-switch {
  display: flex;
  gap: 0.75rem;
}

.mode-option {
  flex: 1;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.mode-option:hover {
  border-color: var(--border-color-hover);
}

.mode-option.checked {
  border-color: var(--accent-primary);
  background: rgba(99, 102, 241, 0.06);
}

/* Screen-reader only: hide native radio visually but keep accessible */
.sr-only {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  padding: 0 !important;
  margin: -1px !important;
  overflow: hidden !important;
  clip: rect(0, 0, 0, 0) !important;
  clip-path: inset(50%) !important;
  border: 0 !important;
  white-space: nowrap !important;
}

/* Custom radio indicator */
.radio-indicator {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-radius: 50%;
  transition: all 0.15s ease;
  margin-top: 2px;
}

.mode-option.checked .radio-indicator {
  border-color: var(--accent-primary);
  box-shadow: inset 0 0 0 4px var(--accent-primary);
}

.mode-label {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
}

.mode-desc {
  font-size: 0.75rem;
  color: var(--text-muted);
}

/* Selection Panel */
.selection-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
}

.search-box .search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-box .form-control {
  padding-left: 32px;
}

.check-list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.1);
}

body.light-theme .check-list {
  background: rgba(15, 23, 42, 0.03);
}

.check-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  transition: background 0.1s;
  border-bottom: 1px solid var(--border-color);
}

.check-item:last-child {
  border-bottom: none;
}

.check-item:hover {
  background: rgba(255, 255, 255, 0.03);
}

body.light-theme .check-item:hover {
  background: rgba(15, 23, 42, 0.03);
}

.check-item input {
  accent-color: var(--accent-primary);
  flex-shrink: 0;
}

.check-item-name {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-primary);
}

.check-item-desc {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-left: auto;
  white-space: nowrap;
}

.check-empty {
  padding: 1.5rem;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.85rem;
}

/* Selected Tags */
.selected-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}

.selected-count {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-right: 0.25rem;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.78rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.tool-tag {
  background: rgba(99, 102, 241, 0.15);
  color: #818CF8;
  border: 1px solid rgba(99, 102, 241, 0.3);
}

.skill-tag {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.tag-remove {
  cursor: pointer;
  opacity: 0.7;
}

.tag-remove:hover {
  opacity: 1;
}

/* Modal */
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

.modal-content.modal-lg {
  max-width: 800px;
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

/* Delete Confirm */
.delete-confirm-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  text-align: center;
}

.delete-warn-icon {
  color: var(--accent-danger);
}

.delete-confirm-content p {
  color: var(--text-primary);
  font-size: 0.95rem;
  margin: 0;
}

.delete-sub {
  color: var(--text-muted);
  font-size: 0.8rem !important;
}

/* Detail Modal */
.detail-section {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.detail-section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
}

@media (max-width: 600px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}

.detail-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.detail-field.full {
  grid-column: 1 / -1;
}

.detail-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.detail-value {
  font-size: 0.9rem;
  color: var(--text-primary);
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}

.detail-prompt {
  font-size: 0.88rem;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  background: rgba(0, 0, 0, 0.1);
  padding: 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

body.light-theme .detail-prompt {
  background: rgba(15, 23, 42, 0.03);
}

.detail-error-msg {
  font-size: 0.85rem;
  color: var(--text-primary);
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.15);
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
}

.detail-empty {
  color: var(--text-muted);
  font-size: 0.85rem;
  text-align: center;
  padding: 0.5rem;
}

/* Detail Dialogs */
.detail-dialogs {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.detail-dialog-pair {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.detail-dialog-bubble {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  font-size: 0.85rem;
  line-height: 1.5;
  word-break: break-word;
}

.detail-dialog-bubble svg {
  flex-shrink: 0;
  margin-top: 3px;
}

.user-bubble {
  background: rgba(96, 165, 250, 0.1);
  border: 1px solid rgba(96, 165, 250, 0.2);
  color: var(--text-primary);
}

.ai-bubble {
  background: rgba(99, 102, 241, 0.1);
  border: 1px solid rgba(99, 102, 241, 0.2);
  color: var(--text-primary);
}

.detail-mood-items {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.3rem;
}

.detail-mood-item {
  font-size: 0.85rem;
  color: var(--text-primary);
  padding: 0.4rem 0.6rem;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

body.light-theme .detail-mood-item {
  background: rgba(15, 23, 42, 0.02);
}

.muted {
  color: var(--text-muted);
}

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
  animation: toastIn 0.2s ease-out;
  max-width: 400px;
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

/* Utility */
.animate-fade-in {
  animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
