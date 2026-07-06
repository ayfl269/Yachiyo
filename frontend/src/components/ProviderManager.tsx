import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, Save, Trash2, RefreshCw, Search, Download,
  Pencil, Power, Image as ImageIcon,
  AudioWaveform, Wrench, Brain, Globe,
  Play, Sparkles, Eye, EyeOff
} from 'lucide-react'
import { useToast, ToastPortal, Modal } from './shared'
import { apiFetch } from '../lib/api'

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

// ===== Provider Icon Map =====
const providerIconMap: Record<string, string> = {
  'openai': '/provider_logos/openai.svg',
  'anthropic': '/provider_logos/anthropic.svg',
  'google': '/provider_logos/gemini-color.svg',
}

function getProviderIcon(provider: string): string {
  return providerIconMap[provider] || ''
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
    openai_whisper_api: 'speech_to_text', openai_stt: 'speech_to_text',
    openai_tts_api: 'text_to_speech', openai_tts: 'text_to_speech',
    edge_tts: 'text_to_speech', dashscope_tts: 'text_to_speech',
    openai_embedding: 'embedding', gemini_embedding: 'embedding',
    cohere: 'rerank', jina: 'rerank', voyage: 'rerank', generic_rerank: 'rerank',
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

function generateUniqueSourceId(baseId: string, existing: ProviderSource[]): string {
  const existingIds = new Set(existing.map(s => s.id))
  if (!existingIds.has(baseId)) return baseId
  let counter = 1
  let candidate = `${baseId}_${counter}`
  while (existingIds.has(candidate)) { counter++; candidate = `${baseId}_${counter}` }
  return candidate
}

function autoDetectModelCapabilities(modelName: string) {
  const name = modelName.toLowerCase();

  const isReasoning = name.includes('o1-') ||
                      name.includes('o3-') ||
                      name.includes('r1') ||
                      name.includes('reasoning') ||
                      name.startsWith('qwq') ||
                      name.includes('math');

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
    maxContext = 1048576;
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

  const modalities = ['text'];

  const hasVision = name.includes('vision') ||
                    name.includes('vl') ||
                    name.includes('-v') ||
                    name.includes('gpt-4o') ||
                    name.includes('claude-3-5') ||
                    name.includes('claude-3-opus') ||
                    name.includes('claude-3-sonnet') ||
                    name.includes('gemini');
  if (hasVision) modalities.push('image');

  const hasAudio = name.includes('audio') ||
                    name.includes('gemini-1.5') ||
                    name.includes('gemini-2.0') ||
                    name.includes('gpt-4o-audio');
  if (hasAudio) modalities.push('audio');

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

// Non-chat provider field schema
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

function getTemplatesByType(schema: Record<string, any>, type: string): Record<string, any> {
  const templates = schema.provider?.config_template || {}
  const filtered: Record<string, any> = {}
  for (const [name, template] of Object.entries(templates)) {
    if ((template as any).provider_type === type) filtered[name] = template
  }
  return filtered
}

// ===== Component =====
async function parseResponseJson(res: Response): Promise<any> {
  if (!res.ok) {
    let errMessage = `HTTP ${res.status}`
    try {
      const err = await res.json()
      errMessage = err.message || err.error || errMessage
    } catch {
      // Response wasn't JSON — use the status code
    }
    throw new Error(errMessage)
  }
  return res.json()
}

export default function ProviderManager() {
  // ===== State =====
  const [loading, setLoading] = useState(true)
  const [configSchema, setConfigSchema] = useState<Record<string, any>>({})
  const [providerTemplates, setProviderTemplates] = useState<Record<string, any>>({})
  const [providerSources, setProviderSources] = useState<ProviderSource[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [selectedProviderType, setSelectedProviderType] = useState('chat_completion')
  const [selectedProviderSource, setSelectedProviderSource] = useState<ProviderSource | null>(null)
  const [selectedProviderSourceOriginalId, setSelectedProviderSourceOriginalId] = useState<string | null>(null)
  const [editableProviderSource, setEditableProviderSource] = useState<ProviderSource | null>(null)
  const [availableModels, setAvailableModels] = useState<any[]>([])
  const [modelMetadata, setModelMetadata] = useState<Record<string, any>>({})
  const [loadingModels, setLoadingModels] = useState(false)
  const [savingSource, setSavingSource] = useState(false)
  const [testingProviders, setTestingProviders] = useState<string[]>([])
  const [savingProviders, setSavingProviders] = useState<string[]>([])
  const [isSourceModified, setIsSourceModified] = useState(false)
  const [modelSearch, setModelSearch] = useState('')

  // Dialog states
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false)
  const [addProviderTab, setAddProviderTab] = useState('speech_to_text')
  const [showManualModelDialog, setShowManualModelDialog] = useState(false)
  const [manualModelId, setManualModelId] = useState('')
  const [showProviderEditDialog, setShowProviderEditDialog] = useState(false)
  const [providerEditData, setProviderEditData] = useState<Provider | null>(null)
  const [providerEditOriginalId, setProviderEditOriginalId] = useState('')
  const [providerEditMode, setProviderEditMode] = useState<'add' | 'edit'>('edit')
  const [showAddSourceMenu, setShowAddSourceMenu] = useState(false)
  const [showSourceDrawer, setShowSourceDrawer] = useState(false)
  const [isNewProviderSource, setIsNewProviderSource] = useState(false)

  // Non-chat provider full config dialog
  const [showNonChatConfigDialog, setShowNonChatConfigDialog] = useState(false)
  const [nonChatConfigData, setNonChatConfigData] = useState<Record<string, any> | null>(null)
  const [nonChatConfigMode, setNonChatConfigMode] = useState<'add' | 'edit'>('edit')
  const [nonChatConfigSaving, setNonChatConfigSaving] = useState(false)

  // API Key visibility toggles
  const [showSourceApiKey, setShowSourceApiKey] = useState(false)
  const [showNonChatPassword, setShowNonChatPassword] = useState<Record<string, boolean>>({})
  const [revealedCardKeys, setRevealedCardKeys] = useState<Set<string>>(new Set())
  // Cache of revealed real API keys (source/provider id -> real key)
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({})

  /** Fetch the real API key from backend for a given source/provider id. */
  async function fetchRealKey(id: string): Promise<string> {
    if (revealedKeys[id]) return revealedKeys[id]
    try {
      const res = await apiFetch(`/api/config/provider_sources/reveal_key?id=${encodeURIComponent(id)}`)
      const data = await res.json()
      if (data.status === 'ok' && data.key) {
        setRevealedKeys(prev => ({ ...prev, [id]: data.key }))
        return data.key as string
      }
    } catch { /* ignore */ }
    return ''
  }

  // Toast
  const { toast, showMessage } = useToast()

  // ===== Computed =====
  const availableSourceTypes = useMemo(() => {
    if (!providerTemplates) return []
    const types: Array<{ value: string; label: string; icon: string }> = []
    for (const [name, template] of Object.entries(providerTemplates)) {
      if (template.provider_type === selectedProviderType) {
        types.push({ value: name, label: name, icon: getProviderIcon(template.provider) })
      }
    }
    return types
  }, [providerTemplates, selectedProviderType])

  const displayedProviderSources = useMemo(() => {
    return providerSources.filter(s =>
      s.provider_type === selectedProviderType ||
      (s.type && isTypeMatchingProviderType(s.type, selectedProviderType))
    )
  }, [providerSources, selectedProviderType])

  const sourceProviders = useMemo(() => {
    if (!selectedProviderSource) return []
    return providers.filter(p => p.provider_source_id === selectedProviderSource.id)
  }, [providers, selectedProviderSource])

  const existingModelsForSelectedSource = useMemo(() => {
    return new Set(sourceProviders.map(p => p.model))
  }, [sourceProviders])

  const mergedModelEntries = useMemo<ModelEntry[]>(() => {
    const configured: ModelEntry[] = sourceProviders.map(provider => ({
      type: 'configured',
      provider,
      metadata: modelMetadata?.[provider.model] || buildMetadataFromProvider(provider)
    }))

    const available: ModelEntry[] = (availableModels || [])
      .filter((item: any) => {
        const name = typeof item === 'string' ? item : item?.name
        return !existingModelsForSelectedSource.has(name)
      })
      .map((item: any) => {
        const name = typeof item === 'string' ? item : item?.name
        return {
          type: 'available',
          model: name,
          metadata: typeof item === 'object' ? item?.metadata : modelMetadata?.[name]
        }
      })

    return [...configured, ...available]
  }, [sourceProviders, modelMetadata, availableModels, existingModelsForSelectedSource])

  const filteredMergedModelEntries = useMemo(() => {
    const term = modelSearch.trim().toLowerCase()
    if (!term) return mergedModelEntries
    return mergedModelEntries.filter(entry => {
      if (entry.type === 'configured') {
        return (entry.provider?.id?.toLowerCase().includes(term) || entry.provider?.model?.toLowerCase().includes(term))
      }
      return entry.model?.toLowerCase().includes(term)
    })
  }, [mergedModelEntries, modelSearch])

  const configuredEntries = useMemo(() => filteredMergedModelEntries.filter(e => e.type === 'configured'), [filteredMergedModelEntries])
  const availableEntries = useMemo(() => filteredMergedModelEntries.filter(e => e.type === 'available'), [filteredMergedModelEntries])

  const filteredProviders = useMemo(() => {
    if (selectedProviderType === 'chat_completion') return []
    return providers.filter(p => getProviderType(p) === selectedProviderType)
  }, [selectedProviderType, providers])

  const manualProviderId = useMemo(() => {
    if (!selectedProviderSource || !manualModelId.trim()) return ''
    return `${selectedProviderSource.id}/${manualModelId.trim()}`
  }, [selectedProviderSource, manualModelId])

  const advancedSourceConfig = useMemo(() => {
    if (!editableProviderSource) return null
    const excluded = new Set(['id', 'key', 'api_base', 'enable', 'type', 'provider_type', 'provider'])
    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(editableProviderSource)) {
      if (!excluded.has(key)) {
        result[key] = value
      }
    }
    return Object.keys(result).length > 0 ? result : null
  }, [editableProviderSource])

  const templatesForCurrentTab = useMemo(() => getTemplatesByType(configSchema, addProviderTab), [configSchema, addProviderTab])

  const nonChatProviderLabel = useMemo(() => {
    if (!nonChatConfigData) return ''
    const pt = nonChatConfigData.provider_type || ''
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
    return typeMap[nonChatConfigData.type as string] || providerTypeLabels[pt] || pt
  }, [nonChatConfigData])

  const nonChatFieldRows = useMemo(() => {
    if (!nonChatConfigData) return []
    const pt = nonChatConfigData.provider_type || ''
    return nonChatFieldSchema[pt] || nonChatFieldSchema['embedding'] || []
  }, [nonChatConfigData])

  const nonChatUnknownFields = useMemo(() => {
    if (!nonChatConfigData) return []
    const schemaKeys = new Set<string>()
    for (const row of nonChatFieldRows) {
      for (const f of row) schemaKeys.add(f.key)
    }
    const excludeKeys = new Set(['modalities', 'provider_source_id', 'custom_extra_body', 'provider_type', 'type', 'max_context_tokens', 'reasoning'])
    const fields: Array<{ key: string; value: any }> = []
    for (const [key, value] of Object.entries(nonChatConfigData)) {
      if (!schemaKeys.has(key) && !excludeKeys.has(key)) {
        fields.push({ key, value })
      }
    }
    return fields
  }, [nonChatConfigData, nonChatFieldRows])

  // ===== API Methods =====
  async function loadConfig() {
    try {
      const res = await apiFetch('/api/config/provider/template')
      const json = await parseResponseJson(res)
      if (json.status === 'ok') {
        const schema = json.data.config_schema || {}
        setConfigSchema(schema)
        setProviderTemplates(schema.provider?.config_template || {})
        setProviderSources(json.data.provider_sources || [])
        setProviders(json.data.providers || [])
      }
    } catch (error) {
      console.error('Failed to load provider template:', error)
    } finally {
      setLoading(false)
    }
  }

  function selectProviderSource(source: ProviderSource | null) {
    setSelectedProviderSource(source)
    setSelectedProviderSourceOriginalId(source?.id || null)
    setEditableProviderSource(source ? structuredClone(source) : null)
    setAvailableModels([])
    setModelMetadata({})
    setIsSourceModified(false)
  }

  function addProviderSource(templateKey: string) {
    const template = providerTemplates[templateKey]
    if (!template) { showMessage('未找到对应的模板配置', 'error'); return }

    const newId = generateUniqueSourceId(template.id || templateKey, providerSources)
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

    setProviderSources(prev => [...prev, newSource])
    selectProviderSource(newSource)
    setIsSourceModified(true)
    setIsNewProviderSource(true)
    setShowAddSourceMenu(false)
    setShowSourceDrawer(true)
  }

  async function deleteProviderSource(source: ProviderSource) {
    if (!window.confirm(`确定要删除提供商源 "${source.id}" 吗？`)) return
    try {
      const res = await apiFetch('/api/config/provider_sources/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: source.id })
      })
      const json = await parseResponseJson(res)
      if (json.status === 'error') { showMessage(json.message, 'error'); return }

      setProviders(prev => prev.filter(p => p.provider_source_id !== source.id))
      setProviderSources(prev => prev.filter(s => s.id !== source.id))
      if (selectedProviderSource?.id === source.id) {
        selectProviderSource(null)
        setShowSourceDrawer(false)
      }
      showMessage('提供商源已删除')
    } catch (error: any) {
      showMessage(error.message || '删除失败', 'error')
    }
  }

  async function toggleProviderSourceEnable(source: ProviderSource, value: boolean) {
    const nextSource = { ...source, enable: value }
    setProviderSources(prev => prev.map(s => s.id === source.id ? nextSource : s))
    setEditableProviderSource(prev => (prev && prev.id === source.id) ? { ...prev, enable: value } : prev)
    setSelectedProviderSource(prev => (prev && prev.id === source.id) ? { ...prev, enable: value } : prev)
    try {
      const res = await apiFetch('/api/config/provider_sources/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: nextSource, original_id: source.id })
      })
      const json = await parseResponseJson(res)
      if (json.status !== 'ok') throw new Error(json.message)
      showMessage(json.message || '状态已更新')
    } catch (error: any) {
      setProviderSources(prev => prev.map(s => s.id === source.id ? source : s))
      setEditableProviderSource(prev => (prev && prev.id === source.id) ? { ...prev, enable: source.enable } : prev)
      setSelectedProviderSource(prev => (prev && prev.id === source.id) ? { ...prev, enable: source.enable } : prev)
      showMessage(error.message || '更新失败', 'error')
    }
  }

  function openSourceDrawer(source: ProviderSource) {
    selectProviderSource(source)
    setIsNewProviderSource(false)
    setShowAddSourceMenu(false)
    setShowSourceDrawer(true)
  }

  function closeSourceDrawer() {
    // Discard unsaved new provider source on close
    if (isNewProviderSource && editableProviderSource) {
      setProviderSources(prev => prev.filter(s => s.id !== editableProviderSource.id))
    }
    setShowSourceDrawer(false)
    selectProviderSource(null)
    setIsNewProviderSource(false)
  }

  async function saveProviderSource(): Promise<boolean> {
    if (!editableProviderSource) return false
    setSavingSource(true)
    const originalId = selectedProviderSourceOriginalId || editableProviderSource.id
    try {
      const res = await apiFetch('/api/config/provider_sources/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: editableProviderSource, original_id: originalId })
      })
      const json = await parseResponseJson(res)
      if (json.status !== 'ok') throw new Error(json.message)

      if (editableProviderSource.id !== originalId) {
        setProviders(prev => prev.map(p =>
          p.provider_source_id === originalId
            ? { ...p, provider_source_id: editableProviderSource!.id }
            : p
        ))
        setSelectedProviderSourceOriginalId(editableProviderSource.id)
      }

      const updatedSource = structuredClone(editableProviderSource)
      setProviderSources(prev => {
        const idx = prev.findIndex(ps => ps.id === originalId)
        if (idx !== -1) {
          const next = [...prev]
          next[idx] = updatedSource
          return next
        }
        return prev
      })
      setSelectedProviderSource(updatedSource)
      setEditableProviderSource(structuredClone(updatedSource))
      setIsSourceModified(false)
      setIsNewProviderSource(false)
      showMessage(json.message || '保存成功')
      return true
    } catch (error: any) {
      showMessage(error.message || '保存失败', 'error')
      return false
    } finally {
      setSavingSource(false)
    }
  }

  async function fetchAvailableModels() {
    if (!selectedProviderSource) return
    if (isSourceModified) {
      const ok = await saveProviderSource()
      if (!ok) {
        showMessage('请先保存提供商源配置', 'error')
        return
      }
    }
    setLoadingModels(true)
    try {
      const sourceId = editableProviderSource?.id || selectedProviderSource.id
      const res = await apiFetch(`/api/config/provider_sources/models?source_id=${encodeURIComponent(sourceId)}`)
      const json = await parseResponseJson(res)
      if (json.status === 'ok') {
        const meta = json.data.model_metadata || {}
        setModelMetadata(meta)
        setAvailableModels((json.data.models || []).map((model: string) => ({
          name: model,
          metadata: meta?.[model] || null
        })))
        if ((json.data.models || []).length === 0) showMessage('未找到可用模型', 'info')
      } else {
        throw new Error(json.message)
      }
    } catch (error: any) {
      setModelMetadata({})
      showMessage(error.message || '获取模型列表失败', 'error')
    } finally {
      setLoadingModels(false)
    }
  }

  function buildModelProviderConfig(modelName: string): Provider | null {
    if (!selectedProviderSource) return null
    const sourceId = editableProviderSource?.id || selectedProviderSource.id
    const newId = `${sourceId}/${modelName}`
    const meta = modelMetadata?.[modelName]

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

  async function deleteProvider(provider: Provider) {
    if (!window.confirm(`确定要删除 "${provider.id}" 吗？`)) return
    try {
      const res = await apiFetch('/api/config/provider/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: provider.id })
      })
      const json = await parseResponseJson(res)
      if (json.status === 'error') throw new Error(json.message)
      setProviders(prev => prev.filter(p => p.id !== provider.id))
      showMessage('模型提供商已删除')
    } catch (error: any) {
      showMessage(error.message || '删除失败', 'error')
    }
  }

  async function toggleProviderEnable(provider: Provider, value: boolean) {
    try {
      const nextConfig = { ...provider, enable: value }
      const res = await apiFetch('/api/config/provider/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: provider.id, config: nextConfig })
      })
      const json = await parseResponseJson(res)
      if (json.status === 'error') throw new Error(json.message)
      setProviders(prev => prev.map(p => p.id === provider.id ? { ...p, enable: value } : p))
      showMessage(json.message || '状态已更新')
    } catch (error: any) {
      showMessage(error.message || '更新失败', 'error')
    }
  }

  async function testProvider(provider: Provider) {
    if (testingProviders.includes(provider.id)) return
    setTestingProviders(prev => [...prev, provider.id])
    try {
      const startTime = performance.now()
      const res = await apiFetch(`/api/config/provider/check_one?id=${encodeURIComponent(provider.id)}`)
      const json = await parseResponseJson(res)
      if (json.status === 'ok' && json.data?.error === null) {
        const latency = Math.max(0, Math.round(performance.now() - startTime))
        showMessage(`测试成功: ${provider.id} (${latency}ms)`)
      } else {
        throw new Error(json.data?.error || '测试失败')
      }
    } catch (error: any) {
      showMessage(error.message || '测试失败', 'error')
    } finally {
      setTestingProviders(prev => prev.filter(id => id !== provider.id))
    }
  }

  // Provider edit dialog
  function openProviderEdit(provider: Provider) {
    const data = structuredClone(provider)
    if (data.temperature === undefined) {
      data.temperature = 0.7
    }
    setProviderEditData(data)
    setProviderEditOriginalId(provider.id)
    setProviderEditMode('edit')
    setShowProviderEditDialog(true)
  }

  function openModelAddDialog(modelName: string) {
    if (!selectedProviderSource) { showMessage('请先选择提供商源', 'error'); return }
    if (existingModelsForSelectedSource.has(modelName)) { showMessage('该模型已配置', 'error'); return }
    const newConfig = buildModelProviderConfig(modelName)
    if (!newConfig) return
    setProviderEditData(newConfig)
    setProviderEditOriginalId('')
    setProviderEditMode('add')
    setShowProviderEditDialog(true)
  }

  async function saveEditedProvider() {
    if (!providerEditData) return
    const targetId = providerEditData.id
    setSavingProviders(prev => [...prev, targetId])
    try {
      const isAdding = providerEditMode === 'add'
      const res = isAdding
        ? await apiFetch('/api/config/provider/new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(providerEditData)
          })
        : await apiFetch('/api/config/provider/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: providerEditOriginalId || providerEditData.id,
              config: providerEditData
            })
          })
      const json = await parseResponseJson(res)
      if (json.status === 'error') throw new Error(json.message)
      showMessage(json.message || (isAdding ? '添加成功' : '更新成功'))
      if (isAdding) {
        setProviders(prev => [...prev, providerEditData])
      } else {
        setProviders(prev => prev.map(p => p.id === providerEditData.id ? providerEditData : p))
      }
      setShowProviderEditDialog(false)
    } catch (error: any) {
      showMessage(error.message || '保存失败', 'error')
    } finally {
      setSavingProviders(prev => prev.filter(id => id !== targetId))
    }
  }

  // Manual model dialog
  function openManualModelDialog() {
    if (!selectedProviderSource) { showMessage('请先选择提供商源', 'error'); return }
    setManualModelId('')
    setShowManualModelDialog(true)
  }

  function confirmManualModel() {
    const modelId = manualModelId.trim()
    if (!modelId) { showMessage('请输入模型 ID', 'error'); return }
    if (existingModelsForSelectedSource.has(modelId)) { showMessage('该模型已配置', 'error'); return }
    setShowManualModelDialog(false)
    openModelAddDialog(modelId)
  }

  // Add provider dialog (for non-chat types)
  async function selectProviderTemplate(name: string) {
    const template = providerTemplates[name]
    if (!template) return
    setNonChatConfigData(structuredClone(template))
    setNonChatConfigMode('add')
    setShowAddProviderDialog(false)
    setShowNonChatConfigDialog(true)
  }

  function openAddProviderDialog() {
    setAddProviderTab(selectedProviderType)
    setShowAddProviderDialog(true)
  }

  // Non-chat provider full config edit
  function openNonChatProviderEdit(provider: Provider) {
    setNonChatConfigData(structuredClone(provider))
    setNonChatConfigMode('edit')
    setShowNonChatConfigDialog(true)
  }

  async function saveNonChatConfig() {
    if (!nonChatConfigData) return
    setNonChatConfigSaving(true)
    try {
      const isEditing = nonChatConfigMode === 'edit'
      const res = isEditing
        ? await apiFetch('/api/config/provider/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: nonChatConfigData.id,
              config: nonChatConfigData
            })
          })
        : await apiFetch('/api/config/provider/new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(nonChatConfigData)
          })
      const json = await parseResponseJson(res)
      if (json.status === 'error') throw new Error(json.message)
      showMessage(json.message || (isEditing ? '更新成功' : '添加成功'))
      setShowNonChatConfigDialog(false)
      loadConfig()
    } catch (error: any) {
      showMessage(error.message || '保存失败', 'error')
    } finally {
      setNonChatConfigSaving(false)
    }
  }

  // ===== Field updaters =====
  function setSourceField(key: string, value: any) {
    setEditableProviderSource(prev => prev ? { ...prev, [key]: value } : prev)
    setIsSourceModified(true)
  }

  function tryParseJson(e: ChangeEvent<HTMLTextAreaElement>, key: string) {
    try {
      const parsed = JSON.parse(e.target.value)
      setEditableProviderSource(prev => prev ? { ...prev, [key]: parsed } : prev)
      setIsSourceModified(true)
    } catch {
      // ignore parse errors, keep the raw text
    }
  }

  function setProviderEditField(key: string, value: any) {
    setProviderEditData(prev => prev ? { ...prev, [key]: value } : prev)
  }

  function toggleModality(mod: string) {
    setProviderEditData(prev => {
      if (!prev) return prev
      const mods = prev.modalities ? [...prev.modalities] : []
      const idx = mods.indexOf(mod)
      if (idx >= 0) mods.splice(idx, 1)
      else mods.push(mod)
      return { ...prev, modalities: mods }
    })
  }

  function setNonChatField(key: string, value: any) {
    setNonChatConfigData(prev => prev ? { ...prev, [key]: value } : prev)
  }

  function handleAutoDetectCapabilities() {
    if (!providerEditData) return
    const auto = autoDetectModelCapabilities(providerEditData.model)
    setProviderEditData(prev => prev ? {
      ...prev,
      max_context_tokens: auto.maxContext,
      reasoning: auto.isReasoning,
      modalities: auto.modalities
    } : prev)
    showMessage('已自动识别并填充模型参数', 'success')
  }

  // ===== Lifecycle =====
  useEffect(() => {
    void loadConfig()
  }, [])

  // Watch tab changes to deselect source if needed
  useEffect(() => {
    setSelectedProviderSource(null)
    setSelectedProviderSourceOriginalId(null)
    setEditableProviderSource(null)
    setAvailableModels([])
    setModelMetadata({})
    setIsSourceModified(false)
    setShowSourceDrawer(false)
  }, [selectedProviderType])

  // ===== Render helpers =====
  function renderCapabilityIcon(cap: { icon: string; label: string }, size: number) {
    switch (cap.icon) {
      case 'image': return <ImageIcon key={cap.icon} size={size} />
      case 'audio': return <AudioWaveform key={cap.icon} size={size} />
      case 'tool': return <Wrench key={cap.icon} size={size} />
      case 'brain': return <Brain key={cap.icon} size={size} />
      default: return null
    }
  }

  const editSaving = savingProviders.includes(providerEditData?.id || '')

  return (
    <div className="provider-page animate-fade-in">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1>模型提供商</h1>
          <p>集中管理对话模型、向量嵌入、重排序及语音生成/识别等第三方 API 通道</p>
        </div>
        {selectedProviderType === 'chat_completion' ? (
          <div className="add-source-wrapper">
            <button className="btn primary" onClick={() => setShowAddSourceMenu(!showAddSourceMenu)}>
              <Plus size={16} /> 新增提供商源
            </button>
            {showAddSourceMenu && (
              <div className="add-source-menu">
                {availableSourceTypes.map(sourceType => (
                  <button
                    key={sourceType.value}
                    className="menu-item"
                    onClick={() => addProviderSource(sourceType.value)}
                  >
                    {sourceType.icon ? (
                      <img src={sourceType.icon} className="menu-item-icon" alt="" />
                    ) : (
                      <span className="menu-item-fallback">{sourceType.label[0]}</span>
                    )}
                    <span>{sourceType.label}</span>
                  </button>
                ))}
                {availableSourceTypes.length === 0 && <div className="menu-empty">暂无可用模板</div>}
              </div>
            )}
          </div>
        ) : (
          <button className="btn primary" onClick={openAddProviderDialog}>
            <Plus size={16} /> 添加提供商
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="tabs-container">
        {providerTypes.map(type => (
          <button
            key={type.value}
            className={`tab-btn${selectedProviderType === type.value ? ' active' : ''}`}
            onClick={() => { closeSourceDrawer(); setSelectedProviderType(type.value) }}
          >
            {type.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading ? (
        <div className="loading-state">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      ) : selectedProviderType === 'chat_completion' ? (
        /* Chat Completion: Card Grid + Drawer */
        <>
          {displayedProviderSources.length === 0 ? (
            <div className="empty-state-full">
              <Globe size={48} className="empty-icon" />
              <p>暂无提供商源</p>
            </div>
          ) : (
            <>
              <div className="platform-grid">
                {displayedProviderSources.map(source => {
                  const icon = getProviderIcon(source.provider)
                  return (
                    <div key={source.id} className={`platform-card source-card${!source.enable ? ' card-stopped' : ''}`}>
                      <div className="card-header">
                        <span className="card-title" title={source.id}>{source.id}</span>
                        <label className="toggle-switch" title={source.enable ? '停用' : '启用'}>
                          <input
                            type="checkbox"
                            checked={source.enable}
                            onChange={() => void toggleProviderSourceEnable(source, !source.enable)}
                          />
                          <span className="toggle-slider"></span>
                        </label>
                      </div>
                      {icon && <img src={icon} className="bg-logo" alt="" />}
                      <div className="card-footer">
                        <button className="btn-card-delete" onClick={() => void deleteProviderSource(source)}>删除</button>
                        <button className="btn-card-edit" onClick={() => openSourceDrawer(source)}>编辑</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {/* Source Edit Drawer */}
          {showSourceDrawer && editableProviderSource && createPortal(
            <>
              <div className="drawer-overlay" onClick={closeSourceDrawer} />
              <div className="drawer" role="dialog" aria-modal="true">
                <div className="drawer-header">
                  <div className="drawer-header-text">
                    <div className="drawer-title">{editableProviderSource.id}</div>
                    <div className="drawer-subtitle">{editableProviderSource.api_base || '未配置 API 地址'}</div>
                  </div>
                  <button className="close-btn" onClick={closeSourceDrawer} aria-label="关闭" title="关闭">
                    ×
                  </button>
                </div>
                <div className="drawer-body">
                  {/* Basic Settings */}
                  <section className="drawer-section">
                    <div className="section-title">基础配置</div>
                    <div className="form-grid">
                      <div className="form-group">
                        <label>标识 ID</label>
                        <input type="text" value={editableProviderSource.id ?? ''} onChange={e => setSourceField('id', e.target.value)} className="form-control font-mono" placeholder="唯一标识" />
                      </div>
                      <div className="form-group">
                        <label>API Key</label>
                        <div className="input-with-toggle">
                          <input
                            type={showSourceApiKey ? 'text' : 'password'}
                            value={showSourceApiKey && revealedKeys[editableProviderSource.id] ? revealedKeys[editableProviderSource.id] : (editableProviderSource.key ?? '')}
                            onChange={e => setSourceField('key', e.target.value)}
                            className="form-control font-mono"
                            placeholder="鉴权密钥"
                          />
                          <button
                            type="button"
                            className="toggle-visibility"
                            onClick={async () => {
                              const next = !showSourceApiKey
                              setShowSourceApiKey(next)
                              if (next && editableProviderSource.id) {
                                const realKey = await fetchRealKey(editableProviderSource.id)
                                if (realKey) setSourceField('key', realKey)
                              }
                            }}
                            title={showSourceApiKey ? '隐藏' : '显示'}
                          >
                            {showSourceApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      </div>
                      <div className="form-group span-2">
                        <label>API Base URL</label>
                        <input type="text" value={editableProviderSource.api_base ?? ''} onChange={e => setSourceField('api_base', e.target.value)} className="form-control font-mono" placeholder="API 端点地址" />
                      </div>
                    </div>
                  </section>

                  {/* Advanced Settings */}
                  {advancedSourceConfig && (
                    <section className="drawer-section">
                      <div className="section-title">高级配置</div>
                      <div className="form-grid">
                        {Object.entries(advancedSourceConfig).map(([key, value]) => (
                          <div className="form-group" key={key}>
                            <label>{key}</label>
                            {(typeof value === 'string' || typeof value === 'number') ? (
                              <input
                                type={typeof value === 'number' ? 'number' : 'text'}
                                value={editableProviderSource[key] ?? ''}
                                onChange={e => setSourceField(key, typeof value === 'number' ? Number(e.target.value) : e.target.value)}
                                className="form-control font-mono"
                              />
                            ) : typeof value === 'boolean' ? (
                              <label className="toggle-label">
                                <input type="checkbox" checked={Boolean(editableProviderSource[key])} onChange={e => setSourceField(key, e.target.checked)} />
                                <span>{value ? '启用' : '停用'}</span>
                              </label>
                            ) : (
                              <textarea
                                value={JSON.stringify(value, null, 2)}
                                onChange={e => tryParseJson(e, key)}
                                className="form-control font-mono textarea-sm"
                                rows={2}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  <div className="config-divider"></div>

                  {/* Models Panel */}
                  <section className="drawer-section">
                    <div className="models-toolbar">
                      <div>
                        <div className="section-title">模型管理</div>
                        <small className="section-subtitle">可用 {availableModels.length} 个模型</small>
                      </div>
                      <div className="models-actions">
                        <div className="search-box">
                          <Search size={14} className="search-icon" />
                          <input type="text" value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="搜索模型..." className="form-control sm" />
                        </div>
                        <button className="btn sm primary" disabled={loadingModels} onClick={() => void fetchAvailableModels()}>
                          {loadingModels ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                          获取模型列表
                        </button>
                        <button className="btn sm" onClick={openManualModelDialog}>
                          <Pencil size={14} /> 手动添加
                        </button>
                      </div>
                    </div>

                    {/* Configured Models */}
                    <div className="models-section">
                      <div className="models-section-head">
                        <span>已配置</span>
                        <span className="badge">{configuredEntries.length}</span>
                      </div>
                      {configuredEntries.length > 0 ? (
                        <div className="models-list">
                          {configuredEntries.map(entry => (
                            <div className="model-row" key={entry.provider!.id}>
                              <button className="model-row-main" onClick={() => openProviderEdit(entry.provider!)}>
                                <div className="model-row-title">{entry.provider!.id}</div>
                                <div className="model-row-subtitle">{entry.provider!.model}</div>
                                <div className="model-row-meta">
                                  {capabilityIcons(entry.metadata).map(cap => (
                                    <span key={cap.icon} className="capability-badge" title={cap.label}>
                                      {renderCapabilityIcon(cap, 12)}
                                    </span>
                                  ))}
                                  {formatContextLimit(entry.metadata) && (
                                    <span className="context-badge">{formatContextLimit(entry.metadata)}</span>
                                  )}
                                </div>
                              </button>
                              <div className="model-row-actions">
                                <button
                                  className={`toggle-btn${entry.provider!.enable ? ' active' : ''}`}
                                  onClick={() => void toggleProviderEnable(entry.provider!, !entry.provider!.enable)}
                                  title={entry.provider!.enable ? '停用' : '启用'}
                                >
                                  <Power size={14} />
                                </button>
                                <button
                                  className="icon-btn test-btn"
                                  disabled={!entry.provider!.enable || testingProviders.includes(entry.provider!.id)}
                                  onClick={() => void testProvider(entry.provider!)}
                                  title="测试"
                                >
                                  {testingProviders.includes(entry.provider!.id) ? <RefreshCw size={14} className="animate-spin" /> : <Play size={12} />}
                                </button>
                                <button className="icon-btn" onClick={() => openProviderEdit(entry.provider!)} title="编辑">
                                  <Pencil size={14} />
                                </button>
                                <button className="icon-btn danger" onClick={() => void deleteProvider(entry.provider!)} title="删除" aria-label="删除">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="models-empty">暂无已配置的模型</div>
                      )}
                    </div>

                    <div className="config-divider"></div>

                    {/* Available Models */}
                    <div className="models-section">
                      <div className="models-section-head">
                        <span>可用模型</span>
                        <span className="badge">{availableEntries.length}</span>
                      </div>
                      {availableEntries.length > 0 ? (
                        <div className="models-list models-list-available">
                          {availableEntries.map(entry => (
                            <div className="model-row" key={entry.model}>
                              <button className="model-row-main" onClick={() => openModelAddDialog(entry.model!)}>
                                <div className="model-row-title mono">{entry.model}</div>
                                <div className="model-row-meta">
                                  {capabilityIcons(entry.metadata).map(cap => (
                                    <span key={cap.icon} className="capability-badge" title={cap.label}>
                                      {renderCapabilityIcon(cap, 12)}
                                    </span>
                                  ))}
                                  {formatContextLimit(entry.metadata) && (
                                    <span className="context-badge">{formatContextLimit(entry.metadata)}</span>
                                  )}
                                </div>
                              </button>
                              <div className="model-row-actions">
                                <button className="icon-btn primary" onClick={() => openModelAddDialog(entry.model!)} title="添加">
                                  <Plus size={14} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="models-empty small">点击"获取模型"加载可用模型列表</div>
                      )}
                    </div>
                  </section>
                </div>
                <div className="drawer-footer">
                  <button className="btn" onClick={closeSourceDrawer}>取消</button>
                  <button
                    className="btn primary"
                    disabled={!isSourceModified || savingSource}
                    onClick={() => void saveProviderSource()}
                  >
                    {savingSource ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                    {savingSource ? '保存中...' : '保存'}
                  </button>
                </div>
              </div>
            </>,
            document.body
          )}
        </>
      ) : (
        /* Non-Chat Types: Card Grid Layout */
        filteredProviders.length === 0 ? (
          <div className="empty-state-full">
            <Globe size={48} className="empty-icon" />
            <p>暂无此类型的提供商</p>
            <button className="btn primary" onClick={openAddProviderDialog}>
              <Plus size={16} /> 添加提供商
            </button>
          </div>
        ) : (
          <div className="providers-grid">
            {filteredProviders.map(provider => (
              <div key={provider.id} className={`provider-card${!provider.enable ? ' disabled' : ''}`}>
                <div className="card-header">
                  <div className="title-info">
                    <div className="name-row">
                      <h3>{provider.id}</h3>
                      {!provider.enable && <span className="disabled-tag">已停用</span>}
                    </div>
                    <span className="type-tag font-mono">{provider.type || provider.provider_type}</span>
                  </div>
                  <div className="actions">
                    <button
                      className={`btn icon-btn ${provider.enable ? 'danger' : 'success'}`}
                      title={provider.enable ? '停用' : '启用'}
                      onClick={() => void toggleProviderEnable(provider, !provider.enable)}
                    >
                      <Power size={14} />
                    </button>
                  </div>
                </div>
                <div className="card-body">
                  <div className="info-row">
                    <span className="label">模型:</span>
                    <span className="value font-mono text-truncate">{provider.model || '(未配置)'}</span>
                  </div>
                  {provider.api_base && (
                    <div className="info-row">
                      <span className="label">API 地址:</span>
                      <span className="value font-mono text-truncate">{provider.api_base}</span>
                    </div>
                  )}
                  {provider.key && (
                    <div className="info-row">
                      <span className="label">API Key:</span>
                      <span className="value font-mono text-truncate">
                        {revealedCardKeys.has(provider.id) ? (revealedKeys[provider.provider_source_id || provider.id] || '••••••••') : '••••••••'}
                      </span>
                      <button
                        type="button"
                        className="toggle-visibility inline"
                        onClick={async () => {
                          const isRevealed = revealedCardKeys.has(provider.id)
                          if (!isRevealed) {
                            await fetchRealKey(provider.provider_source_id || provider.id)
                          }
                          setRevealedCardKeys(prev => {
                            const next = new Set(prev)
                            if (next.has(provider.id)) next.delete(provider.id)
                            else next.add(provider.id)
                            return next
                          })
                        }}
                        title={revealedCardKeys.has(provider.id) ? '隐藏' : '显示'}
                      >
                        {revealedCardKeys.has(provider.id) ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>
                  )}
                  {provider.modalities?.length ? (
                    <div className="info-row">
                      <span className="label">能力:</span>
                      <div className="capability-list">
                        {capabilityIcons(buildMetadataFromProvider(provider)).map(cap => (
                          <span key={cap.icon} className="capability-badge" title={cap.label}>
                            {renderCapabilityIcon(cap, 11)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="card-footer">
                  <button
                    className="btn sm"
                    disabled={!provider.enable || testingProviders.includes(provider.id)}
                    onClick={() => void testProvider(provider)}
                  >
                    {testingProviders.includes(provider.id) ? <RefreshCw size={14} className="animate-spin" /> : <Play size={12} />}
                    测试
                  </button>
                  <button className="btn sm primary" onClick={() => openNonChatProviderEdit(provider)}>
                    <Pencil size={14} /> 编辑配置
                  </button>
                  <button className="btn sm danger" title="删除" onClick={() => void deleteProvider(provider)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Add Provider Dialog (non-chat) */}
      <Modal
        open={showAddProviderDialog}
        onClose={() => setShowAddProviderDialog(false)}
        title="添加新提供商"
        size="lg"
        footer={<button className="btn" onClick={() => setShowAddProviderDialog(false)}>取消</button>}
      >
        <div className="tabs-container compact">
          {addProviderTabs.map(tab => (
            <button
              key={tab.value}
              className={`tab-btn${addProviderTab === tab.value ? ' active' : ''}`}
              onClick={() => setAddProviderTab(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="template-grid">
          {Object.entries(templatesForCurrentTab).map(([name, template]) => (
            <div
              key={name}
              className="template-card"
              onClick={() => void selectProviderTemplate(name)}
            >
              <div className="template-card-text">
                <div className="template-card-title">{name}</div>
                <div className="template-card-desc">{(template as any).type}</div>
              </div>
              <div className="template-card-logo">
                {getProviderIcon((template as any).provider) ? (
                  <img src={getProviderIcon((template as any).provider)} className="template-logo-img" alt="" />
                ) : (
                  <div className="template-logo-fallback">{name[0].toUpperCase()}</div>
                )}
              </div>
            </div>
          ))}
          {Object.keys(templatesForCurrentTab).length === 0 && (
            <div className="no-templates">暂无此类型的提供商模板</div>
          )}
        </div>
      </Modal>

      {/* Manual Model Dialog */}
      <Modal
        open={showManualModelDialog}
        onClose={() => setShowManualModelDialog(false)}
        title="手动添加模型"
        footer={
          <>
            <button className="btn" onClick={() => setShowManualModelDialog(false)}>取消</button>
            <button className="btn primary" onClick={confirmManualModel}>添加</button>
          </>
        }
      >
        <div className="form-group">
          <label>模型 ID</label>
          <input type="text" value={manualModelId} onChange={e => setManualModelId(e.target.value)} className="form-control font-mono" placeholder="例如: gpt-4o" autoFocus />
        </div>
        <div className="form-group">
          <label>生成提供商标识</label>
          <input type="text" value={manualProviderId} className="form-control font-mono" disabled />
          <span className="help-text">自动根据源 ID 和模型 ID 生成</span>
        </div>
      </Modal>

      {/* Provider Edit Dialog */}
      <Modal
        open={showProviderEditDialog}
        onClose={() => setShowProviderEditDialog(false)}
        title={`${providerEditMode === 'add' ? '添加' : '编辑'} ${providerEditData?.id || ''}`}
        footer={
          <>
            <button className="btn" disabled={editSaving} onClick={() => setShowProviderEditDialog(false)}>取消</button>
            <button className="btn primary" disabled={editSaving} onClick={() => void saveEditedProvider()}>
              {editSaving ? '保存中...' : '保存'}
            </button>
          </>
        }
      >
        {providerEditData && (
          <div className="form-grid">
            <div className="form-group">
              <label>提供商标识 ID</label>
              <input type="text" value={providerEditData.id} onChange={e => setProviderEditField('id', e.target.value)} className="form-control font-mono" disabled={providerEditMode === 'edit'} />
            </div>
            <div className="form-group">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <label style={{ marginBottom: 0 }}>模型名称</label>
                <button className="btn sm" onClick={handleAutoDetectCapabilities} style={{ padding: '2px 6px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', borderRadius: 4 }}>
                  <Sparkles size={12} /> 自动识别参数
                </button>
              </div>
              <input type="text" value={providerEditData.model} onChange={e => setProviderEditField('model', e.target.value)} className="form-control font-mono" disabled={providerEditMode === 'edit'} />
            </div>
            <div className="form-group">
              <label>启用</label>
              <label className="toggle-label">
                <input type="checkbox" checked={providerEditData.enable} onChange={e => setProviderEditField('enable', e.target.checked)} />
                <span>{providerEditData.enable ? '启用' : '停用'}</span>
              </label>
            </div>
            <div className="form-group">
              <label>最大上下文长度</label>
              <input type="number" value={providerEditData.max_context_tokens ?? 0} onChange={e => setProviderEditField('max_context_tokens', Number(e.target.value))} className="form-control font-mono" />
            </div>
            <div className="form-group span-2">
              <label>模态能力 (modalities)</label>
              <div className="checkbox-group">
                {['text', 'image', 'audio', 'tool_use'].map(mod => (
                  <label key={mod} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={providerEditData.modalities?.includes(mod) ?? false}
                      onChange={() => toggleModality(mod)}
                    />
                    <span>{mod}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label>推理模式</label>
              <label className="toggle-label">
                <input type="checkbox" checked={Boolean(providerEditData.reasoning)} onChange={e => setProviderEditField('reasoning', e.target.checked)} />
                <span>{providerEditData.reasoning ? '开启' : '关闭'}</span>
              </label>
            </div>
            <div className="form-group">
              <label>模型默认温度 (Temperature)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input type="range" value={providerEditData.temperature ?? 0.7} onChange={e => setProviderEditField('temperature', Number(e.target.value))} min={0} max={2} step={0.1} style={{ flex: 1, accentColor: 'var(--accent-primary)' }} />
                <input type="number" value={providerEditData.temperature ?? 0.7} onChange={e => setProviderEditField('temperature', Number(e.target.value))} min={0} max={2} step={0.1} className="form-control font-mono" style={{ width: 70, textAlign: 'center', padding: '0.3rem' }} />
              </div>
              <span className="help-text">设置该模型的默认生成温度 (0.0 - 2.0，默认 0.7)</span>
            </div>
          </div>
        )}
      </Modal>

      {/* Non-Chat Provider Full Config Dialog */}
      <Modal
        open={showNonChatConfigDialog}
        onClose={() => setShowNonChatConfigDialog(false)}
        title={`${nonChatConfigMode === 'add' ? '添加' : '编辑'} ${nonChatProviderLabel} 提供商`}
        size="lg"
        footer={
          <>
            <button className="btn" disabled={nonChatConfigSaving} onClick={() => setShowNonChatConfigDialog(false)}>取消</button>
            <button className="btn primary" disabled={nonChatConfigSaving} onClick={() => void saveNonChatConfig()}>
              {nonChatConfigSaving ? '保存中...' : (nonChatConfigMode === 'add' ? '创建' : '保存')}
            </button>
          </>
        }
      >
        {nonChatConfigData && (
          <>
            {/* Basic Fields */}
            {nonChatFieldRows.map(row => (
              <div key={row.map(f => f.key).join(',')} className={`form-grid${row.length === 1 ? ' single-col' : ''}`}>
                {row.map(field => (
                  <div key={field.key} className={`form-group${field.span ? ' span-full' : ''}`}>
                    <label>{field.label}</label>
                    {field.hint && <span className="help-text">{field.hint}</span>}

                    {field.type === 'string' && !field.password && (
                      <input
                        type="text"
                        value={nonChatConfigData[field.key] ?? ''}
                        onChange={e => setNonChatField(field.key, e.target.value)}
                        className="form-control font-mono"
                        placeholder={field.placeholder}
                        disabled={field.disabled}
                      />
                    )}
                    {field.type === 'string' && field.password && (
                      <div className="input-with-toggle">
                        <input
                          type={showNonChatPassword[field.key] ? 'text' : 'password'}
                          value={showNonChatPassword[field.key] && revealedKeys[nonChatConfigData.provider_source_id || nonChatConfigData.id]
                            ? revealedKeys[nonChatConfigData.provider_source_id || nonChatConfigData.id]
                            : (nonChatConfigData[field.key] ?? '')}
                          onChange={e => setNonChatField(field.key, e.target.value)}
                          className="form-control font-mono"
                          placeholder={field.placeholder}
                        />
                        <button
                          type="button"
                          className="toggle-visibility"
                          onClick={async () => {
                            const next = !showNonChatPassword[field.key]
                            setShowNonChatPassword(prev => ({ ...prev, [field.key]: next }))
                            if (next && nonChatConfigData.id) {
                              const lookupId = nonChatConfigData.provider_source_id || nonChatConfigData.id
                              const realKey = await fetchRealKey(lookupId)
                              if (realKey) setNonChatField(field.key, realKey)
                            }
                          }}
                          title={showNonChatPassword[field.key] ? '隐藏' : '显示'}
                        >
                          {showNonChatPassword[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    )}
                    {field.type === 'number' && (
                      <input
                        type="number"
                        value={nonChatConfigData[field.key] ?? ''}
                        onChange={e => setNonChatField(field.key, Number(e.target.value))}
                        className="form-control font-mono"
                        placeholder={field.placeholder}
                      />
                    )}
                    {field.type === 'boolean' && (
                      <label className="toggle-label">
                        <input type="checkbox" checked={Boolean(nonChatConfigData[field.key])} onChange={e => setNonChatField(field.key, e.target.checked)} />
                        <span>{nonChatConfigData[field.key] ? '启用' : '停用'}</span>
                      </label>
                    )}
                    {field.type === 'select' && (
                      <select
                        value={nonChatConfigData[field.key] ?? ''}
                        onChange={e => setNonChatField(field.key, e.target.value)}
                        className="form-control font-mono"
                      >
                        {field.options?.map(opt => (
                          <option key={String(opt.value)} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            ))}

            {/* Dynamic extra fields not covered by schema */}
            {nonChatUnknownFields.length > 0 && (
              <>
                <div className="config-divider" style={{ margin: '1rem 0' }}></div>
                <div className="section-title" style={{ fontSize: 14, fontWeight: 600, marginBottom: '0.75rem' }}>其他配置</div>
                <div className="form-grid">
                  {nonChatUnknownFields.map(field => (
                    <div key={field.key} className="form-group">
                      <label>{field.key}</label>
                      {typeof field.value === 'string' && !field.value.startsWith('{') ? (
                        <input
                          type="text"
                          value={String(nonChatConfigData[field.key] ?? '')}
                          onChange={e => setNonChatField(field.key, e.target.value)}
                          className="form-control font-mono"
                        />
                      ) : typeof field.value === 'number' ? (
                        <input
                          type="number"
                          value={nonChatConfigData[field.key] ?? ''}
                          onChange={e => setNonChatField(field.key, Number(e.target.value))}
                          className="form-control font-mono"
                        />
                      ) : typeof field.value === 'boolean' ? (
                        <label className="toggle-label">
                          <input type="checkbox" checked={Boolean(nonChatConfigData[field.key])} onChange={e => setNonChatField(field.key, e.target.checked)} />
                          <span>{field.value ? '启用' : '停用'}</span>
                        </label>
                      ) : (
                        <textarea
                          value={typeof nonChatConfigData[field.key] === 'string' ? nonChatConfigData[field.key] : JSON.stringify(nonChatConfigData[field.key], null, 2)}
                          onChange={e => setNonChatField(field.key, e.target.value)}
                          className="form-control font-mono textarea-sm"
                          rows={2}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </Modal>

      {/* Toast */}
      <ToastPortal toast={toast} />
    </div>
  )
}
