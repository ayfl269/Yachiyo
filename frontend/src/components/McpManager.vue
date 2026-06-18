<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import {
  Plus, X, Trash2, Pencil, RefreshCw,
  Wrench, AlertTriangle, CheckCircle2, XCircle,
  ChevronRight, Loader2, Server
} from 'lucide-vue-next'

// ===== Types =====
interface McpServer {
  name: string
  config: Record<string, any>
  active: boolean
  tools: string[]
  errlogs: string[]
  createdAt: string
  updatedAt: string
}

interface EditForm {
  serverName: string
  transportType: 'stdio' | 'http'
  command: string
  argsStr: string
  env: Array<{ key: string; value: string }>
  url: string
  transport: 'sse' | 'streamable_http'
  headers: Array<{ key: string; value: string }>
  jsonConfig: string
}

// ===== State =====
const servers = ref<McpServer[]>([])
const loading = ref(true)
const pollingTimer = ref<number | null>(null)

// Dialog states
const showAddDialog = ref(false)
const showEditDialog = ref(false)
const showDeleteDialog = ref(false)
const showToolsDialog = ref(false)
const deletingServerName = ref('')
const viewingTools = ref<string[]>([])
const viewingToolsServerName = ref('')

// Edit form
const editForm = ref<EditForm>(createEmptyForm())
const isAdding = ref(false)
const saving = ref(false)

// Test connection
const testing = ref(false)
const testResult = ref<{ success: boolean; tools: string[]; message: string } | null>(null)

// Toast
const toast = ref({ show: false, message: '', color: 'success' })
let toastTimer: number | null = null

function showToast(message: string, color = 'success') {
  toast.value = { show: true, message, color }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value.show = false }, 3000)
}

// ===== Helpers =====
function createEmptyForm(): EditForm {
  return {
    serverName: '',
    transportType: 'stdio',
    command: '',
    argsStr: '',
    env: [],
    url: '',
    transport: 'sse',
    headers: [],
    jsonConfig: ''
  }
}

function getTransportType(config: Record<string, any>): 'stdio' | 'http' {
  return 'url' in config ? 'http' : 'stdio'
}

function configToForm(name: string, config: Record<string, any>): EditForm {
  const transportType = getTransportType(config)
  const envArray: Array<{ key: string; value: string }> = []
  if (config.env && typeof config.env === 'object') {
    for (const [key, value] of Object.entries(config.env)) {
      envArray.push({ key, value: String(value) })
    }
  }
  const headersArray: Array<{ key: string; value: string }> = []
  if (config.headers && typeof config.headers === 'object') {
    for (const [key, value] of Object.entries(config.headers)) {
      headersArray.push({ key, value: String(value) })
    }
  }
  const argsString = Array.isArray(config.args) ? config.args.join(' ') : ''
  return {
    serverName: name,
    transportType,
    command: (config.command as string) || '',
    argsStr: argsString,
    env: envArray,
    url: (config.url as string) || '',
    transport: (config.transport as 'sse' | 'streamable_http') || 'sse',
    headers: headersArray,
    jsonConfig: JSON.stringify(config, null, 2)
  }
}

function formToConfig(form: EditForm): Record<string, any> {
  // Try JSON config first if non-empty
  const jsonTrim = form.jsonConfig.trim()
  if (jsonTrim) {
    try {
      return JSON.parse(jsonTrim)
    } catch {
      // fall through to form-based construction
    }
  }

  const configObj: Record<string, any> = {}
  if (form.transportType === 'stdio') {
    configObj.command = form.command.trim()
    configObj.args = form.argsStr
      .split(' ')
      .map(x => x.trim())
      .filter(x => x.length > 0)
    if (form.env.length > 0) {
      const envObj: Record<string, string> = {}
      for (const row of form.env) {
        if (row.key.trim()) envObj[row.key.trim()] = row.value
      }
      if (Object.keys(envObj).length > 0) configObj.env = envObj
    }
  } else {
    configObj.url = form.url.trim()
    configObj.transport = form.transport
    if (form.headers.length > 0) {
      const headersObj: Record<string, string> = {}
      for (const row of form.headers) {
        if (row.key.trim()) headersObj[row.key.trim()] = row.value
      }
      if (Object.keys(headersObj).length > 0) configObj.headers = headersObj
    }
  }
  return configObj
}

function syncJsonFromForm() {
  try {
    const config = formToConfig(editForm.value)
    // Only sync if JSON is empty or was auto-generated (not manually edited)
    editForm.value.jsonConfig = JSON.stringify(config, null, 2)
  } catch { /* ignore */ }
}

function syncFormFromJson() {
  try {
    const parsed = JSON.parse(editForm.value.jsonConfig)
    const isHttp = 'url' in parsed
    editForm.value.transportType = isHttp ? 'http' : 'stdio'
    if (isHttp) {
      editForm.value.url = parsed.url || ''
      editForm.value.transport = parsed.transport || 'sse'
      editForm.value.headers = []
      if (parsed.headers && typeof parsed.headers === 'object') {
        for (const [key, value] of Object.entries(parsed.headers)) {
          editForm.value.headers.push({ key, value: String(value) })
        }
      }
    } else {
      editForm.value.command = parsed.command || ''
      editForm.value.argsStr = Array.isArray(parsed.args) ? parsed.args.join(' ') : ''
      editForm.value.env = []
      if (parsed.env && typeof parsed.env === 'object') {
        for (const [key, value] of Object.entries(parsed.env)) {
          editForm.value.env.push({ key, value: String(value) })
        }
      }
    }
  } catch { /* ignore parse errors */ }
}

// ===== API =====
async function fetchServers() {
  try {
    const res = await fetch('/api/tools/mcp/servers')
    if (res.ok) {
      servers.value = await res.json()
    }
  } catch (error) {
    console.error('获取 MCP 服务器列表失败:', error)
  } finally {
    loading.value = false
  }
}

async function toggleActive(server: McpServer) {
  const newActive = !server.active
  try {
    const res = await fetch('/api/tools/mcp/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName: server.name, config: server.config, active: newActive })
    })
    if (res.ok) {
      server.active = newActive
      showToast(newActive ? `已启用 ${server.name}` : `已停用 ${server.name}`)
    } else {
      showToast('操作失败', 'error')
    }
  } catch (error) {
    showToast('操作失败', 'error')
  }
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  try {
    const config = formToConfig(editForm.value)
    const res = await fetch('/api/tools/mcp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    })
    if (res.ok) {
      testResult.value = await res.json()
      if (testResult.value?.success) {
        showToast('连接测试成功')
      } else {
        showToast(testResult.value?.message || '连接测试失败', 'error')
      }
    } else {
      showToast('连接测试请求失败', 'error')
    }
  } catch (error) {
    showToast('连接测试请求失败', 'error')
  } finally {
    testing.value = false
  }
}

async function saveServer() {
  if (!editForm.value.serverName.trim()) {
    showToast('服务器名称不能为空', 'error')
    return
  }

  // Validate JSON if provided
  const jsonTrim = editForm.value.jsonConfig.trim()
  if (jsonTrim) {
    try {
      JSON.parse(jsonTrim)
    } catch {
      showToast('JSON 配置格式错误', 'error')
      return
    }
  }

  // Validate required fields
  if (editForm.value.transportType === 'stdio' && !editForm.value.command.trim() && !jsonTrim) {
    showToast('Command 不能为空', 'error')
    return
  }
  if (editForm.value.transportType === 'http' && !editForm.value.url.trim() && !jsonTrim) {
    showToast('URL 不能为空', 'error')
    return
  }

  saving.value = true
  const config = formToConfig(editForm.value)
  try {
    const endpoint = isAdding.value ? '/api/tools/mcp/add' : '/api/tools/mcp/update'
    const body: Record<string, any> = {
      serverName: editForm.value.serverName.trim(),
      config
    }
    if (!isAdding.value) {
      body.active = true
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (res.ok) {
      showToast(isAdding.value ? '服务器添加成功' : '服务器更新成功')
      closeDialog()
      await fetchServers()
    } else {
      const text = await res.text()
      showToast(`保存失败: ${text}`, 'error')
    }
  } catch (error) {
    showToast('保存失败', 'error')
  } finally {
    saving.value = false
  }
}

async function deleteServer() {
  try {
    const res = await fetch('/api/tools/mcp/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName: deletingServerName.value })
    })
    if (res.ok) {
      showToast(`已删除 ${deletingServerName.value}`)
      showDeleteDialog.value = false
      await fetchServers()
    } else {
      showToast('删除失败', 'error')
    }
  } catch (error) {
    showToast('删除失败', 'error')
  }
}

// ===== Dialog Handlers =====
function openAddDialog() {
  isAdding.value = true
  editForm.value = createEmptyForm()
  testResult.value = null
  showAddDialog.value = true
}

function openEditDialog(server: McpServer) {
  isAdding.value = false
  editForm.value = configToForm(server.name, server.config)
  testResult.value = null
  showEditDialog.value = true
}

function openDeleteDialog(name: string) {
  deletingServerName.value = name
  showDeleteDialog.value = true
}

function openToolsDialog(server: McpServer) {
  viewingToolsServerName.value = server.name
  viewingTools.value = server.tools || []
  showToolsDialog.value = true
}

function closeDialog() {
  showAddDialog.value = false
  showEditDialog.value = false
  testResult.value = null
}

function addEnvRow() {
  editForm.value.env.push({ key: '', value: '' })
}

function removeEnvRow(index: number) {
  editForm.value.env.splice(index, 1)
}

function addHeaderRow() {
  editForm.value.headers.push({ key: '', value: '' })
}

function removeHeaderRow(index: number) {
  editForm.value.headers.splice(index, 1)
}

// ===== Lifecycle =====
onMounted(() => {
  fetchServers()
  pollingTimer.value = window.setInterval(fetchServers, 30000)
})

onUnmounted(() => {
  if (pollingTimer.value) clearInterval(pollingTimer.value)
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <div class="mcp-page animate-fade-in">
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1>MCP 服务器管理</h1>
        <p>管理 Model Context Protocol 服务，允许 Agent 调用外部工具及扩展能力</p>
      </div>
      <button class="btn primary" @click="openAddDialog">
        <Plus :size="16" /> 添加 MCP 服务
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading && servers.length === 0" class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- Server Cards Grid -->
    <div v-else class="server-grid">
      <div
        v-for="server in servers"
        :key="server.name"
        :class="['server-card', { inactive: !server.active }]"
      >
        <!-- Card Header -->
        <div class="card-header">
          <div class="title-info">
            <div class="name-row">
              <Server :size="16" class="server-icon" />
              <h3>{{ server.name }}</h3>
              <span :class="['transport-badge', getTransportType(server.config)]">
                {{ getTransportType(server.config) === 'http' ? 'HTTP' : 'Stdio' }}
              </span>
            </div>
          </div>
          <div class="actions">
            <button class="icon-btn" title="编辑" @click="openEditDialog(server)">
              <Pencil :size="14" />
            </button>
            <button class="icon-btn danger" title="删除" @click="openDeleteDialog(server.name)">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <!-- Card Body -->
        <div class="card-body">
          <!-- Stdio info -->
          <template v-if="getTransportType(server.config) === 'stdio'">
            <div class="info-row">
              <span class="label">命令</span>
              <span class="value font-mono text-truncate">{{ server.config.command }}</span>
            </div>
            <div v-if="server.config.args?.length" class="info-row">
              <span class="label">参数</span>
              <span class="value font-mono text-truncate">{{ server.config.args.join(' ') }}</span>
            </div>
          </template>
          <!-- HTTP info -->
          <template v-else>
            <div class="info-row">
              <span class="label">端点</span>
              <span class="value font-mono text-truncate" :title="server.config.url">{{ server.config.url }}</span>
            </div>
            <div class="info-row">
              <span class="label">协议</span>
              <span class="value font-mono">{{ server.config.transport || 'sse' }}</span>
            </div>
          </template>

          <!-- Tools count -->
          <div class="info-row clickable" @click="openToolsDialog(server)">
            <span class="label">工具</span>
            <span class="value tools-count">
              <Wrench :size="13" />
              {{ server.tools?.length || 0 }} 个
              <ChevronRight :size="14" class="chevron" />
            </span>
          </div>

          <!-- Error logs -->
          <div v-if="server.errlogs?.length" class="error-logs">
            <div class="error-header">
              <AlertTriangle :size="13" class="error-icon" />
              <span>错误日志 ({{ server.errlogs.length }})</span>
            </div>
            <div class="error-list">
              <div v-for="(log, idx) in server.errlogs" :key="idx" class="error-item font-mono">
                {{ log }}
              </div>
            </div>
          </div>
        </div>

        <!-- Card Footer -->
        <div class="card-footer">
          <div class="active-toggle" @click="toggleActive(server)">
            <div :class="['toggle-switch', { on: server.active }]">
              <div class="toggle-knob"></div>
            </div>
            <span :class="['toggle-label', { active: server.active }]">
              {{ server.active ? '运行中' : '已停用' }}
            </span>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div v-if="servers.length === 0" class="empty-state">
        <Server :size="48" class="empty-icon" />
        <p>暂无 MCP 服务器，点击右上角添加</p>
      </div>
    </div>

    <!-- Add/Edit Dialog -->
    <Teleport to="body">
      <div v-if="showAddDialog || showEditDialog" class="modal-backdrop" @click="closeDialog">
        <div class="modal-content modal-lg" @click.stop>
          <div class="modal-header">
            <h3>{{ isAdding ? '添加 MCP 服务器' : `编辑: ${editForm.serverName}` }}</h3>
            <button class="close-btn" @click="closeDialog"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="form-grid">
              <!-- Server Name -->
              <div class="form-group">
                <label>服务器名称 *</label>
                <input
                  type="text"
                  v-model="editForm.serverName"
                  :disabled="!isAdding"
                  placeholder="例如: gcal"
                  class="form-control font-mono"
                />
                <span v-if="isAdding" class="help-text">唯一标识，不可更改，作为工具调用前缀</span>
              </div>

              <!-- Transport Type -->
              <div class="form-group" v-if="isAdding">
                <label>传输类型</label>
                <select v-model="editForm.transportType" class="form-control">
                  <option value="stdio">Stdio (本地子进程)</option>
                  <option value="http">HTTP (远程服务)</option>
                </select>
              </div>

              <!-- Stdio Fields -->
              <template v-if="editForm.transportType === 'stdio'">
                <div class="form-group">
                  <label>命令 (Command) *</label>
                  <input
                    type="text"
                    v-model="editForm.command"
                    placeholder="例如: npx, node, python"
                    class="form-control font-mono"
                    @input="syncJsonFromForm"
                  />
                </div>
                <div class="form-group">
                  <label>参数 (Args，空格分隔)</label>
                  <input
                    type="text"
                    v-model="editForm.argsStr"
                    placeholder="例如: -y @modelcontextprotocol/server-gcal"
                    class="form-control font-mono"
                    @input="syncJsonFromForm"
                  />
                </div>

                <!-- Env Variables -->
                <div class="form-group span-2 list-editor">
                  <div class="list-editor-header">
                    <label>环境变量</label>
                    <button class="btn sm" @click="addEnvRow">
                      <Plus :size="14" /> 添加
                    </button>
                  </div>
                  <div class="list-rows">
                    <div v-for="(row, idx) in editForm.env" :key="idx" class="list-row">
                      <input type="text" v-model="row.key" placeholder="变量名" class="form-control font-mono half-width" @input="syncJsonFromForm" />
                      <input type="text" v-model="row.value" placeholder="值" class="form-control font-mono half-width" @input="syncJsonFromForm" />
                      <button class="icon-btn danger" @click="removeEnvRow(idx); syncJsonFromForm()">
                        <Trash2 :size="14" />
                      </button>
                    </div>
                    <div v-if="editForm.env.length === 0" class="editor-empty">
                      <p>未配置环境变量</p>
                    </div>
                  </div>
                </div>
              </template>

              <!-- HTTP Fields -->
              <template v-else>
                <div class="form-group span-2">
                  <label>端点 URL *</label>
                  <input
                    type="text"
                    v-model="editForm.url"
                    placeholder="例如: http://127.0.0.1:3011/sse"
                    class="form-control font-mono"
                    @input="syncJsonFromForm"
                  />
                </div>
                <div class="form-group">
                  <label>传输协议</label>
                  <select v-model="editForm.transport" class="form-control" @change="syncJsonFromForm">
                    <option value="sse">SSE (Server-Sent Events)</option>
                    <option value="streamable_http">Streamable HTTP</option>
                  </select>
                </div>

                <!-- Headers -->
                <div class="form-group span-2 list-editor">
                  <div class="list-editor-header">
                    <label>自定义 Headers</label>
                    <button class="btn sm" @click="addHeaderRow">
                      <Plus :size="14" /> 添加
                    </button>
                  </div>
                  <div class="list-rows">
                    <div v-for="(row, idx) in editForm.headers" :key="idx" class="list-row">
                      <input type="text" v-model="row.key" placeholder="Header 键" class="form-control font-mono half-width" @input="syncJsonFromForm" />
                      <input type="text" v-model="row.value" placeholder="值" class="form-control font-mono half-width" @input="syncJsonFromForm" />
                      <button class="icon-btn danger" @click="removeHeaderRow(idx); syncJsonFromForm()">
                        <Trash2 :size="14" />
                      </button>
                    </div>
                    <div v-if="editForm.headers.length === 0" class="editor-empty">
                      <p>未配置自定义 Header</p>
                    </div>
                  </div>
                </div>
              </template>

              <!-- JSON Config -->
              <div class="form-group span-2">
                <label>JSON 配置（可直接编辑，优先级高于上方表单）</label>
                <textarea
                  v-model="editForm.jsonConfig"
                  class="form-control font-mono textarea-json"
                  rows="6"
                  placeholder="在此编辑 JSON 配置，或留空使用上方表单生成"
                  @input="syncFormFromJson"
                ></textarea>
              </div>
            </div>

            <!-- Test Connection -->
            <div class="test-section">
              <button class="btn" :disabled="testing" @click="testConnection">
                <Loader2 v-if="testing" :size="14" class="animate-spin" />
                <RefreshCw v-else :size="14" />
                测试连接
              </button>
              <div v-if="testResult" class="test-result">
                <div v-if="testResult.success" class="test-success">
                  <CheckCircle2 :size="16" />
                  <span>{{ testResult.message || '连接成功' }}</span>
                </div>
                <div v-else class="test-fail">
                  <XCircle :size="16" />
                  <span>{{ testResult.message || '连接失败' }}</span>
                </div>
                <div v-if="testResult.tools?.length" class="test-tools">
                  <span class="test-tools-label">可用工具:</span>
                  <span v-for="tool in testResult.tools" :key="tool" class="tool-tag">{{ tool }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="closeDialog">取消</button>
            <button class="btn primary" :disabled="saving" @click="saveServer">
              <Loader2 v-if="saving" :size="14" class="animate-spin" />
              {{ saving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Delete Confirm Dialog -->
    <Teleport to="body">
      <div v-if="showDeleteDialog" class="modal-backdrop" @click="showDeleteDialog = false">
        <div class="modal-content modal-sm" @click.stop>
          <div class="modal-header">
            <h3>确认删除</h3>
            <button class="close-btn" @click="showDeleteDialog = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div class="confirm-text">
              <AlertTriangle :size="20" class="confirm-icon" />
              <p>确定要删除 MCP 服务器 <strong>{{ deletingServerName }}</strong> 吗？此操作不可撤销。</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showDeleteDialog = false">取消</button>
            <button class="btn danger" @click="deleteServer">确认删除</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Tools List Dialog -->
    <Teleport to="body">
      <div v-if="showToolsDialog" class="modal-backdrop" @click="showToolsDialog = false">
        <div class="modal-content" @click.stop>
          <div class="modal-header">
            <h3>工具列表 - {{ viewingToolsServerName }}</h3>
            <button class="close-btn" @click="showToolsDialog = false"><X :size="20" /></button>
          </div>
          <div class="modal-body">
            <div v-if="viewingTools.length" class="tools-list">
              <div v-for="tool in viewingTools" :key="tool" class="tool-item">
                <Wrench :size="14" class="tool-icon" />
                <span class="font-mono">{{ tool }}</span>
              </div>
            </div>
            <div v-else class="tools-empty">
              <Wrench :size="32" class="empty-icon" />
              <p>暂无可用工具</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showToolsDialog = false">关闭</button>
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
.mcp-page {
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

/* Server Grid */
.server-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 1.5rem;
}

.server-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1.5rem;
  backdrop-filter: var(--glass-blur);
  display: flex;
  flex-direction: column;
  transition: all 0.2s ease-in-out;
}

.server-card:hover {
  border-color: var(--border-color-hover);
  transform: translateY(-2px);
  background: var(--bg-card-hover);
}

.server-card.inactive {
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

.name-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.server-icon {
  color: var(--accent-primary);
  flex-shrink: 0;
}

.name-row h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.transport-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
}

.transport-badge.stdio {
  background: rgba(16, 185, 129, 0.15);
  color: var(--accent-success);
  border: 1px solid rgba(16, 185, 129, 0.25);
}

.transport-badge.http {
  background: rgba(59, 130, 246, 0.15);
  color: #60A5FA;
  border: 1px solid rgba(59, 130, 246, 0.25);
}

.actions {
  display: flex;
  gap: 0.4rem;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  flex-grow: 1;
}

.info-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.85rem;
}

.info-row .label {
  color: var(--text-muted);
  flex-shrink: 0;
}

.info-row .value {
  color: var(--text-primary);
  max-width: 65%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-row.clickable {
  cursor: pointer;
  padding: 0.3rem 0;
  border-radius: 6px;
  transition: background 0.15s;
}

.info-row.clickable:hover {
  background: rgba(255, 255, 255, 0.03);
}

body.light-theme .info-row.clickable:hover {
  background: rgba(15, 23, 42, 0.03);
}

.tools-count {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--accent-primary);
}

.chevron {
  opacity: 0.5;
}

/* Error Logs */
.error-logs {
  margin-top: 0.5rem;
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  overflow: hidden;
}

.error-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  background: rgba(239, 68, 68, 0.08);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--accent-danger);
}

.error-icon {
  color: var(--accent-danger);
}

.error-list {
  max-height: 120px;
  overflow-y: auto;
  padding: 0.5rem 0.75rem;
}

.error-item {
  font-size: 0.75rem;
  color: var(--accent-danger);
  opacity: 0.85;
  padding: 0.2rem 0;
  word-break: break-all;
  line-height: 1.4;
}

/* Card Footer - Active Toggle */
.card-footer {
  border-top: 1px solid var(--border-color);
  padding-top: 1rem;
  margin-top: 0.75rem;
}

.active-toggle {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  cursor: pointer;
  user-select: none;
}

.toggle-switch {
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--border-color);
  position: relative;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

body.light-theme .toggle-switch {
  background: rgba(15, 23, 42, 0.1);
}

.toggle-switch.on {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-knob {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s ease;
}

.toggle-switch.on .toggle-knob {
  transform: translateX(16px);
}

.toggle-label {
  font-size: 0.85rem;
  color: var(--text-muted);
  transition: color 0.2s;
}

.toggle-label.active {
  color: var(--accent-success);
}

/* Empty State */
.empty-state {
  grid-column: 1 / -1;
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

.empty-icon {
  opacity: 0.4;
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

.textarea-json {
  resize: vertical;
  min-height: 100px;
  font-size: 0.82rem;
  line-height: 1.5;
}

.help-text {
  font-size: 0.75rem;
  color: var(--text-muted);
}

/* List Editor */
.list-editor {
  background: rgba(255, 255, 255, 0.01);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 1rem;
}

body.light-theme .list-editor {
  background: rgba(15, 23, 42, 0.01);
}

.list-editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.list-editor-header label {
  margin-bottom: 0;
}

.list-rows {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.list-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.half-width {
  flex: 1;
}

.editor-empty {
  text-align: center;
  color: var(--text-muted);
  padding: 0.75rem 0;
  font-size: 0.8rem;
}

/* Test Section */
.test-section {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  padding-top: 0.5rem;
  flex-wrap: wrap;
}

.test-result {
  flex: 1;
  min-width: 200px;
}

.test-success {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--accent-success);
  font-size: 0.9rem;
  font-weight: 500;
}

.test-fail {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--accent-danger);
  font-size: 0.9rem;
  font-weight: 500;
}

.test-tools {
  margin-top: 0.5rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}

.test-tools-label {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.tool-tag {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent-primary);
  border: 1px solid rgba(99, 102, 241, 0.2);
}

/* Tools List Dialog */
.tools-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.tool-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border-color);
  font-size: 0.85rem;
}

body.light-theme .tool-item {
  background: rgba(15, 23, 42, 0.02);
}

.tool-icon {
  color: var(--accent-primary);
  flex-shrink: 0;
}

.tools-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 2rem;
  color: var(--text-muted);
  text-align: center;
}

/* Confirm Dialog */
.confirm-text {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.confirm-icon {
  color: var(--accent-danger);
  flex-shrink: 0;
  margin-top: 0.1rem;
}

.confirm-text p {
  font-size: 0.95rem;
  line-height: 1.5;
  color: var(--text-primary);
}

.confirm-text strong {
  color: var(--accent-primary);
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

.btn.primary:disabled,
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

.btn.sm {
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  border-radius: 6px;
}

.icon-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  transition: all 0.15s;
  display: flex;
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
  max-width: 720px;
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

.animate-spin {
  animation: spin 1s linear infinite;
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

/* Responsive */
@media (max-width: 640px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }

  .server-grid {
    grid-template-columns: 1fr;
  }

  .modal-content.modal-lg {
    max-width: 100%;
    margin: 0 12px;
  }
}
</style>
