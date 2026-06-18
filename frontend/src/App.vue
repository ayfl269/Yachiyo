<script setup lang="ts">
import { ref, watch } from 'vue';
import Dashboard from './components/Dashboard.vue';
import ConfigManager from './components/ConfigManager.vue';
import ProviderManager from './components/ProviderManager.vue';
import McpManager from './components/McpManager.vue';
import SubAgentManager from './components/SubAgentManager.vue';
import SkillManager from './components/SkillManager.vue';
import KnowledgeManager from './components/KnowledgeManager.vue';
import PersonaManager from './components/PersonaManager.vue';
import MessagePlatformManager from './components/MessagePlatformManager.vue';
import ChatDataManager from './components/ChatDataManager.vue';
import PluginManager from './components/PluginManager.vue';
import MemoryManager from './components/MemoryManager.vue';
import {
  LayoutDashboard, 
  Settings, 
  HardDrive, 
  Terminal, 
  Sun, 
  Moon,
  Users,
  FileCode,
  BookOpen,
  Sparkles,
  Menu,
  MessageSquare,
  Database,
  Puzzle,
  Brain
} from 'lucide-vue-next';

type TabType = 'dashboard' | 'configs' | 'providers' | 'mcp' | 'subagents' | 'skills' | 'kbs' | 'personas' | 'platforms' | 'chatdata' | 'plugins' | 'memory';
const currentTab = ref<TabType>((localStorage.getItem('currentTab') as TabType) || 'dashboard');

watch(currentTab, (val) => {
  localStorage.setItem('currentTab', val);
});

const isLightMode = ref(localStorage.getItem('theme') === 'light');
const isSidebarCollapsed = ref(localStorage.getItem('sidebarCollapsed') === 'true');

const toggleSidebar = () => {
  isSidebarCollapsed.value = !isSidebarCollapsed.value;
  localStorage.setItem('sidebarCollapsed', String(isSidebarCollapsed.value));
};

const applyTheme = () => {
  if (isLightMode.value) {
    document.body.classList.add('light-theme');
    localStorage.setItem('theme', 'light');
  } else {
    document.body.classList.remove('light-theme');
    localStorage.setItem('theme', 'dark');
  }
};

// Initial theme apply
applyTheme();

const toggleTheme = () => {
  isLightMode.value = !isLightMode.value;
  applyTheme();
};

</script>

<template>
  <div class="app-container">
    <!-- Top Bar spans full width at the very top -->
    <header class="topbar">
      <div :class="['topbar-left', { collapsed: isSidebarCollapsed }]">
        <button class="collapse-btn" @click="toggleSidebar" :title="isSidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'">
          <Menu class="topbar-icon" />
        </button>
      </div>
      <div class="topbar-right">
        <button class="topbar-theme-toggle" @click="toggleTheme" :title="isLightMode ? '切换为暗色模式' : '切换为亮色模式'">
          <Sun v-if="isLightMode" class="topbar-icon" />
          <Moon v-else class="topbar-icon" />
        </button>
      </div>
    </header>

    <div class="layout-wrapper">
      <!-- Sidebar Navigation nested below the topbar -->
      <aside :class="['sidebar', { collapsed: isSidebarCollapsed }]">
        <nav class="nav-links">
          <button 
            :class="['nav-link', { active: currentTab === 'dashboard' }]" 
            @click="currentTab = 'dashboard'"
            :title="isSidebarCollapsed ? '仪表盘' : ''"
          >
            <LayoutDashboard class="nav-icon" />
            <span class="nav-text">仪表盘</span>
          </button>

          <button 
            :class="['nav-link', { active: currentTab === 'platforms' }]" 
            @click="currentTab = 'platforms'"
            :title="isSidebarCollapsed ? '消息平台' : ''"
          >
            <MessageSquare class="nav-icon" />
            <span class="nav-text">消息平台</span>
          </button>

          <button 
            :class="['nav-link', { active: currentTab === 'providers' }]" 
            @click="currentTab = 'providers'"
            :title="isSidebarCollapsed ? '模型提供商' : ''"
          >
            <HardDrive class="nav-icon" />
            <span class="nav-text">模型提供商</span>
          </button>

          <button 
            :class="['nav-link', { active: currentTab === 'personas' }]" 
            @click="currentTab = 'personas'"
            :title="isSidebarCollapsed ? '角色设定' : ''"
          >
            <Sparkles class="nav-icon" />
            <span class="nav-text">角色设定</span>
          </button>

          <button
            :class="['nav-link', { active: currentTab === 'kbs' }]"
            @click="currentTab = 'kbs'"
            :title="isSidebarCollapsed ? '知识库' : ''"
          >
            <BookOpen class="nav-icon" />
            <span class="nav-text">知识库</span>
          </button>

          <button 
            :class="['nav-link', { active: currentTab === 'plugins' }]" 
            @click="currentTab = 'plugins'"
            :title="isSidebarCollapsed ? '插件管理' : ''"
          >
            <Puzzle class="nav-icon" />
            <span class="nav-text">插件管理</span>
          </button>

          <button 
            :class="['nav-link', { active: currentTab === 'mcp' }]" 
            @click="currentTab = 'mcp'"
            :title="isSidebarCollapsed ? 'MCP' : ''"
          >
            <Terminal class="nav-icon" />
            <span class="nav-text">MCP</span>
          </button>

          <button 
            :class="['nav-link', { active: currentTab === 'subagents' }]" 
            @click="currentTab = 'subagents'"
            :title="isSidebarCollapsed ? '子 Agent' : ''"
          >
            <Users class="nav-icon" />
            <span class="nav-text">子 Agent</span>
          </button>

          <button 
            :class="['nav-link', { active: currentTab === 'skills' }]" 
            @click="currentTab = 'skills'"
            :title="isSidebarCollapsed ? 'Skills' : ''"
          >
            <FileCode class="nav-icon" />
            <span class="nav-text">Skills</span>
          </button>

          <button
            :class="['nav-link', { active: currentTab === 'memory' }]"
            @click="currentTab = 'memory'"
            :title="isSidebarCollapsed ? '记忆' : ''"
          >
            <Brain class="nav-icon" />
            <span class="nav-text">记忆</span>
          </button>
          <button
            :class="['nav-link', { active: currentTab === 'chatdata' }]"
            @click="currentTab = 'chatdata'"
            :title="isSidebarCollapsed ? '对话数据' : ''"
          >
            <Database class="nav-icon" />
            <span class="nav-text">对话数据</span>
          </button>

          <button 
            :class="['nav-link', { active: currentTab === 'configs' }]" 
            @click="currentTab = 'configs'"
            :title="isSidebarCollapsed ? '配置' : ''"
          >
            <Settings class="nav-icon" />
            <span class="nav-text">配置</span>
          </button>

        </nav>
      </aside>

      <!-- Mobile Sidebar Overlay Backdrop -->
      <div v-if="!isSidebarCollapsed" class="sidebar-overlay" @click="toggleSidebar"></div>

      <!-- Main Content Area -->
      <main class="main-content">
        <div class="content-container">
          <Dashboard v-if="currentTab === 'dashboard'" />
          <ChatDataManager v-else-if="currentTab === 'chatdata'" />
          <ConfigManager v-else-if="currentTab === 'configs'" />
          <ProviderManager v-else-if="currentTab === 'providers'" />
          <MessagePlatformManager v-else-if="currentTab === 'platforms'" />
          <McpManager v-else-if="currentTab === 'mcp'" />
          <SubAgentManager v-else-if="currentTab === 'subagents'" />
          <SkillManager v-else-if="currentTab === 'skills'" />
          <KnowledgeManager v-else-if="currentTab === 'kbs'" />
          <MemoryManager v-else-if="currentTab === 'memory'" />
          <PersonaManager v-else-if="currentTab === 'personas'" />
          <PluginManager v-else-if="currentTab === 'plugins'" />
        </div>
      </main>
    </div>
  </div>
</template>

<style>
/* Reset and global layout settings inside App.vue styles */
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.layout-wrapper {
  display: flex;
  flex-grow: 1;
  overflow: hidden;
  background-color: var(--bg-main);
  background-image: 
    radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.05) 0px, transparent 50%),
    radial-gradient(at 100% 100%, rgba(16, 185, 129, 0.05) 0px, transparent 50%);
}

.sidebar {
  width: 200px;
  background-color: var(--bg-sidebar);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  height: 100%;
  padding: 1.5rem 1rem;
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), padding 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow-y: auto;
}

.sidebar.collapsed {
  width: 72px;
  padding: 1.5rem 0.75rem;
}

.sidebar-overlay {
  display: none;
}

/* Sidebar Header removed as it is now in topbar */

.collapse-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.collapse-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

body.light-theme .collapse-btn:hover {
  background: rgba(17, 17, 19, 0.05);
}

.nav-links {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex-grow: 1;
}

.nav-link {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 0.8rem 1rem;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.95rem;
  font-weight: 500;
  transition: all 0.2s ease, padding 0.3s cubic-bezier(0.4, 0, 0.2, 1), justify-content 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
  white-space: nowrap;
}

.sidebar.collapsed .nav-link {
  justify-content: center;
  padding: 0.8rem 0;
  gap: 0;
}

.nav-text {
  opacity: 1;
  transition: opacity 0.15s ease, width 0.15s ease, margin 0.15s ease;
  display: inline-block;
}

.sidebar.collapsed .nav-text {
  display: none;
}

.nav-link:hover {
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-primary);
  transform: translateX(2px);
}

.nav-link.active {
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent-primary);
  font-weight: 600;
}

.nav-icon {
  width: 20px;
  height: 20px;
}

.sidebar-footer {
  padding-top: 1rem;
  border-top: 1px solid var(--border-color);
}

.theme-toggle {
  margin-bottom: 0.75rem;
  width: 100%;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.pulse-dot {
  width: 8px;
  height: 8px;
  background-color: var(--accent-success);
  border-radius: 50%;
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  animation: pulse 1.6s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  }
  70% {
    transform: scale(1);
    box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
  }
  100% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
  }
}

.main-content {
  flex-grow: 1;
  padding: 2.5rem;
  overflow-y: auto;
}

@media (max-width: 768px) {
  .main-content {
    padding: 1.5rem;
  }
}

.content-container {
  max-width: 1600px;
  margin: 0 auto;
}

@keyframes pulse-icon {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.animate-pulse {
  animation: pulse-icon 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

/* Topbar Styles */
.topbar {
  height: 64px;
  background-color: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2.5rem 0 0;
  flex-shrink: 0;
  backdrop-filter: var(--glass-blur);
  z-index: 100;
}

.topbar-left {
  width: 200px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-left: 24px;
  border-right: 1px solid var(--border-color);
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1), padding-left 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  flex-shrink: 0;
}

.topbar-left.collapsed {
  width: 72px;
  padding-left: 19px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.topbar-theme-toggle {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.topbar-theme-toggle:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  border-color: var(--border-color-hover);
  transform: scale(1.05);
}

body.light-theme .topbar-theme-toggle:hover {
  background: rgba(17, 17, 19, 0.05);
}

.topbar-icon {
  width: 18px;
  height: 18px;
}

@media (max-width: 768px) {
  .app-container {
    height: 100vh;
    overflow: hidden;
  }
  .layout-wrapper {
    flex-direction: row;
    overflow: hidden;
    position: relative;
  }
  .sidebar {
    position: fixed;
    top: 64px;
    left: 0;
    bottom: 0;
    width: 240px !important;
    height: calc(100vh - 64px);
    z-index: 1000;
    transform: translateX(0);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 8px 0 24px rgba(0, 0, 0, 0.3);
    border-right: 1px solid var(--border-color);
  }
  .sidebar.collapsed {
    transform: translateX(-100%);
    width: 240px !important;
    padding: 1.5rem 1rem;
  }
  .sidebar.collapsed .nav-text {
    display: inline-block;
  }
  .sidebar.collapsed .nav-link {
    justify-content: flex-start;
    padding: 0.8rem 1rem;
    gap: 1rem;
  }
  .sidebar-overlay {
    display: block;
    position: fixed;
    top: 64px;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(4px);
    z-index: 999;
  }
  .main-content {
    height: 100%;
    width: 100%;
    overflow-y: auto;
    padding: 1.5rem 1rem;
  }
  .topbar {
    padding: 0 1rem;
  }
  .topbar-left {
    width: auto;
    border-right: none;
    padding-left: 0;
  }
  .topbar-left.collapsed {
    width: auto;
    padding-left: 0;
  }
}
</style>
