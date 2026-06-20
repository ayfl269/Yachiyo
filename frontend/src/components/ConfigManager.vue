<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Save, Settings, ShieldAlert, Cpu, Share2, Info, Brain } from 'lucide-vue-next';

interface AgentConfig {
  id: string;
  name: string;
  wakePrefix: string;
  friendMessageNeedsWakePrefix: boolean;
  rateLimitEnabled: boolean;
  rateLimitMaxRequests: number;
  rateLimitWindowSeconds: number;
  rateLimitStrategy: 'STALL' | 'DISCARD';
  safetyKeywords: string[];
  safetyCheckResponse: boolean;
  emojiReact: boolean;
  pathMappings: [string, string][];
  sttEnabled: boolean;
  streamingResponse: boolean;
  modelStreaming: boolean;
  maxStep: number;
  maxContextLength: number;
  toolCallTimeout: number;
  toolSchemaMode: 'full' | 'skills_like';
  replyPrefix: string;
  replyWithMention: boolean;
  replyWithQuote: boolean;
  segmentedReply: boolean;
  onlyLlmResultSegmented: boolean;
  ttsEnabled: boolean;
  t2iEnabled: boolean;
  t2iWidth: number;
  t2iQuality: number;
  t2iFormat: 'png' | 'jpeg';
  t2iTemplate: string;
  displayReasoningText: boolean;
  defaultProviderId: string;
  fallbackProviderIds: string[];
  defaultPersonaId: string;
  knowledgeBaseNames: string[];
  llmCompressInstruction: string;
  llmCompressKeepRecent: number;
  enforceMaxTurns: number;
  truncateTurns: number;
  // Memory system
  memoryEnabled: boolean;
  memoryConsolidationInterval: string;
  memoryConsolidationEnabled: boolean;
  memoryMaxLength: number;
  memoryMaxRetries: number;
  memoryAgingAccessThreshold: number;
  memoryAgingMaxAgeDays: number;
  memoryShortTermMaxAgeHours: number;
  memoryPromoteOnSessionEnd: boolean;
  memoryInjectProfileCount: number;
  memoryInjectLongTermCount: number;
  memoryInjectPersonaCount: number;
  memoryBufferMinMessages: number;
  // Context settings (missing keys)
  injectDateTime: boolean;
  timezone: string;
  promptPrefix: string;
  extraContext: string;
  contextLimitReachedStrategy: 'truncate_by_turns' | 'llm_compress';
  llmCompressKeepRecentRatio: number;
  llmCompressProviderId: string;
  fallbackMaxContextTokens: number;
  temperature: number;
}

interface Provider {
  id: string;
  type: string;
}

const config = ref<AgentConfig | null>(null);
const providersList = ref<Provider[]>([]);
const personasList = ref<{id: string; name: string}[]>([]);
const loading = ref(true);
const saving = ref(false);
const activeSection = ref<'basic' | 'context' | 'provider' | 'security' | 'multimodal' | 'reply' | 'memory'>('basic');
const saveSuccess = ref(false);

// Form helper for safety keywords string
const safetyKeywordsStr = ref('');

const fetchConfig = async () => {
  loading.value = true;
  try {
    const [cfgRes, provRes, personaRes] = await Promise.all([
      fetch('/api/config'),
      fetch('/api/providers'),
      fetch('/api/personas'),
    ]);
    if (cfgRes.ok) {
      const data = await cfgRes.json();
      if (data && data.temperature === undefined) {
        data.temperature = 0.7;
      }
      config.value = data;
      safetyKeywordsStr.value = config.value?.safetyKeywords.join(', ') || '';
    }
    if (provRes.ok) {
      const data = await provRes.json();
      providersList.value = data.providers.map((p: any) => ({ id: p.id, type: p.type }));
    }
    if (personaRes.ok) {
      const data = await personaRes.json();
      personasList.value = data.map((p: any) => ({ id: p.id, name: p.name }));
    }
  } catch (error) {
    console.error('Error fetching config:', error);
  } finally {
    loading.value = false;
  }
};

const handleSave = async () => {
  if (!config.value) return;

  // Parse keywords back to array
  config.value.safetyKeywords = safetyKeywordsStr.value
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);

  saving.value = true;
  saveSuccess.value = false;
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config.value),
    });
    if (res.ok) {
      saveSuccess.value = true;
      setTimeout(() => { saveSuccess.value = false; }, 3000);
    } else {
      const err = await res.json();
      alert('保存失败: ' + (err.error || '未知错误'));
    }
  } catch (error) {
    console.error('Error saving config:', error);
  } finally {
    saving.value = false;
  }
};

onMounted(fetchConfig);
</script>

<template>
  <div class="config-view animate-fade-in">
    <div class="header">
      <div class="header-main">
        <div>
          <h1>系统配置</h1>
          <p>管理 Agent 的唤醒前缀、安全检测、频率限制等运行策略参数</p>
        </div>
        <button class="btn primary" :disabled="saving" @click="handleSave">
          <Save class="icon-inline" :class="{ spinning: saving }" />
          {{ saving ? '保存中...' : '保存配置' }}
        </button>
      </div>
      <div v-if="saveSuccess" class="save-success-banner">配置已保存成功</div>
    </div>

    <!-- Loading State -->
    <div v-if="loading && !config" class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- Single Config Form -->
    <div v-if="config" class="config-form">
      <!-- Section Navigation -->
      <div class="section-tabs">
        <button :class="['tab-btn', { active: activeSection === 'basic' }]" @click="activeSection = 'basic'">
          <Settings class="tab-icon" /> 基础配置
        </button>
        <button :class="['tab-btn', { active: activeSection === 'context' }]" @click="activeSection = 'context'">
          <Info class="tab-icon" /> 会话控制
        </button>
        <button :class="['tab-btn', { active: activeSection === 'provider' }]" @click="activeSection = 'provider'">
          <Cpu class="tab-icon" /> 服务关联
        </button>
        <button :class="['tab-btn', { active: activeSection === 'security' }]" @click="activeSection = 'security'">
          <ShieldAlert class="tab-icon" /> 安全限制
        </button>
        <button :class="['tab-btn', { active: activeSection === 'multimodal' }]" @click="activeSection = 'multimodal'">
          <Share2 class="tab-icon" /> 多模态拓展
        </button>
        <button :class="['tab-btn', { active: activeSection === 'reply' }]" @click="activeSection = 'reply'">
          <Info class="tab-icon" /> 回复样式
        </button>
        <button :class="['tab-btn', { active: activeSection === 'memory' }]" @click="activeSection = 'memory'">
          <Brain class="tab-icon" /> 记忆系统
        </button>
      </div>

      <!-- Section Content -->
      <div class="section-content">
        <!-- 1. Basic Section -->
        <div v-if="activeSection === 'basic'" class="form-grid">
          <div class="form-group">
            <label>唤醒前缀 (Wake Prefix)</label>
            <input type="text" v-model="config.wakePrefix" placeholder="例如: @Bot 或 (留空为直接回复)" class="form-control font-mono" />
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.friendMessageNeedsWakePrefix" id="friendMessageNeedsWakePrefix" />
            <label for="friendMessageNeedsWakePrefix">私聊中也需要唤醒词触发</label>
          </div>
        </div>

        <!-- 2. Context Section -->
        <div v-if="activeSection === 'context'" class="form-grid">
          <div class="form-group">
            <label>单次推理最大 Step 数</label>
            <input type="number" v-model.number="config.maxStep" class="form-control" />
            <span class="help-text">防止 Tool Call 陷入循环</span>
          </div>
          <div class="form-group">
            <label>最大上下文 Token 长度</label>
            <input type="number" v-model.number="config.maxContextLength" class="form-control" />
          </div>
          <div class="form-group">
            <label>工具调用超时时间 (毫秒)</label>
            <input type="number" v-model.number="config.toolCallTimeout" class="form-control font-mono" />
          </div>
          <div class="form-group">
            <label>工具定义渲染模式 (Tool Schema Mode)</label>
            <select v-model="config.toolSchemaMode" class="form-control">
              <option value="full">Full (支持完整 JSON Schema)</option>
              <option value="skills_like">Skills Like (扁平简洁模式)</option>
            </select>
          </div>
          <div class="form-group">
            <label>限制每个会话最大轮数 (0 为不限制)</label>
            <input type="number" v-model.number="config.enforceMaxTurns" class="form-control" />
          </div>
          <div class="form-group">
            <label>超出轮数后截断历史轮数</label>
            <input type="number" v-model.number="config.truncateTurns" class="form-control" />
          </div>

          <!-- Context Injection -->
          <div class="section-divider"></div>
          <div class="section-subtitle">上下文注入</div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.injectDateTime" id="injectDateTime" />
            <label for="injectDateTime">注入当前日期/时间到系统提示词</label>
          </div>
          <div class="form-group">
            <label>时区</label>
            <input type="text" v-model="config.timezone" placeholder="留空则自动检测，例如: Asia/Shanghai" class="form-control" />
            <span class="help-text">IANA 时区标识，留空使用服务器本地时区</span>
          </div>
          <div class="form-group span-2">
            <label>Prompt 前缀</label>
            <input type="text" v-model="config.promptPrefix" placeholder="例如: [User Message] 或包含 {{prompt}} 的模板" class="form-control" />
            <span class="help-text">在用户消息前追加内容。使用 &#123;&#123;prompt&#125;&#125; 占位符可自定义位置，否则直接前缀拼接</span>
          </div>
          <div class="form-group span-2">
            <label>额外上下文</label>
            <textarea v-model="config.extraContext" placeholder="追加到系统提示词末尾的额外上下文信息" class="form-control textarea" rows="3"></textarea>
            <span class="help-text">会以 [Extra Context] 标签注入到系统提示词中</span>
          </div>

          <!-- Context Compression -->
          <div class="section-divider"></div>
          <div class="section-subtitle">上下文压缩</div>
          <div class="form-group">
            <label>上下文超限策略</label>
            <select v-model="config.contextLimitReachedStrategy" class="form-control">
              <option value="truncate_by_turns">按轮次截断</option>
              <option value="llm_compress">LLM 摘要压缩</option>
            </select>
          </div>
          <div class="form-group">
            <label>LLM 压缩保留近期比例</label>
            <input type="number" v-model.number="config.llmCompressKeepRecentRatio" step="0.05" min="0" max="0.3" class="form-control" />
            <span class="help-text">0-0.3，压缩时按 token 比例保留近期上下文</span>
          </div>
          <div class="form-group">
            <label>LLM 压缩用模型 ID</label>
            <input type="text" v-model="config.llmCompressProviderId" placeholder="留空则使用当前聊天模型" class="form-control font-mono" />
          </div>
          <div class="form-group">
            <label>回退最大上下文 Token 数</label>
            <input type="number" v-model.number="config.fallbackMaxContextTokens" class="form-control" />
            <span class="help-text">模型不在元数据中时的默认上下文窗口大小</span>
          </div>
        </div>

        <!-- 3. Provider Section -->
        <div v-if="activeSection === 'provider'" class="form-grid">
          <div class="form-group">
            <label>模型提供商 ID</label>
            <select v-model="config.defaultProviderId" class="form-control font-mono">
              <option value="">(未选择)</option>
              <option v-for="p in providersList" :key="p.id" :value="p.id">{{ p.id }} ({{ p.type }})</option>
            </select>
          </div>
          <div class="form-group">
            <label>系统默认角色 Persona</label>
            <select v-model="config.defaultPersonaId" class="form-control font-mono">
              <option value="">(未选择 — 无角色)</option>
              <option v-for="p in personasList" :key="p.id" :value="p.id">{{ p.name }} ({{ p.id }})</option>
            </select>
          </div>
          <div class="form-group">
            <label>模型温度 (Temperature)</label>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <input type="range" v-model.number="config.temperature" min="0" max="2" step="0.1" style="flex: 1; accent-color: var(--accent-primary);" />
              <input type="number" v-model.number="config.temperature" min="0" max="2" step="0.1" class="form-control font-mono" style="width: 70px; text-align: center; padding: 0.3rem;" />
            </div>
            <span class="help-text">控制生成文本的随机性与创意性 (建议 0.0 - 2.0，默认 0.7)</span>
          </div>
          <div class="form-group span-2">
            <label>历史消息压缩提示词</label>
            <textarea v-model="config.llmCompressInstruction" placeholder="当上下文过长时自动使用的系统缩写/总结指令" class="form-control textarea" rows="3"></textarea>
          </div>
          <div class="form-group">
            <label>压缩时强制保留的最近轮数</label>
            <input type="number" v-model.number="config.llmCompressKeepRecent" class="form-control" />
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.modelStreaming" id="modelStreaming" />
            <label for="modelStreaming">启用模型流式输出 (Model Stream)</label>
          </div>
        </div>

        <!-- 4. Security Section -->
        <div v-if="activeSection === 'security'" class="form-grid">
          <div class="form-group span-2">
            <label>敏感安全过滤词 (英文逗号分隔)</label>
            <input type="text" v-model="safetyKeywordsStr" placeholder="例如: 屏蔽词A, 屏蔽词B, xxx" class="form-control" />
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.safetyCheckResponse" id="safetyCheckResponse" />
            <label for="safetyCheckResponse">对模型的输出也执行过滤安全检查</label>
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.rateLimitEnabled" id="rateLimitEnabled" />
            <label for="rateLimitEnabled">开启用户会话频率限制 (Rate Limit)</label>
          </div>
          <div v-if="config.rateLimitEnabled" class="form-group">
            <label>最大请求次数 (Max Requests)</label>
            <input type="number" v-model.number="config.rateLimitMaxRequests" class="form-control" />
          </div>
          <div v-if="config.rateLimitEnabled" class="form-group">
            <label>统计滑动窗口大小 (秒)</label>
            <input type="number" v-model.number="config.rateLimitWindowSeconds" class="form-control" />
          </div>
          <div v-if="config.rateLimitEnabled" class="form-group">
            <label>限流处罚机制 (Rate Limit Strategy)</label>
            <select v-model="config.rateLimitStrategy" class="form-control">
              <option value="DISCARD">DISCARD (直接丢弃，不予理会)</option>
              <option value="STALL">STALL (拖延队列处理，延迟响应)</option>
            </select>
          </div>
        </div>

        <!-- 5. Multimodal Section -->
        <div v-if="activeSection === 'multimodal'" class="form-grid">
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.sttEnabled" id="sttEnabled" />
            <label for="sttEnabled">启用语音转文本 (STT - Speech to Text)</label>
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.ttsEnabled" id="ttsEnabled" />
            <label for="ttsEnabled">启用文本转语音 (TTS - Text to Speech)</label>
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.t2iEnabled" id="t2iEnabled" />
            <label for="t2iEnabled">启用文生图渲染 (T2I - Markdown 转 图片)</label>
          </div>
          <div v-if="config.t2iEnabled" class="form-group">
            <label>渲染模板</label>
            <select v-model="config.t2iTemplate" class="form-control">
              <option value="default">暗色主题 (Default Dark)</option>
              <option value="light">亮色主题 (Light)</option>
            </select>
          </div>
          <div v-if="config.t2iEnabled" class="form-group">
            <label>图片宽度 (px)</label>
            <input type="number" v-model.number="config.t2iWidth" class="form-control" min="400" max="1920" />
          </div>
          <div v-if="config.t2iEnabled" class="form-group">
            <label>输出格式</label>
            <select v-model="config.t2iFormat" class="form-control">
              <option value="png">PNG (无损)</option>
              <option value="jpeg">JPEG (较小体积)</option>
            </select>
          </div>
          <div v-if="config.t2iEnabled && config.t2iFormat === 'jpeg'" class="form-group">
            <label>JPEG 质量 (1-100)</label>
            <input type="number" v-model.number="config.t2iQuality" class="form-control" min="1" max="100" />
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.emojiReact" id="emojiReact" />
            <label for="emojiReact">启用自动表情互动回复 (Emoji React)</label>
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.streamingResponse" id="streamingResponse" />
            <label for="streamingResponse">允许在平台适配器支持下流式打字回复 (Stream)</label>
          </div>
        </div>

        <!-- 6. Reply Section -->
        <div v-if="activeSection === 'reply'" class="form-grid">
          <div class="form-group">
            <label>回复前缀文本</label>
            <input type="text" v-model="config.replyPrefix" placeholder="例如: [Robot]:" class="form-control" />
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.replyWithMention" id="replyWithMention" />
            <label for="replyWithMention">回复时主动 @ 发言人</label>
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.replyWithQuote" id="replyWithQuote" />
            <label for="replyWithQuote">回复时引用原消息 (Quote)</label>
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.segmentedReply" id="segmentedReply" />
            <label for="segmentedReply">分段回复 (切分长文本发送多条消息)</label>
          </div>
          <div v-if="config.segmentedReply" class="form-group row-checkbox">
            <input type="checkbox" v-model="config.onlyLlmResultSegmented" id="onlyLlmResultSegmented" />
            <label for="onlyLlmResultSegmented">仅对模型的纯文本执行分段切割</label>
          </div>
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.displayReasoningText" id="displayReasoningText" />
            <label for="displayReasoningText">输出模型的思考推理过程 (Reasoning Content)</label>
          </div>
        </div>

        <!-- 7. Memory System Section -->
        <div v-if="activeSection === 'memory'" class="form-grid">
          <div class="form-group row-checkbox">
            <input type="checkbox" v-model="config.memoryEnabled" id="memoryEnabled" />
            <label for="memoryEnabled">启用记忆系统（自动注入上下文 + 记录对话）</label>
          </div>

          <template v-if="config.memoryEnabled">
            <!-- 记忆整理 -->
            <div class="section-divider"></div>
            <div class="section-subtitle">记忆整理</div>

            <div class="form-group row-checkbox">
              <input type="checkbox" v-model="config.memoryConsolidationEnabled" id="memoryConsolidationEnabled" />
              <label for="memoryConsolidationEnabled">启用定时记忆整理</label>
            </div>
            <div v-if="config.memoryConsolidationEnabled" class="form-group">
              <label>整理间隔</label>
              <input type="text" v-model="config.memoryConsolidationInterval" placeholder="12h" class="form-control font-mono" />
              <span class="help-text">支持格式: "12h" (12小时), "30m" (30分钟), "1d6h30m", 默认 12h</span>
            </div>
            <div class="form-group">
              <label>单条记忆最大长度 (字符)</label>
              <input type="number" v-model.number="config.memoryMaxLength" min="100" max="2000" class="form-control" />
              <span class="help-text">超出部分将被截断，默认400</span>
            </div>
            <div class="form-group">
              <label>LLM 提取失败最大重试次数</label>
              <input type="number" v-model.number="config.memoryMaxRetries" min="1" max="10" class="form-control" />
              <span class="help-text">失败时保留缓冲区数据等待下次重试</span>
            </div>
            <div class="form-group">
              <label>触发整理的最少缓冲区消息数</label>
              <input type="number" v-model.number="config.memoryBufferMinMessages" min="2" max="50" class="form-control" />
              <span class="help-text">缓冲区消息少于此数不会触发整理</span>
            </div>

            <!-- 老化与归档 -->
            <div class="section-divider"></div>
            <div class="section-subtitle">老化与归档</div>

            <div class="form-group">
              <label>老化降权天数阈值</label>
              <input type="number" v-model.number="config.memoryAgingMaxAgeDays" min="7" max="365" class="form-control" />
              <span class="help-text">超过此天数且低访问的记忆将被降权，默认90天</span>
            </div>
            <div class="form-group">
              <label>老化降权访问次数阈值</label>
              <input type="number" v-model.number="config.memoryAgingAccessThreshold" min="0" max="100" class="form-control" />
              <span class="help-text">访问次数低于此值的记忆会被降权，默认1</span>
            </div>
            <div class="form-group">
              <label>短期记忆最大保留时间 (小时)</label>
              <input type="number" v-model.number="config.memoryShortTermMaxAgeHours" min="1" max="720" class="form-control" />
              <span class="help-text">超时的短期记忆在归档时删除，默认168小时(7天)</span>
            </div>
            <div class="form-group row-checkbox">
              <input type="checkbox" v-model="config.memoryPromoteOnSessionEnd" id="memoryPromoteOnSessionEnd" />
              <label for="memoryPromoteOnSessionEnd">会话结束时将短期记忆提升为长期记忆</label>
            </div>

            <!-- 上下文注入 -->
            <div class="section-divider"></div>
            <div class="section-subtitle">上下文注入数量</div>

            <div class="form-group">
              <label>注入用户画像条数</label>
              <input type="number" v-model.number="config.memoryInjectProfileCount" min="0" max="20" class="form-control" />
            </div>
            <div class="form-group">
              <label>注入长期记忆条数</label>
              <input type="number" v-model.number="config.memoryInjectLongTermCount" min="0" max="50" class="form-control" />
            </div>
            <div class="form-group">
              <label>注入角色记忆条数</label>
              <input type="number" v-model.number="config.memoryInjectPersonaCount" min="0" max="20" class="form-control" />
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-view {
  max-width: 1600px;
  margin: 0 auto;
}

.header {
  margin-bottom: 2rem;
}

.header-main {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header h1 {
  font-size: 1.8rem;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
}

.header p {
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.save-success-banner {
  margin-top: 0.75rem;
  padding: 0.5rem 1rem;
  background: rgba(34, 197, 94, 0.12);
  border: 1px solid rgba(34, 197, 94, 0.25);
  border-radius: 8px;
  color: #22c55e;
  font-size: 0.9rem;
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 1s linear infinite;
}

/* Section tabs */
.section-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 1.5rem;
}

.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 0.75rem 1rem;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.9rem;
  transition: all 0.15s ease;
}

.tab-btn:hover {
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-primary);
}

.tab-btn.active {
  background: rgba(99, 102, 241, 0.12);
  color: var(--accent-primary);
  font-weight: 600;
}

.tab-icon {
  width: 16px;
  height: 16px;
}

.section-content {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  backdrop-filter: var(--glass-blur);
  padding: 1.75rem;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.25rem;
}

.form-grid > .span-2 {
  grid-column: span 2;
}

.section-divider {
  grid-column: span 2;
  border-top: 1px solid var(--border-color);
  margin: 0.5rem 0;
}

.section-subtitle {
  grid-column: span 2;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: -0.25rem;
}

@media (max-width: 992px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
  .form-grid > .span-2 {
    grid-column: span 1;
  }
  .section-divider,
  .section-subtitle {
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

.help-text {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.row-checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.6rem;
  padding-top: 1rem;
}

.row-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  accent-color: var(--accent-primary);
}

.row-checkbox label {
  cursor: pointer;
}

.textarea {
  resize: vertical;
  min-height: 80px;
}

/* Common button styling */
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
}

.btn.primary:hover {
  background: var(--accent-primary-hover);
  border-color: var(--accent-primary-hover);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.icon-inline {
  width: 16px;
  height: 16px;
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
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.font-mono {
  font-family: monospace;
}
</style>
