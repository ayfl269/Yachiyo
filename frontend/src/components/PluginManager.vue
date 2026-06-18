<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { 
  Puzzle, 
  RefreshCw, 
  AlertCircle, 
  Github, 
  User, 
  Tag, 
  Activity
} from 'lucide-vue-next';

interface Plugin {
  name: string;
  author: string;
  desc: string;
  shortDesc: string;
  version: string;
  repo: string;
  modulePath: string;
  activated: boolean;
  config: Record<string, any>;
  handlerFullNames: string[];
  displayName: string;
  logoPath: string;
  supportPlatforms: string[];
}

const plugins = ref<Plugin[]>([]);
const isLoading = ref(false);
const errorMsg = ref('');

const fetchPlugins = async () => {
  isLoading.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/plugins');
    if (!res.ok) throw new Error('获取插件列表失败');
    plugins.value = await res.json();
  } catch (err: any) {
    errorMsg.value = err.message || '加载插件失败';
  } finally {
    isLoading.value = false;
  }
};

const togglePlugin = async (plugin: Plugin) => {
  const targetState = !plugin.activated;
  try {
    const res = await fetch('/api/plugins/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modulePath: plugin.modulePath,
        activated: targetState
      })
    });
    if (!res.ok) {
      const result = await res.json();
      throw new Error(result.error || '切换插件状态失败');
    }
    plugin.activated = targetState;
  } catch (err: any) {
    alert(err.message);
  }
};

onMounted(() => {
  fetchPlugins();
});
</script>

<template>
  <div class="panel-container animate-fade-in">
    <div class="panel-header">
      <div class="header-info">
        <h2>插件管理</h2>
        <p class="subtitle">管理扩展功能插件，动态控制运行时生命周期与消息处理事件处理器</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary btn-icon" @click="fetchPlugins" :disabled="isLoading">
          <RefreshCw :class="{ 'animate-spin': isLoading }" class="btn-icon-svg" />
        </button>
      </div>
    </div>

    <!-- Error Alert -->
    <div v-if="errorMsg" class="error-banner">
      <AlertCircle class="error-icon" />
      <span>{{ errorMsg }}</span>
    </div>

    <!-- Empty State -->
    <div v-if="plugins.length === 0 && !isLoading" class="empty-state">
      <Puzzle class="empty-icon" />
      <h3>没有加载到任何插件</h3>
      <p>在您的系统目录中添加扩展插件（Star）并在初始化时进行注册。</p>
    </div>

    <!-- Grid of Plugins -->
    <div v-else class="plugin-grid">
      <div v-for="plugin in plugins" :key="plugin.modulePath" :class="['plugin-card', { active: plugin.activated }]">
        <div class="card-top">
          <div class="plugin-brand">
            <div class="brand-icon-wrapper">
              <img v-if="plugin.logoPath" :src="plugin.logoPath" class="plugin-logo" alt="logo" />
              <Puzzle v-else class="brand-icon text-indigo" />
            </div>
            <div class="brand-info">
              <h3>{{ plugin.displayName || plugin.name }}</h3>
              <div class="version-row">
                <span class="version-badge"><Tag class="tag-icon" /> v{{ plugin.version || '1.0.0' }}</span>
                <span v-if="plugin.author" class="author-label"><User class="user-icon" /> {{ plugin.author }}</span>
              </div>
            </div>
          </div>
          
          <!-- Switch Toggle Button -->
          <button 
            :class="['switch-btn', { active: plugin.activated }]" 
            @click="togglePlugin(plugin)"
            :title="plugin.activated ? '禁用插件' : '启用插件'"
          >
            <span class="switch-handle"></span>
          </button>
        </div>

        <div class="card-desc">
          {{ plugin.desc || plugin.shortDesc || '该插件未提供描述信息。' }}
        </div>

        <div class="card-details">
          <!-- Supported Platforms -->
          <div class="detail-section" v-if="plugin.supportPlatforms && plugin.supportPlatforms.length > 0">
            <span class="section-label">支持平台:</span>
            <div class="tags-container">
              <span v-for="platform in plugin.supportPlatforms" :key="platform" class="tag platform-tag">
                {{ platform }}
              </span>
            </div>
          </div>

          <!-- Handlers -->
          <div class="detail-section" v-if="plugin.handlerFullNames && plugin.handlerFullNames.length > 0">
            <span class="section-label">事件监听器:</span>
            <div class="tags-container">
              <span v-for="handler in plugin.handlerFullNames" :key="handler" class="tag handler-tag">
                <Activity class="handler-icon-svg" />
                {{ handler.split('.').pop() }}
              </span>
            </div>
          </div>

          <!-- Module Path -->
          <div class="detail-row">
            <span class="detail-label">模块路径:</span>
            <code class="detail-value" :title="plugin.modulePath">{{ plugin.modulePath.split('/').pop() }}</code>
          </div>
        </div>

        <div class="card-footer-actions" v-if="plugin.repo">
          <a :href="plugin.repo" target="_blank" class="repo-link">
            <Github class="github-icon" />
            开源仓库地址
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel-container {
  padding: 1.5rem;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}

.header-info h2 {
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 0.4rem;
}

.subtitle {
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.header-actions {
  display: flex;
  gap: 0.75rem;
}

/* Plugin Grid */
.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 1.5rem;
}

.plugin-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  transition: all 0.25s ease;
  backdrop-filter: var(--glass-blur);
}

.plugin-card:hover {
  transform: translateY(-3px);
  border-color: var(--accent-primary);
  box-shadow: var(--shadow-lg);
  background: var(--bg-card-hover);
}

.plugin-card.active {
  border-color: rgba(99, 102, 241, 0.4);
  box-shadow: 0 4px 20px rgba(99, 102, 241, 0.08);
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}

.plugin-brand {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  max-width: 80%;
}

.brand-icon-wrapper {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.brand-icon {
  width: 22px;
  height: 22px;
}

.plugin-logo {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.brand-info h3 {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 0.2rem;
}

.version-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.version-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  background: rgba(255, 255, 255, 0.05);
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  font-weight: 500;
}

body.light-theme .version-badge {
  background: rgba(17, 17, 19, 0.05);
}

.tag-icon, .user-icon {
  width: 10px;
  height: 10px;
}

.author-label {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 90px;
}

/* Custom Switch Button styling */
.switch-btn {
  width: 46px;
  height: 24px;
  border-radius: 15px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid var(--border-color);
  position: relative;
  cursor: pointer;
  outline: none;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  flex-shrink: 0;
}

body.light-theme .switch-btn {
  background: rgba(17, 17, 19, 0.08);
}

.switch-btn.active {
  background: var(--accent-success);
  border-color: transparent;
}

.switch-handle {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #ffffff;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 1px 3px rgba(0,0,0,0.4);
}

.switch-btn.active .switch-handle {
  left: 24px;
}

.card-desc {
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.45;
  margin-bottom: 1.25rem;
  min-height: 2.5rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-details {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  padding: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

body.light-theme .card-details {
  background: rgba(17, 17, 19, 0.03);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.section-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
}

.tags-container {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.tag {
  font-size: 0.75rem;
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  font-weight: 500;
}

.platform-tag {
  background: rgba(16, 185, 129, 0.1);
  color: var(--accent-success);
  border: 1px solid rgba(16, 185, 129, 0.2);
}

.handler-tag {
  background: rgba(99, 102, 241, 0.08);
  color: var(--accent-primary);
  border: 1px solid rgba(99, 102, 241, 0.15);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-family: monospace;
}

.handler-icon-svg {
  width: 10px;
  height: 10px;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.8rem;
  border-top: 1px dashed var(--border-color);
  padding-top: 0.6rem;
}

.detail-label {
  color: var(--text-muted);
}

.detail-value {
  font-family: monospace;
  background: rgba(255, 255, 255, 0.05);
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  color: var(--text-primary);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body.light-theme .detail-value {
  background: rgba(17, 17, 19, 0.05);
}

.card-footer-actions {
  margin-top: auto;
  border-top: 1px solid var(--border-color);
  padding-top: 1rem;
  display: flex;
  align-items: center;
}

.repo-link {
  font-size: 0.8rem;
  color: var(--text-secondary);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  transition: color 0.2s ease;
}

.repo-link:hover {
  color: var(--text-primary);
}

.github-icon {
  width: 14px;
  height: 14px;
}

/* Core Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}
.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.08);
}

.btn-icon {
  padding: 0.6rem;
}

.btn-icon-svg {
  width: 18px;
  height: 18px;
}

/* Empty & Errors */
.empty-state {
  text-align: center;
  padding: 4rem 2rem;
  background: var(--bg-card);
  border: 1px dashed var(--border-color);
  border-radius: 12px;
}

.empty-icon {
  width: 48px;
  height: 48px;
  color: var(--text-muted);
  margin-bottom: 1.5rem;
}

.empty-state h3 {
  font-size: 1.2rem;
  color: var(--text-primary);
  margin-bottom: 0.5rem;
}

.empty-state p {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.error-banner {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  padding: 1rem;
  border-radius: 8px;
  color: #ff8787;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
  font-size: 0.9rem;
}

.error-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
</style>
