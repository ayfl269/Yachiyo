import { useEffect, useState } from 'react'
import { Save, Settings, ShieldAlert, Cpu, Share2, Info, Brain } from 'lucide-react'

interface AgentConfig {
  id: string
  name: string
  wakePrefix: string
  friendMessageNeedsWakePrefix: boolean
  rateLimitEnabled: boolean
  rateLimitMaxRequests: number
  rateLimitWindowSeconds: number
  rateLimitStrategy: 'STALL' | 'DISCARD'
  safetyKeywords: string[]
  safetyCheckResponse: boolean
  emojiReact: boolean
  pathMappings: [string, string][]
  sttEnabled: boolean
  streamingResponse: boolean
  modelStreaming: boolean
  maxStep: number
  maxContextLength: number
  toolCallTimeout: number
  toolSchemaMode: 'full' | 'skills_like'
  replyPrefix: string
  replyWithMention: boolean
  replyWithQuote: boolean
  segmentedReply: boolean
  onlyLlmResultSegmented: boolean
  ttsEnabled: boolean
  t2iEnabled: boolean
  t2iWidth: number
  t2iQuality: number
  t2iFormat: 'png' | 'jpeg'
  t2iTemplate: string
  displayReasoningText: boolean
  defaultProviderId: string
  fallbackProviderIds: string[]
  defaultPersonaId: string
  knowledgeBaseNames: string[]
  llmCompressInstruction: string
  llmCompressKeepRecent: number
  enforceMaxTurns: number
  truncateTurns: number
  // Memory system
  memoryEnabled: boolean
  memoryConsolidationInterval: string
  memoryConsolidationEnabled: boolean
  memoryMaxLength: number
  memoryMaxRetries: number
  memoryAgingAccessThreshold: number
  memoryAgingMaxAgeDays: number
  memoryShortTermMaxAgeHours: number
  memoryPromoteOnSessionEnd: boolean
  memoryInjectProfileCount: number
  memoryInjectLongTermCount: number
  memoryInjectPersonaCount: number
  memoryBufferMinMessages: number
  // Context settings (missing keys)
  injectDateTime: boolean
  timezone: string
  promptPrefix: string
  extraContext: string
  contextLimitReachedStrategy: 'truncate_by_turns' | 'llm_compress'
  llmCompressKeepRecentRatio: number
  llmCompressProviderId: string
  fallbackMaxContextTokens: number
  temperature: number
}

interface Provider {
  id: string
  type: string
}

interface Persona {
  id: string
  name: string
}

type ActiveSection = 'basic' | 'context' | 'provider' | 'security' | 'multimodal' | 'reply' | 'memory'

export default function ConfigManager() {
  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [providersList, setProvidersList] = useState<Provider[]>([])
  const [personasList, setPersonasList] = useState<Persona[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeSection, setActiveSection] = useState<ActiveSection>('basic')
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Form helper for safety keywords string
  const [safetyKeywordsStr, setSafetyKeywordsStr] = useState('')

  const fetchConfig = async () => {
    setLoading(true)
    try {
      const [cfgRes, provRes, personaRes] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/providers'),
        fetch('/api/personas'),
      ])
      if (cfgRes.ok) {
        const data = await cfgRes.json()
        if (data && data.temperature === undefined) {
          data.temperature = 0.7
        }
        setConfig(data)
        setSafetyKeywordsStr(data?.safetyKeywords?.join(', ') || '')
      }
      if (provRes.ok) {
        const data = await provRes.json()
        setProvidersList(data.providers.map((p: { id: string; type: string }) => ({ id: p.id, type: p.type })))
      }
      if (personaRes.ok) {
        const data = await personaRes.json()
        setPersonasList(data.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })))
      }
    } catch (error) {
      console.error('Error fetching config:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!config) return

    // Parse keywords back to array
    const parsedKeywords = safetyKeywordsStr
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)

    const configToSave: AgentConfig = { ...config, safetyKeywords: parsedKeywords }

    setSaving(true)
    setSaveSuccess(false)
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configToSave),
      })
      if (res.ok) {
        setConfig(configToSave)
        setSaveSuccess(true)
        setTimeout(() => { setSaveSuccess(false) }, 3000)
      } else {
        const err = await res.json()
        alert('保存失败: ' + (err.error || '未知错误'))
      }
    } catch (error) {
      console.error('Error saving config:', error)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    fetchConfig()
  }, [])

  // Helper to update a single field of config
  const updateField = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  if (loading && !config) {
    return (
      <div className="config-view animate-fade-in">
        <div className="header">
          <div className="header-main">
            <div>
              <h1>系统配置</h1>
              <p>管理 Agent 的唤醒前缀、安全检测、频率限制等运行策略参数</p>
            </div>
            <button className="btn primary" disabled={saving} onClick={handleSave}>
              <Save className={`icon-inline${saving ? ' spinning' : ''}`} />
              {saving ? '保存中...' : '保存配置'}
            </button>
          </div>
        </div>
        <div className="loading-state">
          <div className="spinner"></div>
          <p>加载中...</p>
        </div>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="config-view animate-fade-in">
        <div className="header">
          <div className="header-main">
            <div>
              <h1>系统配置</h1>
              <p>管理 Agent 的唤醒前缀、安全检测、频率限制等运行策略参数</p>
            </div>
            <button className="btn primary" disabled={saving} onClick={handleSave}>
              <Save className={`icon-inline${saving ? ' spinning' : ''}`} />
              {saving ? '保存中...' : '保存配置'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="config-view animate-fade-in">
      <div className="header">
        <div className="header-main">
          <div>
            <h1>系统配置</h1>
            <p>管理 Agent 的唤醒前缀、安全检测、频率限制等运行策略参数</p>
          </div>
          <button className="btn primary" disabled={saving} onClick={handleSave}>
            <Save className={`icon-inline${saving ? ' spinning' : ''}`} />
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
        {saveSuccess && <div className="save-success-banner">配置已保存成功</div>}
      </div>

      <div className="config-form">
        {/* Section Navigation */}
        <div className="section-tabs">
          <button
            className={`tab-btn${activeSection === 'basic' ? ' active' : ''}`}
            onClick={() => setActiveSection('basic')}
          >
            <Settings className="tab-icon" /> 基础配置
          </button>
          <button
            className={`tab-btn${activeSection === 'context' ? ' active' : ''}`}
            onClick={() => setActiveSection('context')}
          >
            <Info className="tab-icon" /> 会话控制
          </button>
          <button
            className={`tab-btn${activeSection === 'provider' ? ' active' : ''}`}
            onClick={() => setActiveSection('provider')}
          >
            <Cpu className="tab-icon" /> 服务关联
          </button>
          <button
            className={`tab-btn${activeSection === 'security' ? ' active' : ''}`}
            onClick={() => setActiveSection('security')}
          >
            <ShieldAlert className="tab-icon" /> 安全限制
          </button>
          <button
            className={`tab-btn${activeSection === 'multimodal' ? ' active' : ''}`}
            onClick={() => setActiveSection('multimodal')}
          >
            <Share2 className="tab-icon" /> 多模态拓展
          </button>
          <button
            className={`tab-btn${activeSection === 'reply' ? ' active' : ''}`}
            onClick={() => setActiveSection('reply')}
          >
            <Info className="tab-icon" /> 回复样式
          </button>
          <button
            className={`tab-btn${activeSection === 'memory' ? ' active' : ''}`}
            onClick={() => setActiveSection('memory')}
          >
            <Brain className="tab-icon" /> 记忆系统
          </button>
        </div>

        {/* Section Content */}
        <div className="section-content">
          {/* 1. Basic Section */}
          {activeSection === 'basic' && (
            <div className="form-grid">
              <div className="form-group">
                <label>唤醒前缀 (Wake Prefix)</label>
                <input
                  type="text"
                  value={config.wakePrefix}
                  onChange={(e) => updateField('wakePrefix', e.target.value)}
                  placeholder="例如: @Bot 或 (留空为直接回复)"
                  className="form-control font-mono"
                />
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.friendMessageNeedsWakePrefix}
                  onChange={(e) => updateField('friendMessageNeedsWakePrefix', e.target.checked)}
                  id="friendMessageNeedsWakePrefix"
                />
                <label htmlFor="friendMessageNeedsWakePrefix">私聊中也需要唤醒词触发</label>
              </div>
            </div>
          )}

          {/* 2. Context Section */}
          {activeSection === 'context' && (
            <div className="form-grid">
              <div className="form-group">
                <label>单次推理最大 Step 数</label>
                <input
                  type="number"
                  value={config.maxStep}
                  onChange={(e) => updateField('maxStep', Number(e.target.value))}
                  className="form-control"
                />
                <span className="help-text">防止 Tool Call 陷入循环</span>
              </div>
              <div className="form-group">
                <label>最大上下文 Token 长度</label>
                <input
                  type="number"
                  value={config.maxContextLength}
                  onChange={(e) => updateField('maxContextLength', Number(e.target.value))}
                  className="form-control"
                />
              </div>
              <div className="form-group">
                <label>工具调用超时时间 (毫秒)</label>
                <input
                  type="number"
                  value={config.toolCallTimeout}
                  onChange={(e) => updateField('toolCallTimeout', Number(e.target.value))}
                  className="form-control font-mono"
                />
              </div>
              <div className="form-group">
                <label>工具定义渲染模式 (Tool Schema Mode)</label>
                <select
                  value={config.toolSchemaMode}
                  onChange={(e) => updateField('toolSchemaMode', e.target.value as AgentConfig['toolSchemaMode'])}
                  className="form-control"
                >
                  <option value="full">Full (支持完整 JSON Schema)</option>
                  <option value="skills_like">Skills Like (扁平简洁模式)</option>
                </select>
              </div>
              <div className="form-group">
                <label>限制每个会话最大轮数 (0 为不限制)</label>
                <input
                  type="number"
                  value={config.enforceMaxTurns}
                  onChange={(e) => updateField('enforceMaxTurns', Number(e.target.value))}
                  className="form-control"
                />
              </div>
              <div className="form-group">
                <label>超出轮数后截断历史轮数</label>
                <input
                  type="number"
                  value={config.truncateTurns}
                  onChange={(e) => updateField('truncateTurns', Number(e.target.value))}
                  className="form-control"
                />
              </div>

              {/* Context Injection */}
              <div className="section-divider"></div>
              <div className="section-subtitle">上下文注入</div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.injectDateTime}
                  onChange={(e) => updateField('injectDateTime', e.target.checked)}
                  id="injectDateTime"
                />
                <label htmlFor="injectDateTime">注入当前日期/时间到系统提示词</label>
              </div>
              <div className="form-group">
                <label>时区</label>
                <input
                  type="text"
                  value={config.timezone}
                  onChange={(e) => updateField('timezone', e.target.value)}
                  placeholder="留空则自动检测，例如: Asia/Shanghai"
                  className="form-control"
                />
                <span className="help-text">IANA 时区标识，留空使用服务器本地时区</span>
              </div>
              <div className="form-group span-2">
                <label>Prompt 前缀</label>
                <input
                  type="text"
                  value={config.promptPrefix}
                  onChange={(e) => updateField('promptPrefix', e.target.value)}
                  placeholder="例如: [User Message] 或包含 {{prompt}} 的模板"
                  className="form-control"
                />
                <span className="help-text">在用户消息前追加内容。使用 {'{{prompt}}'} 占位符可自定义位置，否则直接前缀拼接</span>
              </div>
              <div className="form-group span-2">
                <label>额外上下文</label>
                <textarea
                  value={config.extraContext}
                  onChange={(e) => updateField('extraContext', e.target.value)}
                  placeholder="追加到系统提示词末尾的额外上下文信息"
                  className="form-control textarea"
                  rows={3}
                />
                <span className="help-text">会以 [Extra Context] 标签注入到系统提示词中</span>
              </div>

              {/* Context Compression */}
              <div className="section-divider"></div>
              <div className="section-subtitle">上下文压缩</div>
              <div className="form-group">
                <label>上下文超限策略</label>
                <select
                  value={config.contextLimitReachedStrategy}
                  onChange={(e) => updateField('contextLimitReachedStrategy', e.target.value as AgentConfig['contextLimitReachedStrategy'])}
                  className="form-control"
                >
                  <option value="truncate_by_turns">按轮次截断</option>
                  <option value="llm_compress">LLM 摘要压缩</option>
                </select>
              </div>
              <div className="form-group">
                <label>LLM 压缩保留近期比例</label>
                <input
                  type="number"
                  value={config.llmCompressKeepRecentRatio}
                  onChange={(e) => updateField('llmCompressKeepRecentRatio', Number(e.target.value))}
                  step={0.05}
                  min={0}
                  max={0.3}
                  className="form-control"
                />
                <span className="help-text">0-0.3，压缩时按 token 比例保留近期上下文</span>
              </div>
              <div className="form-group">
                <label>LLM 压缩用模型 ID</label>
                <input
                  type="text"
                  value={config.llmCompressProviderId}
                  onChange={(e) => updateField('llmCompressProviderId', e.target.value)}
                  placeholder="留空则使用当前聊天模型"
                  className="form-control font-mono"
                />
              </div>
              <div className="form-group">
                <label>回退最大上下文 Token 数</label>
                <input
                  type="number"
                  value={config.fallbackMaxContextTokens}
                  onChange={(e) => updateField('fallbackMaxContextTokens', Number(e.target.value))}
                  className="form-control"
                />
                <span className="help-text">模型不在元数据中时的默认上下文窗口大小</span>
              </div>
            </div>
          )}

          {/* 3. Provider Section */}
          {activeSection === 'provider' && (
            <div className="form-grid">
              <div className="form-group">
                <label>模型提供商 ID</label>
                <select
                  value={config.defaultProviderId}
                  onChange={(e) => updateField('defaultProviderId', e.target.value)}
                  className="form-control font-mono"
                >
                  <option value="">(未选择)</option>
                  {providersList.map((p) => (
                    <option key={p.id} value={p.id}>{p.id} ({p.type})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>系统默认角色 Persona</label>
                <select
                  value={config.defaultPersonaId}
                  onChange={(e) => updateField('defaultPersonaId', e.target.value)}
                  className="form-control font-mono"
                >
                  <option value="">(未选择 — 无角色)</option>
                  {personasList.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>模型温度 (Temperature)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="range"
                    value={config.temperature}
                    onChange={(e) => updateField('temperature', Number(e.target.value))}
                    min={0}
                    max={2}
                    step={0.1}
                    style={{ flex: 1, accentColor: 'var(--accent-primary)' }}
                  />
                  <input
                    type="number"
                    value={config.temperature}
                    onChange={(e) => updateField('temperature', Number(e.target.value))}
                    min={0}
                    max={2}
                    step={0.1}
                    className="form-control font-mono"
                    style={{ width: '70px', textAlign: 'center', padding: '0.3rem' }}
                  />
                </div>
                <span className="help-text">控制生成文本的随机性与创意性 (建议 0.0 - 2.0，默认 0.7)</span>
              </div>
              <div className="form-group span-2">
                <label>历史消息压缩提示词</label>
                <textarea
                  value={config.llmCompressInstruction}
                  onChange={(e) => updateField('llmCompressInstruction', e.target.value)}
                  placeholder="当上下文过长时自动使用的系统缩写/总结指令"
                  className="form-control textarea"
                  rows={3}
                />
              </div>
              <div className="form-group">
                <label>压缩时强制保留的最近轮数</label>
                <input
                  type="number"
                  value={config.llmCompressKeepRecent}
                  onChange={(e) => updateField('llmCompressKeepRecent', Number(e.target.value))}
                  className="form-control"
                />
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.modelStreaming}
                  onChange={(e) => updateField('modelStreaming', e.target.checked)}
                  id="modelStreaming"
                />
                <label htmlFor="modelStreaming">启用模型流式输出 (Model Stream)</label>
              </div>
            </div>
          )}

          {/* 4. Security Section */}
          {activeSection === 'security' && (
            <div className="form-grid">
              <div className="form-group span-2">
                <label>敏感安全过滤词 (英文逗号分隔)</label>
                <input
                  type="text"
                  value={safetyKeywordsStr}
                  onChange={(e) => setSafetyKeywordsStr(e.target.value)}
                  placeholder="例如: 屏蔽词A, 屏蔽词B, xxx"
                  className="form-control"
                />
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.safetyCheckResponse}
                  onChange={(e) => updateField('safetyCheckResponse', e.target.checked)}
                  id="safetyCheckResponse"
                />
                <label htmlFor="safetyCheckResponse">对模型的输出也执行过滤安全检查</label>
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.rateLimitEnabled}
                  onChange={(e) => updateField('rateLimitEnabled', e.target.checked)}
                  id="rateLimitEnabled"
                />
                <label htmlFor="rateLimitEnabled">开启用户会话频率限制 (Rate Limit)</label>
              </div>
              {config.rateLimitEnabled && (
                <div className="form-group">
                  <label>最大请求次数 (Max Requests)</label>
                  <input
                    type="number"
                    value={config.rateLimitMaxRequests}
                    onChange={(e) => updateField('rateLimitMaxRequests', Number(e.target.value))}
                    className="form-control"
                  />
                </div>
              )}
              {config.rateLimitEnabled && (
                <div className="form-group">
                  <label>统计滑动窗口大小 (秒)</label>
                  <input
                    type="number"
                    value={config.rateLimitWindowSeconds}
                    onChange={(e) => updateField('rateLimitWindowSeconds', Number(e.target.value))}
                    className="form-control"
                  />
                </div>
              )}
              {config.rateLimitEnabled && (
                <div className="form-group">
                  <label>限流处罚机制 (Rate Limit Strategy)</label>
                  <select
                    value={config.rateLimitStrategy}
                    onChange={(e) => updateField('rateLimitStrategy', e.target.value as AgentConfig['rateLimitStrategy'])}
                    className="form-control"
                  >
                    <option value="DISCARD">DISCARD (直接丢弃，不予理会)</option>
                    <option value="STALL">STALL (拖延队列处理，延迟响应)</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {/* 5. Multimodal Section */}
          {activeSection === 'multimodal' && (
            <div className="form-grid">
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.sttEnabled}
                  onChange={(e) => updateField('sttEnabled', e.target.checked)}
                  id="sttEnabled"
                />
                <label htmlFor="sttEnabled">启用语音转文本 (STT - Speech to Text)</label>
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.ttsEnabled}
                  onChange={(e) => updateField('ttsEnabled', e.target.checked)}
                  id="ttsEnabled"
                />
                <label htmlFor="ttsEnabled">启用文本转语音 (TTS - Text to Speech)</label>
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.t2iEnabled}
                  onChange={(e) => updateField('t2iEnabled', e.target.checked)}
                  id="t2iEnabled"
                />
                <label htmlFor="t2iEnabled">启用文生图渲染 (T2I - Markdown 转 图片)</label>
              </div>
              {config.t2iEnabled && (
                <div className="form-group">
                  <label>渲染模板</label>
                  <select
                    value={config.t2iTemplate}
                    onChange={(e) => updateField('t2iTemplate', e.target.value)}
                    className="form-control"
                  >
                    <option value="default">暗色主题 (Default Dark)</option>
                    <option value="light">亮色主题 (Light)</option>
                  </select>
                </div>
              )}
              {config.t2iEnabled && (
                <div className="form-group">
                  <label>图片宽度 (px)</label>
                  <input
                    type="number"
                    value={config.t2iWidth}
                    onChange={(e) => updateField('t2iWidth', Number(e.target.value))}
                    className="form-control"
                    min={400}
                    max={1920}
                  />
                </div>
              )}
              {config.t2iEnabled && (
                <div className="form-group">
                  <label>输出格式</label>
                  <select
                    value={config.t2iFormat}
                    onChange={(e) => updateField('t2iFormat', e.target.value as AgentConfig['t2iFormat'])}
                    className="form-control"
                  >
                    <option value="png">PNG (无损)</option>
                    <option value="jpeg">JPEG (较小体积)</option>
                  </select>
                </div>
              )}
              {config.t2iEnabled && config.t2iFormat === 'jpeg' && (
                <div className="form-group">
                  <label>JPEG 质量 (1-100)</label>
                  <input
                    type="number"
                    value={config.t2iQuality}
                    onChange={(e) => updateField('t2iQuality', Number(e.target.value))}
                    className="form-control"
                    min={1}
                    max={100}
                  />
                </div>
              )}
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.emojiReact}
                  onChange={(e) => updateField('emojiReact', e.target.checked)}
                  id="emojiReact"
                />
                <label htmlFor="emojiReact">启用自动表情互动回复 (Emoji React)</label>
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.streamingResponse}
                  onChange={(e) => updateField('streamingResponse', e.target.checked)}
                  id="streamingResponse"
                />
                <label htmlFor="streamingResponse">允许在平台适配器支持下流式打字回复 (Stream)</label>
              </div>
            </div>
          )}

          {/* 6. Reply Section */}
          {activeSection === 'reply' && (
            <div className="form-grid">
              <div className="form-group">
                <label>回复前缀文本</label>
                <input
                  type="text"
                  value={config.replyPrefix}
                  onChange={(e) => updateField('replyPrefix', e.target.value)}
                  placeholder="例如: [Robot]:"
                  className="form-control"
                />
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.replyWithMention}
                  onChange={(e) => updateField('replyWithMention', e.target.checked)}
                  id="replyWithMention"
                />
                <label htmlFor="replyWithMention">回复时主动 @ 发言人</label>
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.replyWithQuote}
                  onChange={(e) => updateField('replyWithQuote', e.target.checked)}
                  id="replyWithQuote"
                />
                <label htmlFor="replyWithQuote">回复时引用原消息 (Quote)</label>
              </div>
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.segmentedReply}
                  onChange={(e) => updateField('segmentedReply', e.target.checked)}
                  id="segmentedReply"
                />
                <label htmlFor="segmentedReply">分段回复 (切分长文本发送多条消息)</label>
              </div>
              {config.segmentedReply && (
                <div className="form-group row-checkbox">
                  <input
                    type="checkbox"
                    checked={config.onlyLlmResultSegmented}
                    onChange={(e) => updateField('onlyLlmResultSegmented', e.target.checked)}
                    id="onlyLlmResultSegmented"
                  />
                  <label htmlFor="onlyLlmResultSegmented">仅对模型的纯文本执行分段切割</label>
                </div>
              )}
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.displayReasoningText}
                  onChange={(e) => updateField('displayReasoningText', e.target.checked)}
                  id="displayReasoningText"
                />
                <label htmlFor="displayReasoningText">输出模型的思考推理过程 (Reasoning Content)</label>
              </div>
            </div>
          )}

          {/* 7. Memory System Section */}
          {activeSection === 'memory' && (
            <div className="form-grid">
              <div className="form-group row-checkbox">
                <input
                  type="checkbox"
                  checked={config.memoryEnabled}
                  onChange={(e) => updateField('memoryEnabled', e.target.checked)}
                  id="memoryEnabled"
                />
                <label htmlFor="memoryEnabled">启用记忆系统（自动注入上下文 + 记录对话）</label>
              </div>

              {config.memoryEnabled && (
                <>
                  {/* 记忆整理 */}
                  <div className="section-divider"></div>
                  <div className="section-subtitle">记忆整理</div>

                  <div className="form-group row-checkbox">
                    <input
                      type="checkbox"
                      checked={config.memoryConsolidationEnabled}
                      onChange={(e) => updateField('memoryConsolidationEnabled', e.target.checked)}
                      id="memoryConsolidationEnabled"
                    />
                    <label htmlFor="memoryConsolidationEnabled">启用定时记忆整理</label>
                  </div>
                  {config.memoryConsolidationEnabled && (
                    <div className="form-group">
                      <label>整理间隔</label>
                      <input
                        type="text"
                        value={config.memoryConsolidationInterval}
                        onChange={(e) => updateField('memoryConsolidationInterval', e.target.value)}
                        placeholder="12h"
                        className="form-control font-mono"
                      />
                      <span className="help-text">支持格式: "12h" (12小时), "30m" (30分钟), "1d6h30m", 默认 12h</span>
                    </div>
                  )}
                  <div className="form-group">
                    <label>单条记忆最大长度 (字符)</label>
                    <input
                      type="number"
                      value={config.memoryMaxLength}
                      onChange={(e) => updateField('memoryMaxLength', Number(e.target.value))}
                      min={100}
                      max={2000}
                      className="form-control"
                    />
                    <span className="help-text">超出部分将被截断，默认400</span>
                  </div>
                  <div className="form-group">
                    <label>LLM 提取失败最大重试次数</label>
                    <input
                      type="number"
                      value={config.memoryMaxRetries}
                      onChange={(e) => updateField('memoryMaxRetries', Number(e.target.value))}
                      min={1}
                      max={10}
                      className="form-control"
                    />
                    <span className="help-text">失败时保留缓冲区数据等待下次重试</span>
                  </div>
                  <div className="form-group">
                    <label>触发整理的最少缓冲区消息数</label>
                    <input
                      type="number"
                      value={config.memoryBufferMinMessages}
                      onChange={(e) => updateField('memoryBufferMinMessages', Number(e.target.value))}
                      min={2}
                      max={50}
                      className="form-control"
                    />
                    <span className="help-text">缓冲区消息少于此数不会触发整理</span>
                  </div>

                  {/* 老化与归档 */}
                  <div className="section-divider"></div>
                  <div className="section-subtitle">老化与归档</div>

                  <div className="form-group">
                    <label>老化降权天数阈值</label>
                    <input
                      type="number"
                      value={config.memoryAgingMaxAgeDays}
                      onChange={(e) => updateField('memoryAgingMaxAgeDays', Number(e.target.value))}
                      min={7}
                      max={365}
                      className="form-control"
                    />
                    <span className="help-text">超过此天数且低访问的记忆将被降权，默认90天</span>
                  </div>
                  <div className="form-group">
                    <label>老化降权访问次数阈值</label>
                    <input
                      type="number"
                      value={config.memoryAgingAccessThreshold}
                      onChange={(e) => updateField('memoryAgingAccessThreshold', Number(e.target.value))}
                      min={0}
                      max={100}
                      className="form-control"
                    />
                    <span className="help-text">访问次数低于此值的记忆会被降权，默认1</span>
                  </div>
                  <div className="form-group">
                    <label>短期记忆最大保留时间 (小时)</label>
                    <input
                      type="number"
                      value={config.memoryShortTermMaxAgeHours}
                      onChange={(e) => updateField('memoryShortTermMaxAgeHours', Number(e.target.value))}
                      min={1}
                      max={720}
                      className="form-control"
                    />
                    <span className="help-text">超时的短期记忆在归档时删除，默认168小时(7天)</span>
                  </div>
                  <div className="form-group row-checkbox">
                    <input
                      type="checkbox"
                      checked={config.memoryPromoteOnSessionEnd}
                      onChange={(e) => updateField('memoryPromoteOnSessionEnd', e.target.checked)}
                      id="memoryPromoteOnSessionEnd"
                    />
                    <label htmlFor="memoryPromoteOnSessionEnd">会话结束时将短期记忆提升为长期记忆</label>
                  </div>

                  {/* 上下文注入 */}
                  <div className="section-divider"></div>
                  <div className="section-subtitle">上下文注入数量</div>

                  <div className="form-group">
                    <label>注入用户画像条数</label>
                    <input
                      type="number"
                      value={config.memoryInjectProfileCount}
                      onChange={(e) => updateField('memoryInjectProfileCount', Number(e.target.value))}
                      min={0}
                      max={20}
                      className="form-control"
                    />
                  </div>
                  <div className="form-group">
                    <label>注入长期记忆条数</label>
                    <input
                      type="number"
                      value={config.memoryInjectLongTermCount}
                      onChange={(e) => updateField('memoryInjectLongTermCount', Number(e.target.value))}
                      min={0}
                      max={50}
                      className="form-control"
                    />
                  </div>
                  <div className="form-group">
                    <label>注入角色记忆条数</label>
                    <input
                      type="number"
                      value={config.memoryInjectPersonaCount}
                      onChange={(e) => updateField('memoryInjectPersonaCount', Number(e.target.value))}
                      min={0}
                      max={20}
                      className="form-control"
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
