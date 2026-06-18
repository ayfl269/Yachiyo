<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Plus, Trash2, X, Users } from 'lucide-vue-next';

interface SubAgent {
  name: string;
  instructions: string;
  description: string;
  tools: string[] | null;
}

const subAgents = ref<SubAgent[]>([]);
const loading = ref(true);

const editingSubAgent = ref<{
  name: string;
  instructions: string;
  description: string;
  tools: string[];
} | null>(null);

const isNew = ref(false);
const showModal = ref(false);
const newToolName = ref('');

const fetchSubAgents = async () => {
  loading.value = true;
  try {
    const res = await fetch('/api/subagents');
    if (res.ok) {
      subAgents.value = await res.json();
    }
  } catch (error) {
    console.error('Error fetching sub-agents:', error);
  } finally {
    loading.value = false;
  }
};

const handleCreate = () => {
  isNew.value = true;
  editingSubAgent.value = {
    name: '',
    instructions: '',
    description: '',
    tools: []
  };
  showModal.value = true;
};

const handleAddTool = () => {
  if (newToolName.value.trim() && editingSubAgent.value) {
    if (!editingSubAgent.value.tools.includes(newToolName.value.trim())) {
      editingSubAgent.value.tools.push(newToolName.value.trim());
    }
    newToolName.value = '';
  }
};

const handleRemoveTool = (index: number) => {
  if (editingSubAgent.value) {
    editingSubAgent.value.tools.splice(index, 1);
  }
};

const handleDelete = async (name: string) => {
  if (!confirm(`确定要注销并删除子 Agent "${name}" 吗？`)) return;
  try {
    const res = await fetch(`/api/subagents/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (res.ok) {
      await fetchSubAgents();
    } else {
      alert('删除失败');
    }
  } catch (error) {
    console.error('Error deleting sub-agent:', error);
  }
};

const handleSave = async () => {
  if (!editingSubAgent.value) return;
  if (!editingSubAgent.value.name.trim()) {
    alert('子 Agent 名称不能为空');
    return;
  }
  if (!editingSubAgent.value.instructions.trim()) {
    alert('指令 instructions 不能为空');
    return;
  }

  try {
    const res = await fetch('/api/subagents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: editingSubAgent.value.name.trim(),
        instructions: editingSubAgent.value.instructions.trim(),
        description: editingSubAgent.value.description.trim() || undefined,
        tools: editingSubAgent.value.tools.length > 0 ? editingSubAgent.value.tools : undefined
      })
    });
    if (res.ok) {
      editingSubAgent.value = null;
      showModal.value = false;
      await fetchSubAgents();
    } else {
      alert('保存失败');
    }
  } catch (error) {
    console.error('Error saving sub-agent:', error);
  }
};

onMounted(fetchSubAgents);
</script>

<template>
  <div class="sub-agent-view animate-fade-in">
    <div class="header">
      <div class="header-main">
        <div>
          <h1>子 Agent 管理</h1>
          <p>管理动态创建的子代理。注册后，它们将在主 Agent 的决策工具箱中可用，用于分派特定复杂的子任务。</p>
        </div>
        <button class="btn primary" @click="handleCreate">
          <Plus class="icon-inline" /> 添加子 Agent
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && subAgents.length === 0" class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- List -->
    <div v-if="!loading || subAgents.length > 0" class="agents-grid">
      <div v-for="agent in subAgents" :key="agent.name" class="agent-card">
        <div class="card-header">
          <div class="title-info">
            <div class="name-row">
              <Users class="icon-inline accent" />
              <h3>{{ agent.name }}</h3>
            </div>
            <p class="description">{{ agent.description || '暂无描述' }}</p>
          </div>
          <div class="actions">
            <button class="btn icon-btn danger" title="删除" @click="handleDelete(agent.name)">
              <Trash2 class="icon-inline" />
            </button>
          </div>
        </div>

        <div class="card-body">
          <div class="details-list">
            <div class="info-row">
              <span class="label">系统指令 (System Prompt):</span>
              <p class="value-block text-truncate-3">{{ agent.instructions }}</p>
            </div>
            <div class="info-row" v-if="agent.tools && agent.tools.length > 0">
              <span class="label">可用工具 (Tools):</span>
              <div class="tools-tags">
                <span v-for="tool in agent.tools" :key="tool" class="tool-tag">
                  {{ tool }}
                </span>
              </div>
            </div>
            <div class="info-row" v-else>
              <span class="label">可用工具 (Tools):</span>
              <span class="value text-muted">默认工具集</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="subAgents.length === 0" class="no-data-card">
        <Users class="empty-icon" />
        <h3>没有已注册的子 Agent</h3>
        <p>动态创建的子 Agent 允许主 Agent 在对话时通过生成专门的任务代表来协同工作。</p>
        <button class="btn primary" @click="handleCreate">创建第一个子 Agent</button>
      </div>
    </div>

    <!-- Create/Edit Modal -->
    <Teleport to="body">
    <div v-if="showModal" class="modal-backdrop" @click="showModal = false">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h3>{{ isNew ? '创建新子 Agent' : '编辑子 Agent' }}</h3>
          <button class="close-btn" @click="showModal = false"><X class="close-icon"/></button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Agent 名称 <span class="required">*</span></label>
            <input
              type="text"
              v-model="editingSubAgent!.name"
              placeholder="例如: CodeAnalyzer, WebSearcher"
              :disabled="!isNew"
              class="form-control"
            />
            <p class="help-text">用于主 Agent 识别并派发任务的唯一名称，建议仅使用字母和数字。</p>
          </div>

          <div class="form-group">
            <label>意图描述 (Description)</label>
            <textarea
              v-model="editingSubAgent!.description"
              placeholder="例如: 负责深度解析代码，并在项目结构中查找问题"
              rows="2"
              class="form-control"
            ></textarea>
            <p class="help-text">在分派工具描述中显示，模型将根据此描述评估何时调用该子 Agent。</p>
          </div>

          <div class="form-group">
            <label>系统提示词 (System Prompt) <span class="required">*</span></label>
            <textarea
              v-model="editingSubAgent!.instructions"
              placeholder="请详细描述此子 Agent 的角色设定、回答风格和执行逻辑..."
              rows="6"
              class="form-control font-mono"
            ></textarea>
            <p class="help-text">子 Agent 在独立运行时接收的专属系统级别提示指令。</p>
          </div>

          <div class="form-group">
            <label>关联的工具列表 (Tools)</label>
            <div class="tool-input-row">
              <input
                type="text"
                v-model="newToolName"
                placeholder="输入工具名称，按回车或点添加"
                @keyup.enter="handleAddTool"
                class="form-control"
              />
              <button class="btn secondary" @click="handleAddTool">添加</button>
            </div>
            <div class="tools-tags-edit" v-if="editingSubAgent!.tools.length > 0">
              <span v-for="(tool, index) in editingSubAgent!.tools" :key="tool" class="tool-tag-edit">
                {{ tool }}
                <X class="tag-close-icon" @click="handleRemoveTool(index)" />
              </span>
            </div>
            <p class="help-text">指定该子 Agent 可以调用的工具（如 webSearch, read_file 等）。不填则为默认全量工具。</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showModal = false">取消</button>
          <button class="btn btn-primary" @click="handleSave">保存并注册</button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sub-agent-view {
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
  gap: 1rem;
}

@media (max-width: 600px) {
  .header-main {
    flex-direction: column;
    align-items: flex-start;
  }
}

.header h1 {
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
}

.header p {
  color: var(--text-secondary);
  font-size: 0.95rem;
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

.agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 1.5rem;
}

@media (max-width: 480px) {
  .agents-grid {
    grid-template-columns: 1fr;
  }
}

.agent-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  transition: all 0.2s ease-in-out;
  backdrop-filter: var(--glass-blur);
  overflow: hidden;
}

.agent-card:hover {
  border-color: var(--border-color-hover);
  transform: translateY(-2px);
  background: var(--bg-card-hover);
}

.card-header {
  padding: 1.25rem;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.title-info {
  flex-grow: 1;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}

.name-row h3 {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--text-primary);
}

.icon-inline.accent {
  color: var(--accent-primary);
}

.description {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.card-body {
  padding: 1.25rem;
  flex-grow: 1;
}

.details-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.info-row {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.info-row .label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.value-block {
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.03);
  border-radius: 6px;
  padding: 0.6rem 0.8rem;
  font-size: 0.85rem;
  color: var(--text-primary);
  line-height: 1.4;
  white-space: pre-wrap;
}

.text-truncate-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: 4.2em;
}

.tools-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.tool-tag {
  background: rgba(99, 102, 241, 0.1);
  color: #818CF8;
  border: 1px solid rgba(99, 102, 241, 0.2);
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-family: monospace;
}

/* Button & Forms styling */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease-in-out;
}

.btn.primary {
  background: var(--accent-primary);
  color: #ffffff;
}

.btn.primary:hover {
  background: var(--accent-primary-hover);
}

.btn.secondary {
  background: rgba(255, 255, 255, 0.05);
  border-color: var(--border-color);
  color: var(--text-primary);
}

.btn.secondary:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--border-color-hover);
}

.btn.icon-btn {
  padding: 0.4rem;
  border-radius: 6px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
}

.btn.icon-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.btn.icon-btn.danger {
  color: var(--text-secondary);
}

.btn.icon-btn.danger:hover {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.2);
  color: #FB7185;
}

.icon-inline {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* Form Styles */
.form-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 2rem;
  backdrop-filter: var(--glass-blur);
}

.form-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border-color);
}

.form-body {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  margin-bottom: 2rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.form-group label {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
}

.required {
  color: var(--accent-danger);
}

.form-control {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  font-size: 0.9rem;
  transition: all 0.2s ease;
  width: 100%;
}

.form-control:focus {
  border-color: var(--accent-primary);
  outline: none;
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}

.form-control:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

textarea.form-control {
  resize: vertical;
}

.help-text {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.font-mono {
  font-family: monospace;
}

.tool-input-row {
  display: flex;
  gap: 0.5rem;
}

.tools-tags-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  background: rgba(0, 0, 0, 0.15);
  padding: 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  min-height: 40px;
}

.tool-tag-edit {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: rgba(99, 102, 241, 0.15);
  color: #818CF8;
  border: 1px solid rgba(99, 102, 241, 0.3);
  font-size: 0.8rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-family: monospace;
}

.tag-close-icon {
  width: 12px;
  height: 12px;
  cursor: pointer;
  opacity: 0.7;
}

.tag-close-icon:hover {
  opacity: 1;
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  border-top: 1px solid var(--border-color);
  padding-top: 1.5rem;
}

.no-data-card {
  grid-column: 1 / -1;
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

.empty-icon {
  width: 48px;
  height: 48px;
  color: var(--text-muted);
  opacity: 0.5;
}

.no-data-card h3 {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text-primary);
}

.no-data-card p {
  color: var(--text-secondary);
  font-size: 0.9rem;
  max-width: 420px;
  margin-bottom: 0.5rem;
}

/* Modal Styles */
.modal-backdrop{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:999}
.modal-content{background:var(--bg-modal);border:1px solid var(--border-color);border-radius:12px;width:100%;max-width:580px;box-shadow:var(--shadow-lg);overflow:hidden;animation:modalEnter .2s cubic-bezier(.16,1,.3,1)forwards}
@keyframes modalEnter{from{opacity:0;transform:scale(.95)translateY(10px)}to{opacity:1;transform:scale(1)translateY(0)}}
.modal-header{display:flex;justify-content:space-between;align-items:center;padding:1.25rem;border-bottom:1px solid var(--border-color)}
.modal-header h3{font-size:1.2rem;font-weight:600;color:var(--text-primary)}
.close-btn{background:transparent;border:none;cursor:pointer;color:var(--text-secondary)}.close-icon{width:20px;height:20px}
.modal-body{padding:1.5rem;display:flex;flex-direction:column;gap:1.25rem;max-height:70vh;overflow-y:auto}
.modal-footer{padding:1.25rem;border-top:1px solid var(--border-color);display:flex;justify-content:flex-end;gap:.75rem}
.btn.btn-primary{background:var(--accent-primary);color:#ffffff}
.btn.btn-primary:hover{background:var(--accent-primary-hover)}
.btn.btn-secondary{background:rgba(255,255,255,.05);border-color:var(--border-color);color:var(--text-primary)}
.btn.btn-secondary:hover{background:rgba(255,255,255,.1);border-color:var(--border-color-hover)}
</style>
