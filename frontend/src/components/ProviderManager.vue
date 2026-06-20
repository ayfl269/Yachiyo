<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import {
  Plus, X, Save, Trash2, RefreshCw, Search, Download,
  Pencil, Power, Image,
  AudioWaveform, Wrench, Brain, MousePointerClick, Globe,
  Play, Sparkles
} from 'lucide-vue-next'

// ===== Types =====
interface ProviderSource {
  id: string
  type: string
  provider_type: string
  provider: string
  key?: string
  api_base?: string
  enable: boolean
  [key: string]: any
}

interface Provider {
  id: string
  enable: boolean
  model: string
  provider_source_id: string
  provider_type?: string
  type?: string
  modalities?: string[]
  custom_extra_body?: Record<string, any>
  max_context_tokens?: number
  reasoning?: boolean
  temperature?: number
  [key: string]: any
}

interface ModelEntry {
  type: 'configured' | 'available'
  provider?: Provider
  model?: string
  metadata?: any
}

// ===== Provider Icon Map =====
const providerIconMap: Record<string, string> = {
  'openai': '/provider_logos/openai.svg',
  'anthropic': '/provider_logos/anthropic.svg',
  'google': '/provider_logos/gemini-color.svg',
}

function getProviderIcon(provider: string): string {
  return providerIconMap[provider] || ''
}

// ===== State =====
const loading = ref(true)
const configSchema = ref<Record<string, any>>({})
const providerTemplates = ref<Record<string, any>>({})
const providerSources = ref<ProviderSource[]>([])
const providers = ref<Provider[]>([])
const selectedProviderType = ref('chat_completion')
const selectedProviderSource = ref<ProviderSource | null>(null)
const selectedProviderSourceOriginalId = ref<string | null>(null)
const editableProviderSource = ref<ProviderSource | null>(null)
const availableModels = ref<any[]>([])
const modelMetadata = ref<Record<string, any>>({})
const loadingModels = ref(false)
const savingSource = ref(false)
const testingProviders = ref<string[]>([])
const savingProviders = ref<string[]>([])
const isSourceModified = ref(false)
const modelSearch = ref('')

// Dialog states
const showAddProviderDialog = ref(false)
const addProviderTab = ref('speech_to_text')
const showManualModelDialog = ref(false)
const manualModelId = ref('')
const showProviderEditDialog = ref(false)
const providerEditData = ref<Provider | null>(null)
const providerEditOriginalId = ref('')
const providerEditMode = ref<'add' | 'edit'>('edit')
const showAddSourceMenu = ref(false)

// Non-chat provider full config dialog
const showNonChatConfigDialog = ref(false)
const nonChatConfigData = ref<Record<string, any> | null>(null)
const nonChatConfigMode = ref<'add' | 'edit'>('edit')
const nonChatConfigSaving = ref(false)

// Toast
const toast = ref({ show: false, message: '', color: 'success' })
let toastTimer: number | null = null

function showMessage(message: string, color = 'success') {
  toast.value = { show: true, message, color }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value.show = false }, 3000)
}

// ===== Tab Config =====
const providerTypes = [
  { value: 'chat_completion', label: '对话模型' },
  { value: 'speech_to_text', label: '语音转文字' },
  { value: 'text_to_speech', label: '文字转语音' },
  { value: 'embedding', label: '向量嵌入' },
  { value: 'rerank', label: '重排序' }
]

const addProviderTabs = [
  { value: 'speech_to_text', label: '语音转文字' },
  { value: 'text_to_speech', label: '文字转语音' },
  { value: 'embedding', label: '向量嵌入' },
  { value: 'rerank', label: '重排序' }
]

// ===== Computed =====
const availableSourceTypes = computed(() => {
  if (!providerTemplates.value) return []
  const types: Array<{ value: string; label: string; icon: string }> = []
  for (const [name, template] of Object.entries(providerTemplates.value)) {
    if (template.provider_type === selectedProviderType.value) {
      types.push({ value: name, label: name, icon: getProviderIcon(template.provider) })
    }
  }
  return types
})

const displayedProviderSources = computed(() => {
  return providerSources.value.filter(s =>
    s.provider_type === selectedProviderType.value ||
    (s.type && isTypeMatchingProviderType(s.type, selectedProviderType.value))
  )
})

const sourceProviders = computed(() => {
  if (!selectedProviderSource.value) return []
  return providers.value.filter(p => p.provider_source_id === selectedProviderSource.value!.id)
})

const existingModelsForSelectedSource = computed(() => {
  return new Set(sourceProviders.value.map(p => p.model))
})

const mergedModelEntries = computed<ModelEntry[]>(() => {
  const configured: ModelEntry[] = sourceProviders.value.map(provider => ({
    type: 'configured' as const,
    provider,
    metadata: modelMetadata.value?.[provider.model] || buildMetadataFromProvider(provider)
  }))

  const available: ModelEntry[] = (availableModels.value || [])
    .filter((item: any) => {
      const name = typeof item === 'string' ? item : item?.name
      return !existingModelsForSelectedSource.value.has(name)
    })
    .map((item: any) => {
      const name = typeof item === 'string' ? item : item?.name
      return {
        type: 'available' as const,
        model: name,
        metadata: typeof item === 'object' ? item?.metadata : modelMetadata.value?.[name]
      }
    })

  return [...configured, ...available]
})

const filteredMergedModelEntries = computed(() => {
  const term = modelSearch.value.trim().toLowerCase()
  if (!term) return mergedModelEntries.value
  return mergedModelEntries.value.filter(entry => {
    if (entry.type === 'configured') {
      return (entry.provider?.id?.toLowerCase().includes(term) || entry.provider?.model?.toLowerCase().includes(term))
    }
    return entry.model?.toLowerCase().includes(term)
  })
})

const configuredEntries = computed(() => filteredMergedModelEntries.value.filter(e => e.type === 'configured'))
const availableEntries = computed(() => filteredMergedModelEntries.value.filter(e => e.type === 'available'))

const filteredProviders = computed(() => {
  if (selectedProviderType.value === 'chat_completion') return []
  return providers.value.filter(p => getProviderType(p) === selectedProviderType.value)
})

const manualProviderId = computed(() => {
  if (!selectedProviderSource.value || !manualModelId.value.trim()) return ''
  return `${selectedProviderSource.value.id}/${manualModelId.value.trim()}`
})

// Basic source config fields
// const basicFields = ['id', 'key', 'api_base'] as const

// Advanced source config (all fields except basic + excluded)
const advancedSourceConfig = computed(() => {
  if (!editableProviderSource.value) return null
  const excluded = new Set(['id', 'key', 'api_base', 'enable', 'type', 'provider_type', 'provider'])
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(editableProviderSource.value)) {
    if (!excluded.has(key)) {
      result[key] = value
    }
  }
  return Object.keys(result).length > 0 ? result : null
})

// ===== Helpers =====
function isTypeMatchingProviderType(type?: string, providerType?: string): boolean {
  if (!type || !providerType) return false
  if (providerType === 'chat_completion') return type.includes('chat_completion')
  return type.includes(providerType)
}

function getProviderType(provider: any): string | undefined {
  if (!provider) return undefined
  if (provider.provider_type) return provider.provider_type
  const mapping: Record<string, string> = {
    openai_chat_completion: 'chat_completion',
    anthropic_chat_completion: 'chat_completion',
    googlegenai_chat_completion: 'chat_completion',
    dify: 'chat_completion', coze: 'chat_completion',
    openai_whisper_api: 'speech_to_text', openai_tts_api: 'text_to_speech',
    edge_tts: 'text_to_speech', dashscope_tts: 'text_to_speech',
  }
  return mapping[provider.type]
}

function buildMetadataFromProvider(provider: any) {
  if (!provider) return null
  const mods = provider.modalities || []
  if (!mods.length && !provider.max_context_tokens) return null
  const input: string[] = []
  if (mods.includes('image')) input.push('image')
  if (mods.includes('audio')) input.push('audio')
  return {
    modalities: { input },
    tool_call: mods.includes('tool_use'),
    reasoning: Boolean(provider.reasoning),
    limit: { context: provider.max_context_tokens || 0 }
  }
}

function supportsImageInput(meta: any) { return meta?.modalities?.input?.includes('image') }
function supportsAudioInput(meta: any) { return meta?.modalities?.input?.includes('audio') }
function supportsToolCall(meta: any) { return Boolean(meta?.tool_call) }
function supportsReasoning(meta: any) { return Boolean(meta?.reasoning) }

function formatContextLimit(meta: any): string {
  const ctx = meta?.limit?.context
  if (!ctx || typeof ctx !== 'number') return ''
  if (ctx >= 1_000_000) return `${Math.round(ctx / 1_000_000)}M`
  if (ctx >= 1_000) return `${Math.round(ctx / 1_000)}K`
  return `${ctx}`
}

function capabilityIcons(meta: any): Array<{ icon: string; label: string }> {
  const icons: Array<{ icon: string; label: string }> = []
  if (supportsImageInput(meta)) icons.push({ icon: 'image', label: '图片' })
  if (supportsAudioInput(meta)) icons.push({ icon: 'audio', label: '音频' })
  if (supportsToolCall(meta)) icons.push({ icon: 'tool', label: '工具' })
  if (supportsReasoning(meta)) icons.push({ icon: 'brain', label: '推理' })
  return icons
}

function generateUniqueSourceId(baseId: string): string {
  const existingIds = new Set(providerSources.value.map(s => s.id))
  if (!existingIds.has(baseId)) return baseId
  let counter = 1
  let candidate = `${baseId}_${counter}`
  while (existingIds.has(candidate)) { counter++; candidate = `${baseId}_${counter}` }
  return candidate
}

// ===== API Methods =====
async function loadConfig() {
  try {
    const res = await fetch('/api/config/provider/template')
    const json = await res.json()
    if (json.status === 'ok') {
      configSchema.value = json.data.config_schema || {}
      providerTemplates.value = configSchema.value.provider?.config_template || {}
      providerSources.value = json.data.provider_sources || []
      providers.value = json.data.providers || []
    }
  } catch (error) {
    console.error('Failed to load provider template:', error)
  } finally {
    loading.value = false
  }
}

function selectProviderSource(source: ProviderSource | null) {
  selectedProviderSource.value = source
  selectedProviderSourceOriginalId.value = source?.id || null
  editableProviderSource.value = source ? JSON.parse(JSON.stringify(source)) : null
  availableModels.value = []
  modelMetadata.value = {}
  isSourceModified.value = false
}

function addProviderSource(templateKey: string) {
  const template = providerTemplates.value[templateKey]
  if (!template) { showMessage('未找到对应的模板配置', 'error'); return }

  const newId = generateUniqueSourceId(template.id || templateKey)
  const excludeKeys = ['id', 'enable', 'model', 'provider_source_id', 'modalities', 'custom_extra_body']
  const sourceFields: Record<string, any> = {}
  for (const [key, value] of Object.entries(template)) {
    if (!excludeKeys.includes(key)) sourceFields[key] = value
  }

  const newSource: ProviderSource = {
    ...sourceFields,
    id: newId,
    type: template.type,
    provider_type: template.provider_type,
    provider: template.provider,
    enable: true
  }

  providerSources.value.push(newSource)
  selectProviderSource(newSource)
  isSourceModified.value = true
  showAddSourceMenu.value = false
}

async function deleteProviderSource(source: ProviderSource) {
  if (!confirm(`确定要删除提供商源 "${source.id}" 吗？`)) return
  try {
    const res = await fetch('/api/config/provider_sources/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: source.id })
    })
    const json = await res.json()
    if (json.status === 'error') { showMessage(json.message, 'error'); return }

    providers.value = providers.value.filter(p => p.provider_source_id !== source.id)
    providerSources.value = providerSources.value.filter(s => s.id !== source.id)
    if (selectedProviderSource.value?.id === source.id) selectProviderSource(null)
    showMessage('提供商源已删除')
  } catch (error: any) {
    showMessage(error.message || '删除失败', 'error')
  } finally {
    await loadConfig()
  }
}

async function saveProviderSource() {
  if (!editableProviderSource.value) return
  savingSource.value = true
  const originalId = selectedProviderSourceOriginalId.value || editableProviderSource.value.id
  try {
    const res = await fetch('/api/config/provider_sources/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: editableProviderSource.value, original_id: originalId })
    })
    const json = await res.json()
    if (json.status !== 'ok') throw new Error(json.message)

    if (editableProviderSource.value.id !== originalId) {
      providers.value = providers.value.map(p =>
        p.provider_source_id === originalId
          ? { ...p, provider_source_id: editableProviderSource.value!.id }
          : p
      )
      selectedProviderSourceOriginalId.value = editableProviderSource.value.id
    }

    const idx = providerSources.value.findIndex(ps => ps.id === originalId)
    if (idx !== -1) {
      providerSources.value[idx] = JSON.parse(JSON.stringify(editableProviderSource.value))
      selectedProviderSource.value = providerSources.value[idx]
    }
    editableProviderSource.value = JSON.parse(JSON.stringify(selectedProviderSource.value))
    await nextTick()
    isSourceModified.value = false
    showMessage(json.message || '保存成功')
  } catch (error: any) {
    showMessage(error.message || '保存失败', 'error')
  } finally {
    savingSource.value = false
    loadConfig()
  }
}

async function fetchAvailableModels() {
  if (!selectedProviderSource.value) return
  if (isSourceModified.value) {
    await saveProviderSource()
    if (isSourceModified.value) {
      showMessage('请先保存提供商源配置', 'error')
      return
    }
  }
  loadingModels.value = true
  try {
    const sourceId = editableProviderSource.value?.id || selectedProviderSource.value.id
    const res = await fetch(`/api/config/provider_sources/models?source_id=${encodeURIComponent(sourceId)}`)
    const json = await res.json()
    if (json.status === 'ok') {
      modelMetadata.value = json.data.model_metadata || {}
      availableModels.value = (json.data.models || []).map((model: string) => ({
        name: model,
        metadata: modelMetadata.value?.[model] || null
      }))
      if (availableModels.value.length === 0) showMessage('未找到可用模型', 'info')
    } else {
      throw new Error(json.message)
    }
  } catch (error: any) {
    modelMetadata.value = {}
    showMessage(error.message || '获取模型列表失败', 'error')
  } finally {
    loadingModels.value = false
  }
}

function buildModelProviderConfig(modelName: string): Provider | null {
  if (!selectedProviderSource.value) return null
  const sourceId = editableProviderSource.value?.id || selectedProviderSource.value.id
  const newId = `${sourceId}/${modelName}`
  const meta = modelMetadata.value?.[modelName]
  
  let modalities = ['text', 'image', 'audio', 'tool_use']
  let maxContext = 0
  let isReasoning = false

  if (meta) {
    modalities = ['text']
    if (supportsImageInput(meta)) modalities.push('image')
    if (supportsAudioInput(meta)) modalities.push('audio')
    if (supportsToolCall(meta)) modalities.push('tool_use')
    maxContext = meta?.limit?.context || 0
    isReasoning = supportsReasoning(meta)
  } else {
    const auto = autoDetectModelCapabilities(modelName)
    modalities = auto.modalities
    maxContext = auto.maxContext
    isReasoning = auto.isReasoning
  }

  return {
    id: newId,
    enable: true,
    provider_source_id: sourceId,
    model: modelName,
    modalities,
    custom_extra_body: {},
    max_context_tokens: maxContext,
    reasoning: isReasoning,
    temperature: 0.7
  }
}

/*
async function addModelProvider(modelName: string) {
  const newProvider = buildModelProviderConfig(modelName)
  if (!newProvider) return
  try {
    const res = await fetch('/api/config/provider/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newProvider)
    })
    const json = await res.json()
    if (json.status === 'error') throw new Error(json.message)
    providers.value.push(newProvider)
    showMessage(json.message || `模型 ${modelName} 添加成功`)
  } catch (error: any) {
    showMessage(error.message || '添加失败', 'error')
  } finally {
    await loadConfig()
  }
}
*/

async function deleteProvider(provider: Provider) {
  if (!confirm(`确定要删除 "${provider.id}" 吗？`)) return
  try {
    const res = await fetch('/api/config/provider/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: provider.id })
    })
    const json = await res.json()
    if (json.status === 'error') throw new Error(json.message)
    providers.value = providers.value.filter(p => p.id !== provider.id)
    showMessage('模型提供商已删除')
  } catch (error: any) {
    showMessage(error.message || '删除失败', 'error')
  } finally {
    await loadConfig()
  }
}

async function toggleProviderEnable(provider: Provider, value: boolean) {
  try {
    const nextConfig = { ...provider, enable: value }
    const res = await fetch('/api/config/provider/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: provider.id, config: nextConfig })
    })
    const json = await res.json()
    if (json.status === 'error') throw new Error(json.message)
    provider.enable = value
    showMessage(json.message || '状态已更新')
  } catch (error: any) {
    showMessage(error.message || '更新失败', 'error')
  } finally {
    await loadConfig()
  }
}

async function testProvider(provider: Provider) {
  if (testingProviders.value.includes(provider.id)) return
  testingProviders.value.push(provider.id)
  try {
    const startTime = performance.now()
    const res = await fetch(`/api/config/provider/check_one?id=${encodeURIComponent(provider.id)}`)
    const json = await res.json()
    if (json.status === 'ok' && json.data?.error === null) {
      const latency = Math.max(0, Math.round(performance.now() - startTime))
      showMessage(`测试成功: ${provider.id} (${latency}ms)`)
    } else {
      throw new Error(json.data?.error || '测试失败')
    }
  } catch (error: any) {
    showMessage(error.message || '测试失败', 'error')
  } finally {
    testingProviders.value = testingProviders.value.filter(id => id !== provider.id)
  }
}

// Provider edit dialog
function openProviderEdit(provider: Provider) {
  providerEditData.value = JSON.parse(JSON.stringify(provider))
  if (providerEditData.value && providerEditData.value.temperature === undefined) {
    providerEditData.value.temperature = 0.7
  }
  providerEditOriginalId.value = provider.id
  providerEditMode.value = 'edit'
  showProviderEditDialog.value = true
}

function openModelAddDialog(modelName: string) {
  if (!selectedProviderSource.value) { showMessage('请先选择提供商源', 'error'); return }
  if (existingModelsForSelectedSource.value.has(modelName)) { showMessage('该模型已配置', 'error'); return }
  const newConfig = buildModelProviderConfig(modelName)
  if (!newConfig) return
  providerEditData.value = newConfig
  providerEditOriginalId.value = ''
  providerEditMode.value = 'add'
  showProviderEditDialog.value = true
}

async function saveEditedProvider() {
  if (!providerEditData.value) return
  savingProviders.value.push(providerEditData.value.id)
  try {
    const isAdding = providerEditMode.value === 'add'
    const res = isAdding
      ? await fetch('/api/config/provider/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(providerEditData.value)
        })
      : await fetch('/api/config/provider/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: providerEditOriginalId.value || providerEditData.value.id,
            config: providerEditData.value
          })
        })
    const json = await res.json()
    if (json.status === 'error') throw new Error(json.message)
    showMessage(json.message || (isAdding ? '添加成功' : '更新成功'))
    showProviderEditDialog.value = false
  } catch (error: any) {
    showMessage(error.message || '保存失败', 'error')
  } finally {
    savingProviders.value = savingProviders.value.filter(id => id !== providerEditData.value?.id)
    await loadConfig()
  }
}

// Manual model dialog
function openManualModelDialog() {
  if (!selectedProviderSource.value) { showMessage('请先选择提供商源', 'error'); return }
  manualModelId.value = ''
  showManualModelDialog.value = true
}

function confirmManualModel() {
  const modelId = manualModelId.value.trim()
  if (!modelId) { showMessage('请输入模型 ID', 'error'); return }
  if (existingModelsForSelectedSource.value.has(modelId)) { showMessage('该模型已配置', 'error'); return }
  showManualModelDialog.value = false
  openModelAddDialog(modelId)
}

// Add provider dialog (for non-chat types)
function getTemplatesByType(type: string) {
  const templates = configSchema.value.provider?.config_template || {}
  const filtered: Record<string, any> = {}
  for (const [name, template] of Object.entries(templates)) {
    if ((template as any).provider_type === type) filtered[name] = template
  }
  return filtered
}

async function selectProviderTemplate(name: string) {
  const template = providerTemplates.value[name]
  if (!template) return
  // Open config dialog instead of directly creating
  nonChatConfigData.value = JSON.parse(JSON.stringify(template))
  nonChatConfigMode.value = 'add'
  showAddProviderDialog.value = false
  showNonChatConfigDialog.value = true
}

// Open add provider dialog with correct tab pre-selected
function openAddProviderDialog() {
  addProviderTab.value = selectedProviderType.value
  showAddProviderDialog.value = true
}

// Non-chat provider full config edit
function openNonChatProviderEdit(provider: Provider) {
  nonChatConfigData.value = JSON.parse(JSON.stringify(provider))
  nonChatConfigMode.value = 'edit'
  showNonChatConfigDialog.value = true
}

// Get all editable fields for non-chat provider (excluding internal fields)
/*
const nonChatEditableFields = computed(() => {
  if (!nonChatConfigData.value) return []
  const excludeKeys = new Set(['id', 'provider_source_id', 'modalities', 'custom_extra_body'])
  const fields: Array<{ key: string; value: any; label: string }> = []
  const fieldLabels: Record<string, string> = {
    id: '标识 ID',
    type: '类型',
    provider_type: '提供商类型',
    provider: '提供商',
    key: 'API Key',
    api_base: 'API Base URL',
    model: '模型名称',
    enable: '启用',
    voice: '语音',
    dimensions: '维度',
    max_context_tokens: '最大上下文长度',
    reasoning: '推理模式',
  }
  for (const [key, value] of Object.entries(nonChatConfigData.value)) {
    if (!excludeKeys.has(key)) {
      fields.push({ key, value, label: fieldLabels[key] || key })
    }
  }
  return fields
})
*/

// Non-chat provider field schema (matching original dashboard's config_schema metadata)
interface FieldDef {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select'
  placeholder?: string
  hint?: string
  password?: boolean
  disabled?: boolean
  span?: boolean
  options?: Array<{ value: any; label: string }>
}

// Provider type → field rows definition
const nonChatFieldSchema: Record<string, FieldDef[][]> = {
  embedding: [
    [
      { key: 'id', label: 'ID', type: 'string', disabled: true },
      { key: 'enable', label: '启用', type: 'boolean' },
    ],
    [
      { key: 'key', label: 'API Key', type: 'string', password: true, placeholder: '鉴权密钥' },
      { key: 'model', label: '嵌入模型', type: 'string', placeholder: '如 text-embedding-3-small' },
    ],
    [
      { key: 'api_base', label: 'API Base URL', type: 'string', placeholder: '例如: https://api.openai.com/v1', hint: '测试不通过可尝试添加 /v1 兼容部分 OpenAI API 版本。', span: true },
    ],
    [
      { key: 'dimensions', label: '嵌入维度', type: 'number', placeholder: '1024', hint: '根据模型调整，填写错误会导致向量检索异常。', span: true },
      { key: 'timeout', label: '超时时间(秒)', type: 'number', placeholder: '20' },
    ],
    [
      { key: 'proxy', label: '代理地址', type: 'string', placeholder: '', hint: 'HTTP/HTTPS 代理地址，格式如 http://127.0.0.1:7890。不支持 Docker 内网地址。', span: true },
    ],
  ],
  speech_to_text: [
    [
      { key: 'id', label: 'ID', type: 'string', disabled: true },
      { key: 'enable', label: '启用', type: 'boolean' },
    ],
    [
      { key: 'key', label: 'API Key', type: 'string', password: true, placeholder: '鉴权密钥' },
      { key: 'model', label: '模型名称', type: 'string', placeholder: '如 whisper-1' },
    ],
    [
      { key: 'api_base', label: 'API Base URL', type: 'string', placeholder: '例如: https://api.openai.com/v1', hint: '测试不通过可尝试添加 /v1 兼容部分 API 版本。', span: true },
    ],
    [
      { key: 'timeout', label: '超时时间(秒)', type: 'number', placeholder: '20' },
      { key: 'proxy', label: '代理地址', type: 'string', placeholder: 'http://127.0.0.1:7890' },
    ],
  ],
  text_to_speech: [
    [
      { key: 'id', label: 'ID', type: 'string', disabled: true },
      { key: 'enable', label: '启用', type: 'boolean' },
    ],
    [
      { key: 'key', label: 'API Key', type: 'string', password: true, placeholder: '鉴权密钥' },
      { key: 'model', label: '模型名称', type: 'string', placeholder: '如 tts-1, tts-1-hd' },
    ],
    [
      {
        key: 'voice', label: '语音', type: 'select',
        options: [
          { value: 'alloy', label: 'alloy' },
          { value: 'echo', label: 'echo' },
          { value: 'fable', label: 'fable' },
          { value: 'onyx', label: 'onyx' },
          { value: 'nova', label: 'nova' },
          { value: 'shimmer', label: 'shimmer' },
        ],
      },
      { key: 'timeout', label: '超时时间(秒)', type: 'number', placeholder: '20' },
    ],
    [
      { key: 'api_base', label: 'API Base URL', type: 'string', placeholder: '例如: https://api.openai.com/v1', hint: '测试不通过可尝试添加 /v1 兼容部分 OpenAI API 版本。', span: true },
    ],
    [
      { key: 'proxy', label: '代理地址', type: 'string', placeholder: 'http://127.0.0.1:7890', span: true },
    ],
  ],
  rerank: [
    [
      { key: 'id', label: 'ID', type: 'string', disabled: true },
      { key: 'enable', label: '启用', type: 'boolean' },
    ],
    [
      { key: 'key', label: 'API Key', type: 'string', password: true, placeholder: '鉴权密钥' },
    ],
    [
      { key: 'api_base', label: 'API Base URL', type: 'string', placeholder: '例如: https://api.cohere.ai/v1', span: true },
    ],
    [
      { key: 'model', label: '模型名称', type: 'string', placeholder: '输入模型名称。', hint: '模型名称，如 rerank-v3.5, jina-reranker-v2-base-multilingual。' },
      { key: 'timeout', label: '超时时间', type: 'number', placeholder: '20', hint: '超时时间，单位为秒。' },
    ],
    [
      { key: 'proxy', label: '代理地址', type: 'string', placeholder: '', hint: 'HTTP/HTTPS 代理地址，格式如 http://127.0.0.1:7890。', span: true },
    ],
  ],
}

const providerTypeLabels: Record<string, string> = {
  embedding: 'OpenAI Embedding',
  speech_to_text: '语音转文字',
  text_to_speech: '文字转语音',
  rerank: '重排序(Rerank)',
}

const nonChatProviderLabel = computed(() => {
  if (!nonChatConfigData.value) return ''
  const pt = nonChatConfigData.value.provider_type || ''
  // Use specific name based on type field
  const typeMap: Record<string, string> = {
    openai_embedding: 'OpenAI Embedding',
    gemini_embedding: 'Gemini Embedding',
    openai_stt: '语音转文字(OpenAI)',
    openai_tts: '文字转语音(OpenAI)',
    cohere: '重排序(Cohere)',
    jina: '重排序(Jina)',
    voyage: '重排序(Voyage)',
    generic_rerank: '重排序(Generic)',
  }
  return typeMap[nonChatConfigData.value.type as string] || providerTypeLabels[pt] || pt
})

// Get the field rows for current provider type
const nonChatFieldRows = computed(() => {
  if (!nonChatConfigData.value) return []
  const pt = nonChatConfigData.value.provider_type || ''
  return nonChatFieldSchema[pt] || nonChatFieldSchema['embedding'] || []
})

// Fields on the data object that are not covered by the schema
const nonChatUnknownFields = computed(() => {
  if (!nonChatConfigData.value) return []
  const schemaKeys = new Set<string>()
  for (const row of nonChatFieldRows.value) {
    for (const f of row) schemaKeys.add(f.key)
  }
  const excludeKeys = new Set(['modalities', 'provider_source_id', 'custom_extra_body', 'provider_type', 'type', 'max_context_tokens', 'reasoning'])
  const fields: Array<{ key: string; value: any }> = []
  for (const [key, value] of Object.entries(nonChatConfigData.value)) {
    if (!schemaKeys.has(key) && !excludeKeys.has(key)) {
      fields.push({ key, value })
    }
  }
  return fields
})

async function saveNonChatConfig() {
  if (!nonChatConfigData.value) return
  nonChatConfigSaving.value = true
  try {
    const isEditing = nonChatConfigMode.value === 'edit'
    const res = isEditing
      ? await fetch('/api/config/provider/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: nonChatConfigData.value.id,
            config: nonChatConfigData.value
          })
        })
      : await fetch('/api/config/provider/new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nonChatConfigData.value)
        })
    const json = await res.json()
    if (json.status === 'error') throw new Error(json.message)
    showMessage(json.message || (isEditing ? '更新成功' : '添加成功'))
    showNonChatConfigDialog.value = false
  } catch (error: any) {
    showMessage(error.message || '保存失败', 'error')
  } finally {
    nonChatConfigSaving.value = false
    await loadConfig()
  }
}

// Watch for source edits
watch(editableProviderSource, () => {
  if (!editableProviderSource.value) return
  isSourceModified.value = true
}, { deep: true })

// Watch tab changes to deselect source if needed
watch(selectedProviderType, () => {
  selectProviderSource(null)
})

function toggleModality(provider: any, mod: string) {
  if (!provider.modalities) provider.modalities = []
  const idx = provider.modalities.indexOf(mod)
  if (idx >= 0) provider.modalities.splice(idx, 1)
  else provider.modalities.push(mod)
}

function tryParseJson(event: Event, key: string) {
  const target = event.target as HTMLTextAreaElement
  try {
    const parsed = JSON.parse(target.value)
    if (editableProviderSource.value) {
      editableProviderSource.value[key] = parsed
    }
  } catch {
    // ignore parse errors, keep the raw text
  }
}

function autoDetectModelCapabilities(modelName: string) {
  const name = modelName.toLowerCase();
  
  // 1. Detect reasoning mode
  const isReasoning = name.includes('o1-') || 
                      name.includes('o3-') || 
                      name.includes('r1') || 
                      name.includes('reasoning') ||
                      name.startsWith('qwq') ||
                      name.includes('math');

  // 2. Detect max context tokens
  let maxContext = 0;
  if (name.includes('gpt-4o') || name.includes('o1-') || name.includes('o3-')) {
    maxContext = 128000;
  } else if (name.includes('gpt-4-turbo') || name.includes('gpt-4-1106') || name.includes('gpt-4-0125')) {
    maxContext = 128000;
  } else if (name.includes('gpt-4')) {
    maxContext = 8192;
  } else if (name.includes('claude-3-5') || name.includes('claude-3.5')) {
    maxContext = 200000;
  } else if (name.includes('claude-3')) {
    maxContext = 200000;
  } else if (name.includes('gemini-1.5') || name.includes('gemini-2.0') || name.includes('gemini-exp')) {
    maxContext = 1048576; // 1M
  } else if (name.includes('deepseek')) {
    maxContext = 64000;
  } else if (name.includes('qwen2.5') || name.includes('qwen-2.5')) {
    maxContext = 128000;
  } else if (name.includes('qwen2') || name.includes('qwen-2')) {
    maxContext = 32000;
  } else if (name.includes('llama3.1') || name.includes('llama-3.1') || name.includes('llama3.2') || name.includes('llama-3.2') || name.includes('llama3.3')) {
    maxContext = 128000;
  } else if (name.includes('llama3') || name.includes('llama-3')) {
    maxContext = 8192;
  } else if (name.includes('mistral') || name.includes('mixtral')) {
    maxContext = 32000;
  }

  // 3. Detect modalities
  const modalities = ['text'];
  
  // Vision (image input)
  const hasVision = name.includes('vision') || 
                    name.includes('vl') || 
                    name.includes('-v') || 
                    name.includes('gpt-4o') || 
                    name.includes('claude-3-5') || 
                    name.includes('claude-3-opus') || 
                    name.includes('claude-3-sonnet') || 
                    name.includes('gemini');
  if (hasVision) modalities.push('image');
  
  // Audio
  const hasAudio = name.includes('audio') || 
                    name.includes('gemini-1.5') || 
                    name.includes('gemini-2.0') || 
                    name.includes('gpt-4o-audio');
  if (hasAudio) modalities.push('audio');
  
  // Tool call
  const supportsTools = !name.includes('instruct') || 
                        name.includes('qwen') || 
                        name.includes('gpt') || 
                        name.includes('claude') || 
                        name.includes('gemini') || 
                        name.includes('deepseek') ||
                        name.includes('llama');
  if (supportsTools) modalities.push('tool_use');

  return {
    maxContext,
    isReasoning,
    modalities
  };
}

function handleAutoDetectCapabilities() {
  if (!providerEditData.value) return
  const auto = autoDetectModelCapabilities(providerEditData.value.model)
  providerEditData.value.max_context_tokens = auto.maxContext
  providerEditData.value.reasoning = auto.isReasoning
  providerEditData.value.modalities = auto.modalities
  showMessage('已自动识别并填充模型参数', 'success')
}

onMounted(loadConfig)
</script>

<template>
  <div class="provider-page animate-fade-in">
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1>模型提供商</h1>
        <p>配置和管理语言模型、向量模型、重排模型、TTS/STT 语音等服务的第三方 API 通道。</p>
      </div>
      <button v-if="selectedProviderType !== 'chat_completion'" class="btn primary" @click="openAddProviderDialog()">
        <Plus :size="16" /> 添加提供商
      </button>
    </div>

    <!-- Tabs -->
    <div class="tabs-container">
      <button
        v-for="type in providerTypes"
        :key="type.value"
        :class="['tab-btn', { active: selectedProviderType === type.value }]"
        @click="selectedProviderType = type.value"
      >
        {{ type.label }}
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- Chat Completion Workbench -->
    <div v-else-if="selectedProviderType === 'chat_completion'" class="provider-workbench">
      <!-- Sidebar -->
      <div class="workbench-sidebar">
        <div class="sidebar-head">
          <h3 class="sidebar-title">提供商源</h3>
          <div class="sidebar-controls">
            <div class="add-source-wrapper">
              <button class="btn sm primary" @click="showAddSourceMenu = !showAddSourceMenu">
                <Plus :size="14" /> 新增
              </button>
              <div v-if="showAddSourceMenu" class="add-source-menu">
                <button
                  v-for="sourceType in availableSourceTypes"
                  :key="sourceType.value"
                  class="menu-item"
                  @click="addProviderSource(sourceType.value)"
                >
                  <img v-if="sourceType.icon" :src="sourceType.icon" class="menu-item-icon" />
                  <span v-else class="menu-item-fallback">{{ sourceType.label[0] }}</span>
                  <span>{{ sourceType.label }}</span>
                </button>
                <div v-if="availableSourceTypes.length === 0" class="menu-empty">暂无可用模板</div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="displayedProviderSources.length > 0" class="source-list">
          <div
            v-for="source in displayedProviderSources"
            :key="source.id"
            :class="['source-item', { active: selectedProviderSource?.id === source.id }]"
            @click="selectProviderSource(source)"
          >
            <img v-if="getProviderIcon(source.provider)" :src="getProviderIcon(source.provider)" class="source-icon" />
            <div v-else class="source-icon-fallback">{{ (source.id || '?')[0].toUpperCase() }}</div>
            <div class="source-item-content">
              <div class="source-item-title">{{ source.id }}</div>
              <div class="source-item-subtitle">{{ source.api_base || source.provider }}</div>
            </div>
            <button class="source-delete-btn" @click.stop="deleteProviderSource(source)" title="删除">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <div v-else class="sidebar-empty">
          <Globe :size="36" class="empty-icon" />
          <p>暂无提供商源</p>
        </div>
      </div>

      <!-- Divider -->
      <div class="workbench-divider"></div>

      <!-- Main Panel -->
      <div class="workbench-main">
        <div v-if="selectedProviderSource" class="config-shell">
          <!-- Config Header -->
          <div class="config-header">
            <div class="config-headline">
              <div class="config-title">{{ editableProviderSource?.id || selectedProviderSource.id }}</div>
              <div class="config-subtitle">{{ editableProviderSource?.api_base || 'N/A' }}</div>
            </div>
            <button
              class="btn primary"
              :disabled="!isSourceModified || savingSource"
              @click="saveProviderSource"
            >
              <RefreshCw v-if="savingSource" :size="14" class="animate-spin" />
              <Save v-else :size="14" />
              {{ savingSource ? '保存中...' : '保存' }}
            </button>
          </div>

          <div class="config-divider"></div>

          <!-- Config Body -->
          <div class="config-body">
            <!-- Basic Settings -->
            <section class="config-section">
              <div class="section-title">基础配置</div>
              <div class="form-grid">
                <div class="form-group">
                  <label>标识 ID</label>
                  <input type="text" v-model="editableProviderSource!.id" class="form-control font-mono" placeholder="唯一标识" />
                </div>
                <div class="form-group">
                  <label>API Key</label>
                  <input type="password" v-model="editableProviderSource!.key" class="form-control font-mono" placeholder="鉴权密钥" />
                </div>
                <div class="form-group span-2">
                  <label>API Base URL</label>
                  <input type="text" v-model="editableProviderSource!.api_base" class="form-control font-mono" placeholder="API 端点地址" />
                </div>
              </div>
            </section>

            <!-- Advanced Settings -->
            <template v-if="advancedSourceConfig">
              <div class="config-divider"></div>
              <section class="config-section">
                <div class="section-title">高级配置</div>
                <div class="form-grid">
                  <div v-for="(value, key) in advancedSourceConfig" :key="key" class="form-group">
                    <label>{{ key }}</label>
                    <input
                      v-if="typeof value === 'string' || typeof value === 'number'"
                      :type="typeof value === 'number' ? 'number' : 'text'"
                      v-model="editableProviderSource![key]"
                      class="form-control font-mono"
                    />
                    <label v-else-if="typeof value === 'boolean'" class="toggle-label">
                      <input type="checkbox" v-model="editableProviderSource![key]" />
                      <span>{{ value ? '启用' : '停用' }}</span>
                    </label>
                    <textarea
                      v-else
                      :value="JSON.stringify(value, null, 2)"
                      @input="tryParseJson($event, key)"
                      class="form-control font-mono textarea-sm"
                      rows="2"
                    ></textarea>
                  </div>
                </div>
              </section>
            </template>

            <div class="config-divider"></div>

            <!-- Models Panel -->
            <section class="config-section">
              <div class="models-toolbar">
                <div>
                  <div class="section-title">模型管理</div>
                  <small class="section-subtitle">可用 {{ availableModels.length }} 个模型</small>
                </div>
                <div class="models-actions">
                  <div class="search-box">
                    <Search :size="14" class="search-icon" />
                    <input type="text" v-model="modelSearch" placeholder="搜索模型..." class="form-control sm" />
                  </div>
                  <button class="btn sm primary" :disabled="loadingModels" @click="fetchAvailableModels">
                    <RefreshCw v-if="loadingModels" :size="14" class="animate-spin" />
                    <Download v-else :size="14" />
                    获取模型列表
                  </button>
                  <button class="btn sm" @click="openManualModelDialog">
                    <Pencil :size="14" /> 手动添加
                  </button>
                </div>
              </div>

              <!-- Configured Models -->
              <div class="models-section">
                <div class="models-section-head">
                  <span>已配置</span>
                  <span class="badge">{{ configuredEntries.length }}</span>
                </div>
                <div v-if="configuredEntries.length" class="models-list">
                  <div v-for="entry in configuredEntries" :key="entry.provider!.id" class="model-row">
                    <button class="model-row-main" @click="openProviderEdit(entry.provider!)">
                      <div class="model-row-title">{{ entry.provider!.id }}</div>
                      <div class="model-row-subtitle">{{ entry.provider!.model }}</div>
                      <div class="model-row-meta">
                        <span v-for="cap in capabilityIcons(entry.metadata)" :key="cap.icon" class="capability-badge" :title="cap.label">
                          <Image v-if="cap.icon === 'image'" :size="12" />
                          <AudioWaveform v-else-if="cap.icon === 'audio'" :size="12" />
                          <Wrench v-else-if="cap.icon === 'tool'" :size="12" />
                          <Brain v-else-if="cap.icon === 'brain'" :size="12" />
                        </span>
                        <span v-if="formatContextLimit(entry.metadata)" class="context-badge">
                          {{ formatContextLimit(entry.metadata) }}
                        </span>
                      </div>
                    </button>
                    <div class="model-row-actions">
                      <button
                        :class="['toggle-btn', { active: entry.provider!.enable }]"
                        @click="toggleProviderEnable(entry.provider!, !entry.provider!.enable)"
                        :title="entry.provider!.enable ? '停用' : '启用'"
                      >
                        <Power :size="14" />
                      </button>
                      <button
                        class="icon-btn test-btn"
                        :disabled="!entry.provider!.enable || testingProviders.includes(entry.provider!.id)"
                        @click="testProvider(entry.provider!)"
                        title="测试"
                      >
                        <RefreshCw v-if="testingProviders.includes(entry.provider!.id)" :size="14" class="animate-spin" />
                        <Play v-else :size="12" />
                      </button>
                      <button class="icon-btn" @click="openProviderEdit(entry.provider!)" title="编辑">
                        <Pencil :size="14" />
                      </button>
                      <button class="icon-btn danger" @click="deleteProvider(entry.provider!)" title="删除">
                        <Trash2 :size="14" />
                      </button>
                    </div>
                  </div>
                </div>
                <div v-else class="models-empty">暂无已配置的模型</div>
              </div>

              <div class="config-divider"></div>

              <!-- Available Models -->
              <div class="models-section">
                <div class="models-section-head">
                  <span>可用模型</span>
                  <span class="badge">{{ availableEntries.length }}</span>
                </div>
                <div v-if="availableEntries.length" class="models-list models-list-available">
                  <div v-for="entry in availableEntries" :key="entry.model" class="model-row">
                    <button class="model-row-main" @click="openModelAddDialog(entry.model!)">
                      <div class="model-row-title mono">{{ entry.model }}</div>
                      <div class="model-row-meta">
                        <span v-for="cap in capabilityIcons(entry.metadata)" :key="cap.icon" class="capability-badge" :title="cap.label">
                          <Image v-if="cap.icon === 'image'" :size="12" />
                          <AudioWaveform v-else-if="cap.icon === 'audio'" :size="12" />
                          <Wrench v-else-if="cap.icon === 'tool'" :size="12" />
                          <Brain v-else-if="cap.icon === 'brain'" :size="12" />
                        </span>
                        <span v-if="formatContextLimit(entry.metadata)" class="context-badge">
                          {{ formatContextLimit(entry.metadata) }}
                        </span>
                      </div>
                    </button>
                    <div class="model-row-actions">
                      <button class="icon-btn primary" @click="openModelAddDialog(entry.model!)" title="添加">
                        <Plus :size="14" />
                      </button>
                    </div>
                  </div>
                </div>
                <div v-else class="models-empty small">点击"获取模型"加载可用模型列表</div>
              </div>
            </section>
          </div>
        </div>

        <!-- Empty State -->
        <div v-else class="workbench-empty">
          <MousePointerClick :size="48" class="empty-icon" />
          <p>请从左侧选择一个提供商源</p>
        </div>
      </div>
    </div>

    <!-- Non-Chat Types: Card Grid Layout -->
    <template v-else>
      <div v-if="filteredProviders.length === 0" class="empty-state-full">
        <Globe :size="48" class="empty-icon" />
        <p>暂无此类型的提供商</p>
        <button class="btn primary" @click="openAddProviderDialog()">
          <Plus :size="16" /> 添加提供商
        </button>
      </div>
      <div v-else class="providers-grid">
        <div v-for="provider in filteredProviders" :key="provider.id" :class="['provider-card', { disabled: !provider.enable }]">
          <div class="card-header">
            <div class="title-info">
              <div class="name-row">
                <h3>{{ provider.id }}</h3>
                <span v-if="!provider.enable" class="disabled-tag">已停用</span>
              </div>
              <span class="type-tag font-mono">{{ provider.type || provider.provider_type }}</span>
            </div>
            <div class="actions">
              <button
                :class="['btn icon-btn', provider.enable ? 'danger' : 'success']"
                :title="provider.enable ? '停用' : '启用'"
                @click="toggleProviderEnable(provider, !provider.enable)"
              >
                <Power :size="14" />
              </button>
            </div>
          </div>
          <div class="card-body">
            <div class="info-row">
              <span class="label">模型:</span>
              <span class="value font-mono text-truncate">{{ provider.model || '(未配置)' }}</span>
            </div>
            <div v-if="provider.api_base" class="info-row">
              <span class="label">API 地址:</span>
              <span class="value font-mono text-truncate">{{ provider.api_base }}</span>
            </div>
            <div v-if="provider.key" class="info-row">
              <span class="label">API Key:</span>
              <span class="value font-mono text-truncate">••••••••</span>
            </div>
            <div v-if="provider.modalities?.length" class="info-row">
              <span class="label">能力:</span>
              <div class="capability-list">
                <span v-for="cap in capabilityIcons(buildMetadataFromProvider(provider))" :key="cap.icon" class="capability-badge" :title="cap.label">
                  <Image v-if="cap.icon === 'image'" :size="11" />
                  <AudioWaveform v-else-if="cap.icon === 'audio'" :size="11" />
                  <Wrench v-else-if="cap.icon === 'tool'" :size="11" />
                  <Brain v-else-if="cap.icon === 'brain'" :size="11" />
                </span>
              </div>
            </div>
          </div>
          <div class="card-footer">
            <button
              class="btn sm"
              :disabled="!provider.enable || testingProviders.includes(provider.id)"
              @click="testProvider(provider)"
            >
              <RefreshCw v-if="testingProviders.includes(provider.id)" :size="14" class="animate-spin" />
              <Play v-else :size="12" />
              测试
            </button>
            <button class="btn sm primary" @click="openNonChatProviderEdit(provider)">
              <Pencil :size="14" /> 编辑配置
            </button>
            <button class="btn sm danger" title="删除" @click="deleteProvider(provider)">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Add Provider Dialog (non-chat) -->
    <Teleport to="body">
      <div v-if="showAddProviderDialog" class="modal-backdrop" @click="showAddProviderDialog = false">
        <div class="modal-content modal-lg" @click.stop>
          <div class="modal-header">
            <h3>添加新提供商</h3>
            <button class="close-btn" @click="showAddProviderDialog = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="tabs-container compact">
              <button
                v-for="tab in addProviderTabs"
                :key="tab.value"
                :class="['tab-btn', { active: addProviderTab === tab.value }]"
                @click="addProviderTab = tab.value"
              >
                {{ tab.label }}
              </button>
            </div>
            <div class="template-grid">
              <div
                v-for="(template, name) in getTemplatesByType(addProviderTab)"
                :key="name"
                class="template-card"
                @click="selectProviderTemplate(name as string)"
              >
                <div class="template-card-text">
                  <div class="template-card-title">{{ name }}</div>
                  <div class="template-card-desc">{{ template.type }}</div>
                </div>
                <div class="template-card-logo">
                  <img v-if="getProviderIcon(template.provider)" :src="getProviderIcon(template.provider)" class="template-logo-img" />
                  <div v-else class="template-logo-fallback">{{ (name as string)[0].toUpperCase() }}</div>
                </div>
              </div>
              <div v-if="Object.keys(getTemplatesByType(addProviderTab)).length === 0" class="no-templates">
                暂无此类型的提供商模板
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showAddProviderDialog = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Manual Model Dialog -->
    <Teleport to="body">
      <div v-if="showManualModelDialog" class="modal-backdrop" @click="showManualModelDialog = false">
        <div class="modal-content" @click.stop>
          <div class="modal-header">
            <h3>手动添加模型</h3>
            <button class="close-btn" @click="showManualModelDialog = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>模型 ID</label>
              <input type="text" v-model="manualModelId" class="form-control font-mono" placeholder="例如: gpt-4o" autofocus />
            </div>
            <div class="form-group">
              <label>生成提供商标识</label>
              <input type="text" :value="manualProviderId" class="form-control font-mono" disabled />
              <span class="help-text">自动根据源 ID 和模型 ID 生成</span>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showManualModelDialog = false">取消</button>
            <button class="btn primary" @click="confirmManualModel">添加</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Provider Edit Dialog -->
    <Teleport to="body">
      <div v-if="showProviderEditDialog" class="modal-backdrop" @click="showProviderEditDialog = false">
        <div class="modal-content" @click.stop>
          <div class="modal-header">
            <h3>{{ providerEditMode === 'add' ? '添加' : '编辑' }} {{ providerEditData?.id }}</h3>
            <button class="close-btn" @click="showProviderEditDialog = false"><X :size="20" /></button>
          </div>
          <div class="modal-body" v-if="providerEditData">
            <div class="form-grid">
              <div class="form-group">
                <label>提供商标识 ID</label>
                <input type="text" v-model="providerEditData.id" class="form-control font-mono" :disabled="providerEditMode === 'edit'" />
              </div>
              <div class="form-group">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <label style="margin-bottom: 0;">模型名称</label>
                  <button class="btn sm" @click="handleAutoDetectCapabilities" style="padding: 2px 6px; font-size: 0.8rem; display: flex; align-items: center; gap: 4px; cursor: pointer; border-radius: 4px;">
                    <Sparkles :size="12" /> 自动识别参数
                  </button>
                </div>
                <input type="text" v-model="providerEditData.model" class="form-control font-mono" :disabled="providerEditMode === 'edit'" />
              </div>
              <div class="form-group">
                <label>启用</label>
                <label class="toggle-label">
                  <input type="checkbox" v-model="providerEditData.enable" />
                  <span>{{ providerEditData.enable ? '启用' : '停用' }}</span>
                </label>
              </div>
              <div class="form-group">
                <label>最大上下文长度</label>
                <input type="number" v-model.number="providerEditData.max_context_tokens" class="form-control font-mono" />
              </div>
              <div class="form-group span-2">
                <label>模态能力 (modalities)</label>
                <div class="checkbox-group">
                  <label v-for="mod in ['text', 'image', 'audio', 'tool_use']" :key="mod" class="checkbox-label">
                    <input type="checkbox" :checked="providerEditData.modalities?.includes(mod)"
                      @change="toggleModality(providerEditData, mod)" />
                    <span>{{ mod }}</span>
                  </label>
                </div>
              </div>
              <div class="form-group">
                <label>推理模式</label>
                <label class="toggle-label">
                  <input type="checkbox" v-model="providerEditData.reasoning" />
                  <span>{{ providerEditData.reasoning ? '开启' : '关闭' }}</span>
                </label>
              </div>
              <div class="form-group">
                <label>模型默认温度 (Temperature)</label>
                <div style="display: flex; align-items: center; gap: 0.5rem;">
                  <input type="range" v-model.number="providerEditData.temperature" min="0" max="2" step="0.1" style="flex: 1; accent-color: var(--accent-primary);" />
                  <input type="number" v-model.number="providerEditData.temperature" min="0" max="2" step="0.1" class="form-control font-mono" style="width: 70px; text-align: center; padding: 0.3rem;" />
                </div>
                <span class="help-text">设置该模型的默认生成温度 (0.0 - 2.0，默认 0.7)</span>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" :disabled="savingProviders.includes(providerEditData?.id || '')" @click="showProviderEditDialog = false">取消</button>
            <button class="btn primary" :disabled="savingProviders.includes(providerEditData?.id || '')" @click="saveEditedProvider">
              {{ savingProviders.includes(providerEditData?.id || '') ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Non-Chat Provider Full Config Dialog -->
    <Teleport to="body">
      <div v-if="showNonChatConfigDialog" class="modal-backdrop" @click="showNonChatConfigDialog = false">
        <div class="modal-content modal-lg" @click.stop>
          <div class="modal-header">
            <h3>{{ nonChatConfigMode === 'add' ? '添加' : '编辑' }} {{ nonChatProviderLabel }} 提供商</h3>
            <button class="close-btn" @click="showNonChatConfigDialog = false"><X :size="20" /></button>
          </div>
          <div class="modal-body" v-if="nonChatConfigData">
            <!-- Basic Fields -->
            <div v-for="row in nonChatFieldRows" :key="row.map(f => f.key).join(',')" :class="['form-grid', { 'single-col': row.length === 1 }]">
              <div v-for="field in row" :key="field.key" :class="['form-group', { 'span-full': field.span }]">
                <label>{{ field.label }}</label>
                <span v-if="field.hint" class="help-text">{{ field.hint }}</span>

                <!-- String input -->
                <input
                  v-if="field.type === 'string' && !field.password"
                  type="text"
                  v-model="nonChatConfigData[field.key]"
                  class="form-control font-mono"
                  :placeholder="field.placeholder"
                  :disabled="field.disabled"
                />
                <!-- Password input -->
                <input
                  v-else-if="field.type === 'string' && field.password"
                  type="password"
                  v-model="nonChatConfigData[field.key]"
                  class="form-control font-mono"
                  :placeholder="field.placeholder"
                />
                <!-- Number input -->
                <input
                  v-else-if="field.type === 'number'"
                  type="number"
                  v-model.number="nonChatConfigData[field.key]"
                  class="form-control font-mono"
                  :placeholder="field.placeholder"
                />
                <!-- Toggle -->
                <label v-else-if="field.type === 'boolean'" class="toggle-label">
                  <input type="checkbox" v-model="nonChatConfigData[field.key]" />
                  <span>{{ nonChatConfigData[field.key] ? '启用' : '停用' }}</span>
                </label>
                <!-- Select -->
                <select
                  v-else-if="field.type === 'select'"
                  v-model="nonChatConfigData[field.key]"
                  class="form-control font-mono"
                >
                  <option v-for="opt in field.options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
              </div>
            </div>

            <!-- Dynamic extra fields not covered by schema -->
            <template v-if="nonChatUnknownFields.length > 0">
              <div class="config-divider" style="margin: 1rem 0;"></div>
              <div class="section-title" style="font-size: 14px; font-weight: 600; margin-bottom: 0.75rem;">其他配置</div>
              <div class="form-grid">
                <div v-for="field in nonChatUnknownFields" :key="field.key" class="form-group">
                  <label>{{ field.key }}</label>
                  <input
                    v-if="typeof field.value === 'string' && !field.value.startsWith('{')"
                    type="text"
                    v-model="nonChatConfigData[field.key]"
                    class="form-control font-mono"
                  />
                  <input
                    v-else-if="typeof field.value === 'number'"
                    type="number"
                    v-model.number="nonChatConfigData[field.key]"
                    class="form-control font-mono"
                  />
                  <label v-else-if="typeof field.value === 'boolean'" class="toggle-label">
                    <input type="checkbox" v-model="nonChatConfigData[field.key]" />
                    <span>{{ field.value ? '启用' : '停用' }}</span>
                  </label>
                  <textarea
                    v-else
                    v-model="nonChatConfigData[field.key]"
                    class="form-control font-mono textarea-sm"
                    rows="2"
                  ></textarea>
                </div>
              </div>
            </template>
          </div>
          <div class="modal-footer">
            <button class="btn" :disabled="nonChatConfigSaving" @click="showNonChatConfigDialog = false">取消</button>
            <button class="btn primary" :disabled="nonChatConfigSaving" @click="saveNonChatConfig">
              {{ nonChatConfigSaving ? '保存中...' : (nonChatConfigMode === 'add' ? '创建' : '保存') }}
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
.provider-page {
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

/* Tabs */
.tabs-container {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 0.5rem;
  flex-wrap: wrap;
}

.tabs-container.compact {
  margin-bottom: 1rem;
  border-bottom: none;
  padding-bottom: 0;
}

.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 0.6rem 1.2rem;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.2s ease;
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

/* Workbench Layout */
.provider-workbench {
  border: 1px solid var(--border-color);
  border-radius: 24px;
  background: var(--bg-card);
  backdrop-filter: var(--glass-blur);
  display: grid;
  grid-template-columns: minmax(260px, 300px) 1px minmax(0, 1fr);
  min-height: 700px;
  overflow: hidden;
}

.workbench-sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.workbench-divider {
  background: var(--border-color);
}

.workbench-main {
  display: flex;
  min-width: 0;
}

/* Sidebar */
.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 20px 12px;
}

.sidebar-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}

.sidebar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.add-source-wrapper {
  position: relative;
}

.add-source-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 220px;
  background: var(--bg-modal);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  z-index: 100;
  padding: 4px;
  max-height: 320px;
  overflow-y: auto;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  border-radius: 8px;
  font-size: 14px;
  text-align: left;
  transition: background 0.15s;
}

.menu-item:hover {
  background: rgba(99, 102, 241, 0.08);
}

.menu-item-icon {
  width: 20px;
  height: 20px;
  object-fit: contain;
  border-radius: 4px;
}

.menu-item-fallback {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: var(--accent-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.menu-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.source-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source-item {
  width: 100%;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: inherit;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.source-item:hover,
.source-item.active {
  background: rgba(255, 255, 255, 0.05);
}

body.light-theme .source-item:hover,
body.light-theme .source-item.active {
  background: rgba(15, 23, 42, 0.05);
}

.source-icon {
  width: 28px;
  height: 28px;
  object-fit: contain;
  border-radius: 6px;
  flex-shrink: 0;
}

.source-icon-fallback {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: rgba(99, 102, 241, 0.12);
  color: var(--accent-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
}

.source-item-content {
  min-width: 0;
  flex: 1;
}

.source-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
}

.source-item-subtitle {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-delete-btn {
  opacity: 0;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.15s;
}

.source-item:hover .source-delete-btn {
  opacity: 1;
}

.source-delete-btn:hover {
  color: var(--accent-danger);
  background: rgba(239, 68, 68, 0.1);
}

.sidebar-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

/* Config Shell */
.config-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.config-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 18px 22px 14px;
}

.config-title {
  font-size: 21px;
  line-height: 1.1;
  font-weight: 680;
  letter-spacing: -0.03em;
  overflow-wrap: anywhere;
}

.config-subtitle {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.config-divider {
  height: 1px;
  background: var(--border-color);
}

.config-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.config-section {
  padding: 18px 22px;
}

.section-title {
  font-size: 16px;
  font-weight: 650;
  margin-bottom: 12px;
}

.section-subtitle {
  color: var(--text-muted);
  font-size: 12px;
}

/* Form */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.25rem;
}

.form-grid > .span-2 {
  grid-column: span 2;
}

@media (max-width: 768px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
  .form-grid > .span-2 {
    grid-column: span 1;
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
}

.form-control:focus {
  border-color: var(--accent-primary);
}

.form-control:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.help-text {
  font-size: 0.78rem;
  color: var(--text-muted);
  line-height: 1.4;
}

.form-grid.single-col {
  grid-template-columns: 1fr;
}

.form-group.span-full {
  grid-column: 1 / -1;
}

select.form-control {
  appearance: auto;
  -webkit-appearance: auto;
  -moz-appearance: auto;
  cursor: pointer;
}

.form-control.sm {
  font-size: 0.82rem;
  padding: 0.4rem 0.6rem;
}

.textarea-sm {
  font-size: 0.82rem;
  resize: vertical;
  min-height: 40px;
}

.help-text {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 0.9rem;
}

.toggle-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-primary);
}

.checkbox-group {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  font-family: monospace;
}

.checkbox-label input[type="checkbox"] {
  width: 15px;
  height: 15px;
  accent-color: var(--accent-primary);
}

/* Models Panel */
.models-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.models-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

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

.search-box .form-control {
  padding-left: 32px;
}

.models-section {
  padding: 4px 0;
}

.models-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 650;
}

.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent-primary);
  font-weight: 600;
}

.models-list {
  display: flex;
  flex-direction: column;
}

.models-list-available {
  max-height: 420px;
  overflow-y: auto;
}

.model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
}

.model-row:last-child {
  border-bottom: 0;
}

.model-row-main {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  color: inherit;
  padding: 0;
  text-align: left;
  cursor: pointer;
}

.model-row-title {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.model-row-title.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.model-row-subtitle {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.model-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.capability-badge {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

body.light-theme .capability-badge {
  background: rgba(15, 23, 42, 0.05);
}

.context-badge {
  padding: 0 8px;
  height: 24px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
}

body.light-theme .context-badge {
  background: rgba(15, 23, 42, 0.05);
}

.model-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.toggle-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  transition: all 0.15s;
}

.toggle-btn.active {
  color: var(--accent-success);
}

.toggle-btn:hover {
  background: rgba(255, 255, 255, 0.05);
}

.toggle-btn.sm {
  padding: 4px;
}

.toggle-btn.sm .lucide {
  width: 12px;
  height: 12px;
}

.icon-btn.sm {
  padding: 4px;
}

.icon-btn.sm .lucide {
  width: 12px;
  height: 12px;
}

/* Linked Providers List */
.linked-providers-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.linked-provider-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

body.light-theme .linked-provider-row {
  background: rgba(15, 23, 42, 0.02);
}

.linked-provider-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.linked-provider-id {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.linked-provider-model {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}

.status-dot.active {
  background: var(--accent-success);
}

.linked-provider-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.icon-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  transition: all 0.15s;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.icon-btn.primary:hover {
  color: var(--accent-primary);
  background: rgba(99, 102, 241, 0.1);
}

.icon-btn.test-btn:hover:not(:disabled) {
  color: #34D399;
  background: rgba(52, 211, 153, 0.1);
}

.icon-btn.danger:hover {
  color: var(--accent-danger);
  background: rgba(239, 68, 68, 0.1);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.models-empty {
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
}

.models-empty.small {
  min-height: 80px;
}

/* Workbench Empty */
.workbench-empty {
  flex: 1;
  min-height: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
}

.empty-icon {
  opacity: 0.4;
}

/* Non-Chat Provider Cards */
.providers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 1.5rem;
}

.provider-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1.5rem;
  backdrop-filter: var(--glass-blur);
  display: flex;
  flex-direction: column;
  transition: all 0.2s ease-in-out;
}

.provider-card:hover {
  border-color: var(--border-color-hover);
  transform: translateY(-2px);
  background: var(--bg-card-hover);
}

.provider-card.disabled {
  opacity: 0.55;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}

.title-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  max-width: 75%;
}

.name-row h3 {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.disabled-tag {
  font-size: 0.72rem;
  font-weight: 600;
  color: #94a3b8;
  background: rgba(100, 116, 139, 0.15);
  border: 1px solid rgba(100, 116, 139, 0.25);
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
}

.type-tag {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.actions {
  display: flex;
  gap: 0.4rem;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-bottom: 1.25rem;
  flex-grow: 1;
}

.info-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.85rem;
}

.info-row .label {
  color: var(--text-muted);
}

.info-row .value {
  color: var(--text-primary);
  max-width: 65%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capability-list {
  display: flex;
  gap: 4px;
}

.card-footer {
  border-top: 1px solid var(--border-color);
  padding-top: 1rem;
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

/* Empty State Full */
.empty-state-full {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  gap: 1rem;
  color: var(--text-muted);
  text-align: center;
  background: rgba(255, 255, 255, 0.01);
  border: 1px dashed var(--border-color);
  border-radius: 12px;
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
  color: #fff;
}

.btn.primary:hover {
  background: var(--accent-primary-hover);
}

.btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  border-radius: 6px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.icon-btn.success {
  color: var(--accent-success);
}

.icon-btn.success:hover {
  background: rgba(16, 185, 129, 0.1);
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

/* Template Cards */
.template-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
}

.template-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(255, 255, 255, 0.02);
}

.template-card:hover {
  border-color: var(--accent-primary);
  transform: translateY(-2px);
  background: rgba(99, 102, 241, 0.04);
}

.template-card-text {
  flex: 1;
  min-width: 0;
}

.template-card-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.template-card-desc {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.template-card-logo {
  flex-shrink: 0;
}

.template-logo-img {
  width: 36px;
  height: 36px;
  object-fit: contain;
  opacity: 0.7;
}

.template-logo-fallback {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 700;
  opacity: 0.4;
}

.no-templates {
  grid-column: 1 / -1;
  text-align: center;
  padding: 2rem;
  color: var(--text-muted);
  font-size: 14px;
}

/* Toast */
.toast {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 12px 28px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  z-index: 9999;
  animation: toastIn 0.2s ease-out;
  max-width: 400px;
  text-align: center;
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
  from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

/* Utility */
.font-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.text-truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

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

.animate-spin {
  animation: spin 1s linear infinite;
}

/* Responsive */
@media (max-width: 960px) {
  .provider-workbench {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1px auto;
    min-height: auto;
  }

  .workbench-divider {
    height: 1px;
  }

  .config-header {
    flex-direction: column;
    align-items: stretch;
    padding: 16px;
  }

  .config-section {
    padding: 16px;
  }

  .models-toolbar {
    flex-direction: column;
  }

  .models-actions {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .provider-workbench {
    border-radius: 16px;
  }

  .config-title {
    font-size: 18px;
  }

  .model-row {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .model-row-actions {
    align-self: flex-end;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .template-grid {
    grid-template-columns: 1fr;
  }
}
</style>
