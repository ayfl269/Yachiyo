<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import {
  MessageSquare,
  Plus,
  AlertCircle,
  RefreshCw,
  X,
  QrCode
} from 'lucide-vue-next';

interface AdapterMeta {
  name: string;
  description: string;
  id: string;
  supportStreamingMessage?: boolean;
  supportProactiveMessage?: boolean;
}

interface Adapter {
  id: string;
  name: string;
  type: string;
  status: string;
  isRunning: boolean;
  meta: AdapterMeta;
  config: Record<string, any>;
}

const adapters = ref<Adapter[]>([]);
const isLoading = ref(false);
const errorMsg = ref('');

// Modal state
const showModal = ref(false);
const isEditMode = ref(false);
const editingAdapterId = ref('');
const modalAdapterType = ref('onebot11');
const modalAdapterId = ref('');

// OneBot11 form fields
const ob11Direction = ref<'forward' | 'reverse'>('forward');
const ob11Port = ref(8080);
const ob11Host = ref('0.0.0.0');
const ob11Path = ref('/ws');
const ob11ReverseUrl = ref('ws://127.0.0.1:6700');
const ob11ReconnectInterval = ref(5000);
const ob11AccessToken = ref('');

// QQ Official form fields
const qqAppId = ref('');
const qqAppSecret = ref('');
const qqIntents = ref<number | null>(null);

// Weixin OC — post-create QR scan flow
import QRCode from 'qrcode';

// Mode: 'create' | 'scanning' | 'success' | 'error'
const wxMode = ref<'create' | 'scanning' | 'success' | 'error'>('create');
const wxPostCreateQrImage = ref<string | null>(null);
const wxPostCreateStatus = ref<string>('');
const wxPostCreateAccountId = ref('');
const wxPostCreateError = ref('');
let wxPostCreatePollTimer: ReturnType<typeof setInterval> | null = null;

const startWxPostCreateScan = async (adapterId: string) => {
  wxMode.value = 'scanning';
  wxPostCreateQrImage.value = null;
  wxPostCreateStatus.value = '';
  wxPostCreateAccountId.value = '';
  wxPostCreateError.value = '';
  let pollCount = 0;
  const MAX_POLLS = 60; // 60 * 3s = 3 minutes max

  const poll = async () => {
    pollCount++;
    try {
      const res = await fetch(`/api/adapters/${encodeURIComponent(adapterId)}/qrcode`);
      if (!res.ok) {
        console.warn(`[WxOC] qrcode API returned ${res.status}`);
        if (pollCount > 3) {
          wxPostCreateError.value = `无法连接到服务器 (HTTP ${res.status})，请检查后端是否运行中`;
        }
        return;
      }

      const data = await res.json();
      wxPostCreateStatus.value = data.qrStatus ?? '';
      wxPostCreateAccountId.value = data.accountId ?? '';
      // Clear error on successful response
      if (wxPostCreateError.value?.startsWith('无法连接') || wxPostCreateError.value?.startsWith('网络错误')) {
        wxPostCreateError.value = '';
      }

      if (data.loggedIn) {
        // Login successful!
        wxMode.value = 'success';
        stopWxPostCreatePolling();
        fetchAdapters();
        return;
      }

      // Render QR from adapter's own session
      const url = data.qrImgContent || '';
      if (url) {
        wxPostCreateQrImage.value = await QRCode.toDataURL(url, {
          margin: 2,
          width: 200,
          errorCorrectionLevel: 'M',
        });
      } else {
        // No QR yet — adapter might still be initializing
        // Keep showing loading state, don't reset image
        if (pollCount > 5) {
          wxPostCreateError.value = '二维码生成中，请稍候... (' + pollCount + ')';
        }
      }
    } catch (e) {
      console.error('[WxOC] Poll error:', e);
      wxPostCreateError.value = '网络错误，正在重试...';
    }
  };

  // Wait briefly for adapter's run() IIFE to start login session
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Initial poll
  await poll();
  // Then poll every 3 seconds
  wxPostCreatePollTimer = setInterval(() => {
    if (pollCount >= MAX_POLLS) {
      stopWxPostCreatePolling();
      wxPostCreateError.value = '超时，请刷新重试或重新添加适配器';
      return;
    }
    poll();
  }, 3000);
};

const stopWxPostCreatePolling = () => {
  if (wxPostCreatePollTimer) {
    clearInterval(wxPostCreatePollTimer);
    wxPostCreatePollTimer = null;
  }
};

const refreshWxPostCreateQr = () => {
  if (wxPostCreatePollTimer && wxMode.value === 'scanning') {
    // Trigger immediate poll
    const timer = wxPostCreatePollTimer;
    clearInterval(timer);
    wxPostCreatePollTimer = null;
    (async () => {
      try {
        const res = await fetch(`/api/adapters/${encodeURIComponent(wxScanningAdapterId.value)}/qrcode`);
        if (res.ok) {
          const data = await res.json();
          const url = data.qrImgContent || '';
          if (url) {
            wxPostCreateQrImage.value = await QRCode.toDataURL(url, {
              margin: 2, width: 200, errorCorrectionLevel: 'M',
            });
          }
          wxPostCreateStatus.value = data.qrStatus ?? '';
        }
      } catch { /* ignore */ }
      // Resume polling
      wxPostCreatePollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/adapters/${encodeURIComponent(wxScanningAdapterId.value)}/qrcode`);
          if (res.ok) {
            const data = await res.json();
            if (data.loggedIn) {
              wxMode.value = 'success';
              stopWxPostCreatePolling();
              fetchAdapters();
              return;
            }
            const url = data.qrImgContent || '';
            if (url) {
              wxPostCreateQrImage.value = await QRCode.toDataURL(url, { margin: 2, width: 200, errorCorrectionLevel: 'M' });
            }
            wxPostCreateStatus.value = data.qrStatus ?? '';
          }
        } catch { /* ignore */ }
      }, 3000);
    })();
  }
};

const wxScanningAdapterId = ref('');

// Weixin OC edit mode token info
const editingWxAccountId = ref('');
const editingWxToken = ref('');
const editingWxLoggedIn = ref(false);

// QR code login state for weixin_oc (for edit mode)
interface QRLoginStatus {
  loggedIn: boolean;
  accountId: string | null;
  qrStatus: string | null;
  qrImgContent: string | null;
  qrError: string | null;
}
const qrLoginStatuses = ref<Record<string, QRLoginStatus>>({});
const qrCardImages = ref<Record<string, string>>({});
let qrPollTimer: ReturnType<typeof setInterval> | null = null;

const fetchAdapters = async () => {
  isLoading.value = true;
  errorMsg.value = '';
  try {
    const res = await fetch('/api/adapters');
    if (!res.ok) throw new Error('获取平台列表失败');
    adapters.value = await res.json();
  } catch (err: any) {
    errorMsg.value = err.message || '加载消息平台失败';
  } finally {
    isLoading.value = false;
  }
};

const resetForm = () => {
  modalAdapterId.value = '';
  modalAdapterType.value = 'onebot11';
  ob11Direction.value = 'forward';
  ob11Port.value = 8080;
  ob11Host.value = '0.0.0.0';
  ob11Path.value = '/ws';
  ob11ReverseUrl.value = 'ws://127.0.0.1:6700';
  ob11ReconnectInterval.value = 5000;
  ob11AccessToken.value = '';
  qqAppId.value = '';
  qqAppSecret.value = '';
  qqIntents.value = null;
  wxMode.value = 'create';
  stopWxPostCreatePolling();
};

const openAddModal = () => {
  isEditMode.value = false;
  editingAdapterId.value = '';
  resetForm();
  showModal.value = true;
};

const openEditModal = (adapter: Adapter) => {
  isEditMode.value = true;
  editingAdapterId.value = adapter.id;
  modalAdapterType.value = adapter.type;
  modalAdapterId.value = adapter.id;

  // Populate form from existing config
  if (adapter.type === 'onebot11') {
    ob11Direction.value = adapter.config.direction ?? 'forward';
    ob11Port.value = adapter.config.port ?? 8080;
    ob11Host.value = adapter.config.host ?? '0.0.0.0';
    ob11Path.value = adapter.config.path ?? '/ws';
    ob11ReverseUrl.value = adapter.config.reverseUrl ?? 'ws://127.0.0.1:6700';
    ob11ReconnectInterval.value = adapter.config.reconnectInterval ?? 5000;
    ob11AccessToken.value = adapter.config.accessToken ?? '';
  } else if (adapter.type === 'qqofficial') {
    qqAppId.value = adapter.config.appId ?? '';
    qqAppSecret.value = adapter.config.appSecret ?? '';
    qqIntents.value = adapter.config.intents ?? null;
  } else if (adapter.type === 'weixin_oc') {
    // Load token info for display
    editingWxAccountId.value = adapter.config.accountId ?? '';
    editingWxToken.value = adapter.config.token ?? '';
    editingWxLoggedIn.value = !!adapter.config.token;
    // Fetch latest login status from backend
    fetchQrLoginStatus(adapter.id).then(() => {
      const status = qrLoginStatuses.value[adapter.id];
      if (status) {
        editingWxAccountId.value = status.accountId ?? editingWxAccountId.value;
        editingWxLoggedIn.value = status.loggedIn ?? editingWxLoggedIn.value;
      }
    });
  }

  showModal.value = true;
};

const buildConfig = (): Record<string, any> => {
  const config: Record<string, any> = {};
  if (modalAdapterType.value === 'onebot11') {
    config.direction = ob11Direction.value;
    if (ob11Direction.value === 'forward') {
      config.port = Number(ob11Port.value);
      config.host = ob11Host.value;
      config.path = ob11Path.value;
    } else {
      config.reverseUrl = ob11ReverseUrl.value;
      config.reconnectInterval = Number(ob11ReconnectInterval.value);
    }
    if (ob11AccessToken.value.trim()) {
      config.accessToken = ob11AccessToken.value.trim();
    }
  } else if (modalAdapterType.value === 'qqofficial') {
    config.appId = qqAppId.value.trim();
    config.appSecret = qqAppSecret.value.trim();
    if (qqIntents.value != null) {
      config.intents = qqIntents.value;
    }
  } else if (modalAdapterType.value === 'weixin_oc') {
    // weixin_oc 使用默认配置，扫码登录即可
  }
  return config;
};

const submitAdapter = async () => {
  if (!isEditMode.value && !modalAdapterId.value.trim()) {
    alert('请输入平台实例 ID');
    return;
  }

  const config = buildConfig();

  try {
    if (isEditMode.value) {
      // PUT — update existing adapter
      const res = await fetch(`/api/adapters/${encodeURIComponent(editingAdapterId.value)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: modalAdapterType.value, config })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '更新适配器失败');

      showModal.value = false;
      resetForm();
      await fetchAdapters();
    } else {
      // POST — add new adapter
      const res = await fetch('/api/adapters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: modalAdapterType.value,
          id: modalAdapterId.value.trim(),
          config
        })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '添加适配器失败');

      if (modalAdapterType.value === 'weixin_oc') {
        // Don't close modal — switch to post-create QR scan mode
        wxScanningAdapterId.value = modalAdapterId.value.trim();
        await startWxPostCreateScan(wxScanningAdapterId.value);
      } else {
        showModal.value = false;
        resetForm();
      }
      await fetchAdapters();
    }
  } catch (err: any) {
    alert(err.message);
  }
};

const deleteAdapter = async (id: string) => {
  if (!confirm(`确定要移除平台适配器 "${id}" 吗？`)) return;
  try {
    const res = await fetch(`/api/adapters/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const result = await res.json();
      throw new Error(result.error || '移除失败');
    }
    await fetchAdapters();
  } catch (err: any) {
    alert(err.message);
  }
};

const toggleAdapter = async (id: string) => {
  try {
    const res = await fetch(`/api/adapters/${encodeURIComponent(id)}/toggle`, { method: 'PATCH' });
    if (!res.ok) throw new Error('切换状态失败');
    await fetchAdapters();
  } catch (err: any) {
    alert(err.message);
  }
};

/*
const getStatusBadgeClass = (status: string) => {
  switch (status.toLowerCase()) {
    case 'running': return 'badge-success';
    case 'error': return 'badge-danger';
    case 'stopping': return 'badge-warning';
    case 'stopped': return 'badge-muted';
    default: return 'badge-info';
  }
};
*/

const getStatusText = (status: string) => {
  switch (status.toLowerCase()) {
    case 'running': return '正在运行';
    case 'error': return '出错';
    case 'stopping': return '正在停止';
    case 'stopped': return '已停止';
    case 'initialized': return '已初始化';
    default: return status;
  }
};

/*
const getDirectionLabel = (config: Record<string, any>) => {
  return config.direction === 'reverse' ? '正向WS' : '反向WS';
};
*/

const getPlatformLogoUrl = (adapter: Adapter): string => {
  const key = `${adapter.id} ${adapter.type}`.toLowerCase();
  if (key.includes('aiocqhttp') || key.includes('onebot')) return '/platform_logos/onebot.png';
  if (key.includes('qqofficial') || key.includes('qq_official') || key.includes('qq')) return '/platform_logos/qq.png';
  if (key.includes('weixin_oc') || key.includes('wechat') || key.includes('wx') || key.includes('weixin')) return '/platform_logos/wechat.png';
  if (key.includes('wecom')) return '/platform_logos/wecom.png';
  if (key.includes('lark')) return '/platform_logos/lark.png';
  if (key.includes('dingtalk')) return '/platform_logos/dingtalk.svg';
  if (key.includes('telegram') || key.includes('tg')) return '/platform_logos/telegram.svg';
  if (key.includes('discord')) return '/platform_logos/discord.svg';
  if (key.includes('slack')) return '/platform_logos/slack.svg';
  if (key.includes('kook')) return '/platform_logos/kook.png';
  if (key.includes('vocechat')) return '/platform_logos/vocechat.png';
  if (key.includes('satori')) return '/platform_logos/satori.png';
  if (key.includes('misskey')) return '/platform_logos/misskey.png';
  if (key.includes('line')) return '/platform_logos/line.png';
  if (key.includes('matrix')) return '/platform_logos/matrix.svg';
  if (key.includes('mattermost')) return '/platform_logos/mattermost.svg';
  return '/platform_logos/onebot.png'; // 默认
};

const fetchQrLoginStatus = async (adapterId: string) => {
  try {
    const res = await fetch(`/api/adapters/${encodeURIComponent(adapterId)}/qrcode`);
    if (res.ok) {
      const data = await res.json();
      qrLoginStatuses.value[adapterId] = data;
      // Render QR code image from URL string using qrcode library
      const url = data.qrImgContent || '';
      if (url && !data.loggedIn) {
        qrCardImages.value[adapterId] = await QRCode.toDataURL(url, {
          margin: 2,
          width: 160,
          errorCorrectionLevel: 'M',
        });
      } else {
        delete qrCardImages.value[adapterId];
      }
    }
  } catch { /* ignore */ }
};

/*
const pollQrStatuses = async () => {
  for (const adapter of adapters.value) {
    if (adapter.type === 'weixin_oc') {
      await fetchQrLoginStatus(adapter.id);
    }
  }
};
*/

onMounted(() => {
  fetchAdapters();
});

onUnmounted(() => {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
  stopWxPostCreatePolling();
});
</script>

<template>
  <div>
    <div class="panel-container animate-fade-in">
      <div class="panel-header">
        <div class="header-info">
          <h2>消息平台</h2>
          <p class="subtitle">管理和配置各种外部接入平台，通过适配器管道与智能 Agent 交互</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-secondary btn-icon" @click="fetchAdapters" :disabled="isLoading">
            <RefreshCw :class="{ 'animate-spin': isLoading }" class="btn-icon-svg" />
          </button>
          <button class="btn btn-primary" @click="openAddModal">
            <Plus class="btn-icon-svg" />
            接入平台
          </button>
        </div>
      </div>

      <!-- Error Alert -->
      <div v-if="errorMsg" class="error-banner">
        <AlertCircle class="error-icon" />
        <span>{{ errorMsg }}</span>
      </div>

      <!-- Empty State -->
      <div v-if="adapters.length === 0 && !isLoading" class="empty-state">
        <MessageSquare class="empty-icon" />
        <h3>暂未接入任何消息平台</h3>
        <p>点击上方"接入平台"按钮来配置 OneBot 11、QQ 官方 Bot 或其他接入通道。</p>
      </div>

      <!-- Grid of Platforms -->
      <div v-else class="platform-grid">
        <div v-for="adapter in adapters" :key="adapter.id" :class="['platform-card', { 'card-stopped': !adapter.isRunning }]">
          <!-- 标题行：名称 + Toggle开关 -->
          <div class="card-header">
            <span class="card-title" :title="adapter.id">{{ adapter.id }}</span>
            <label class="toggle-switch" :title="adapter.isRunning ? '停用' : '启用'">
              <input type="checkbox" :checked="adapter.isRunning" @change="toggleAdapter(adapter.id)" />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- 中间内容区 -->
          <div class="card-body">
            <span v-if="!adapter.isRunning" class="status-text">{{ getStatusText(adapter.status) }}</span>
          </div>

          <!-- 右下角背景图标 -->
          <img :src="getPlatformLogoUrl(adapter)" :alt="adapter.id" class="bg-logo" />

          <!-- 底部操作按钮 -->
          <div class="card-footer">
            <button class="btn-card-delete" @click="deleteAdapter(adapter.id)">删除</button>
            <button class="btn-card-edit" @click="openEditModal(adapter)">编辑</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add/Edit Platform Modal -->
    <Teleport to="body">
    <div v-if="showModal" class="modal-backdrop" @click="showModal = false">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h3>{{ isEditMode ? '编辑平台连接' : '接入新消息平台' }}</h3>
          <button class="close-btn" @click="showModal = false">
            <X class="close-icon" />
          </button>
        </div>
        
        <div class="modal-body">
          <div class="form-group">
            <label>平台适配器类型</label>
            <select v-model="modalAdapterType" class="form-select" :disabled="isEditMode">
              <option value="onebot11">OneBot 11</option>
              <option value="qqofficial">QQ官方Bot</option>
              <option value="weixin_oc">个人微信</option>
            </select>
          </div>

          <div v-if="!isEditMode" class="form-group">
            <label>实例唯一 ID (例如: qq-bot, telegram-main)</label>
            <input 
              type="text" 
              v-model="modalAdapterId" 
              placeholder="请输入英文字符实例ID" 
              class="form-input"
            />
          </div>

          <!-- OneBot11 Settings -->
          <div v-if="modalAdapterType === 'onebot11'" class="form-section">
            <h4>OneBot 11 参数配置</h4>
            
            <div class="form-group">
              <label>连接方向</label>
              <select v-model="ob11Direction" class="form-select">
                <option value="forward">反向WS (服务端)</option>
                <option value="reverse">正向WS (客户端)</option>
              </select>
            </div>

            <!-- Forward WS Settings -->
            <template v-if="ob11Direction === 'forward'">
              <div class="form-row">
                <div class="form-group flex-1">
                  <label>Host 绑定</label>
                  <input type="text" v-model="ob11Host" class="form-input" />
                </div>
                <div class="form-group flex-1">
                  <label>端口 Port</label>
                  <input type="number" v-model="ob11Port" class="form-input" />
                </div>
              </div>

              <div class="form-group">
                <label>WS 路径</label>
                <input type="text" v-model="ob11Path" class="form-input" />
              </div>
            </template>

            <!-- Reverse WS Settings -->
            <template v-if="ob11Direction === 'reverse'">
              <div class="form-group">
                <label>目标 WS 地址</label>
                <input type="text" v-model="ob11ReverseUrl" placeholder="ws://127.0.0.1:6700" class="form-input" />
              </div>

              <div class="form-group">
                <label>重连间隔 (毫秒)</label>
                <input type="number" v-model="ob11ReconnectInterval" class="form-input" />
              </div>
            </template>

            <div class="form-group">
              <label>鉴权 Token (可选)</label>
              <input 
                type="password" 
                v-model="ob11AccessToken" 
                placeholder="不填则不启用验证" 
                class="form-input"
              />
            </div>
          </div>

          <!-- QQ Official Bot Settings -->
          <div v-if="modalAdapterType === 'qqofficial'" class="form-section">
            <h4>QQ官方Bot参数配置</h4>

            <div class="form-group">
              <label>AppID</label>
              <input
                type="text"
                v-model="qqAppId"
                placeholder="QQ 机器人 AppID"
                class="form-input"
              />
            </div>

            <div class="form-group">
              <label>AppSecret</label>
              <input
                type="password"
                v-model="qqAppSecret"
                placeholder="QQ 机器人 AppSecret"
                class="form-input"
              />
            </div>

            <div class="form-group">
              <label>Intents 位掩码 (可选)</label>
              <input
                type="number"
                v-model.number="qqIntents"
                placeholder="留空自动计算 (默认: 群消息+C2C消息)"
                class="form-input"
              />
              <small style="color: var(--text-secondary); margin-top: 4px; display: block;">
                常用值: 群@消息=33554432, C2C消息=67108864, 群+C2C=100663296
              </small>
            </div>
          </div>

          <!-- Weixin OC Settings -->
          <div v-if="modalAdapterType === 'weixin_oc'" class="form-section">
            <h4>个人微信</h4>

            <!-- 编辑模式: 显示 Token 信息 -->
            <template v-if="isEditMode">
              <div class="wx-oc-token-info">
                <div class="token-field">
                  <label>Account ID</label>
                  <div class="token-value">{{ editingWxAccountId || '未登录' }}</div>
                </div>
                <div class="token-field">
                  <label>Bot Token</label>
                  <div class="token-value token-masked">{{ editingWxToken || '未获取' }}</div>
                </div>
                <div class="token-field">
                  <label>状态</label>
                  <div :class="['token-value', editingWxLoggedIn ? 'status-logged-in' : 'status-not-logged']">
                    {{ editingWxLoggedIn ? '已登录' : '未登录' }}
                  </div>
                </div>
                <p class="wx-oc-edit-hint">Token 在扫码登录后自动保存，无需手动配置。如需重新登录请删除此适配器后重新添加。</p>
              </div>
            </template>

            <!-- 新增创建模式: 提示文字 -->
            <template v-else-if="wxMode === 'create'">
              <p class="wx-oc-create-hint">
                点击「确认接入」后将自动创建适配器并生成二维码。<br/>
                请在弹出的扫码页面中使用手机微信完成登录。
              </p>
            </template>

            <!-- 创建后扫码模式: 显示适配器自身的二维码 -->
            <template v-else-if="wxMode === 'scanning'">
              <div class="wx-oc-modal-qr">
                <p class="wx-oc-hint-text">适配器已创建，请使用手机微信扫码登录</p>

                <!-- Loading -->
                <template v-if="!wxPostCreateQrImage && !wxPostCreateError">
                  <div class="qr-waiting">
                    <QrCode class="qr-waiting-icon" />
                    <span>正在获取二维码...</span>
                  </div>
                </template>

                <!-- Error -->
                <template v-else-if="wxPostCreateError">
                  <p class="wx-oc-error">{{ wxPostCreateError }}</p>
                </template>

                <!-- QR Code from adapter's own session -->
                <template v-else-if="wxPostCreateQrImage">
                  <img :src="wxPostCreateQrImage" alt="微信扫码登录" class="wx-modal-qr-img" />
                  <p v-if="wxPostCreateStatus === 'expired'" class="qr-expired-hint">
                    二维码已过期，正在刷新...
                  </p>
                  <button class="btn btn-secondary wx-qr-refresh-btn" @click="refreshWxPostCreateQr">
                    刷新二维码
                  </button>
                </template>
              </div>
            </template>

            <!-- 登录成功模式 -->
            <template v-else-if="wxMode === 'success'">
              <div class="wx-oc-success">
                <span class="success-icon">&#10003;</span>
                <p class="success-title">登录成功！</p>
                <div class="token-field">
                  <label>Account ID</label>
                  <div class="token-value">{{ wxPostCreateAccountId || '-' }}</div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <div class="modal-footer">
          <button
            v-if="modalAdapterType !== 'weixin_oc' || wxMode === 'create' || isEditMode"
            class="btn btn-secondary"
            @click="showModal = false; stopWxPostCreatePolling()"
          >取消</button>
          <button
            v-if="modalAdapterType === 'weixin_oc' && wxMode === 'scanning'"
            class="btn btn-secondary"
            @click="showModal = false; stopWxPostCreatePolling(); wxMode = 'create'"
          >取消</button>
          <button
            v-if="wxMode === 'create' && !isEditMode && modalAdapterType === 'weixin_oc'"
            class="btn btn-primary"
            @click="submitAdapter"
          >确认接入</button>
          <button
            v-else-if="(wxMode === 'scanning' || wxMode === 'success') && modalAdapterType === 'weixin_oc'"
            class="btn btn-primary"
            @click="showModal = false; stopWxPostCreatePolling(); resetForm()"
          >{{ wxMode === 'success' ? '完成' : '关闭' }}</button>
          <button
            v-else-if="isEditMode || modalAdapterType !== 'weixin_oc'"
            class="btn btn-primary"
            @click="submitAdapter"
          >{{ isEditMode ? '保存更改' : '确认接入' }}</button>
        </div>
      </div>
    </div>
    </Teleport>
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

/* Platform Grid */
.platform-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1.25rem;
}

/* 卡片主体 */
.platform-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 18px;
  padding: 4px 16px 16px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  position: relative;
  overflow: hidden;
  min-height: 220px;
  transition: background-color 0.16s ease, transform 0.3s ease;
}

.platform-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent-primary);
  box-shadow: var(--shadow-lg);
}

.platform-card.card-stopped {
  opacity: 0.6;
}

/* 标题行 */
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 4px 8px;
}

.card-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Toggle 开关 */
.toggle-switch {
  position: relative;
  width: 44px;
  height: 24px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background: #64748b;
  border-radius: 24px;
  transition: all 0.25s ease;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background: white;
  border-radius: 50%;
  transition: transform 0.25s ease;
}

.toggle-switch input:checked + .toggle-slider {
  background: var(--accent-primary);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(20px);
}

/* 中间内容区 */
.card-body {
  flex: 1;
  padding: 4px 0;
}

.status-text {
  color: var(--text-muted);
  font-size: 0.9rem;
}

/* 背景logo */
.bg-logo {
  position: absolute;
  bottom: 16px;
  right: 16px;
  opacity: 0.15;
  pointer-events: none;
  width: 100px;
  height: 100px;
  object-fit: contain;
}

/* 底部操作按钮 */
.card-footer {
  display: flex;
  gap: 0.5rem;
  margin-top: auto;
}

.btn-card-delete {
  padding: 0.4rem 1rem;
  border-radius: 9999px;
  font-size: 0.85rem;
  font-weight: 500;
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.5);
  color: #ef4444;
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-card-delete:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: #ef4444;
}

.btn-card-edit {
  padding: 0.4rem 1rem;
  border-radius: 9999px;
  font-size: 0.85rem;
  font-weight: 500;
  background: rgba(99, 102, 241, 0.15);
  border: none;
  color: var(--accent-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-card-edit:hover {
  background: rgba(99, 102, 241, 0.25);
}

/* Modals & Forms */
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
  max-width: 520px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: modalEnter 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
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
}

.close-icon {
  width: 20px;
  height: 20px;
}

.modal-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  max-height: 70vh;
  overflow-y: auto;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.form-group label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.form-input, .form-select {
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  color: var(--text-primary);
  font-size: 0.95rem;
  outline: none;
  transition: all 0.2s ease;
}

.form-input:disabled, .form-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

body.light-theme .form-input,
body.light-theme .form-select {
  color: #0F172A !important;
  background: #F1F5F9;
  border-color: rgba(15, 23, 42, 0.15);
}

.form-input:focus, .form-select:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}

.form-section {
  border-top: 1px dashed var(--border-color);
  margin-top: 0.5rem;
  padding-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-section h4 {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
}

.form-row {
  display: flex;
  gap: 1rem;
}

.flex-1 {
  flex: 1;
}

.modal-footer {
  padding: 1.25rem;
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
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

.btn-primary {
  background: var(--accent-primary);
  color: #fff;
}
.btn-primary:hover {
  background: var(--accent-primary-hover);
  transform: translateY(-1px);
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

/* QR Code Login Styles */
.qr-login-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0;
}

.qr-logged-in {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.qr-status-badge {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  border-radius: 9999px;
  font-size: 0.8rem;
  font-weight: 600;
}

.qr-status-success {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.qr-account-id {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.qr-code-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.qr-hint {
  font-size: 0.85rem;
  color: var(--text-secondary);
  text-align: center;
  margin: 0;
}

.qr-code-img {
  width: 160px;
  height: 160px;
  object-fit: contain;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: #fff;
}

.qr-expired-hint {
  font-size: 0.8rem;
  color: #f59e0b;
  margin: 0;
}

.qr-error-hint {
  font-size: 0.8rem;
  color: #ef4444;
  text-align: center;
}

.qr-waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.qr-waiting-icon {
  width: 40px;
  height: 40px;
  opacity: 0.5;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.7; }
}

/* Weixin OC Modal QR */
.wx-oc-modal-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 0;
}

.wx-oc-hint-text {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin: 0;
  text-align: center;
}

.wx-oc-error {
  color: #ef4444;
  font-size: 0.85rem;
  margin: 0;
  text-align: center;
}

.wx-modal-qr-img {
  width: 200px;
  height: 200px;
  object-fit: contain;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  background: #fff;
}

.wx-qr-refresh-btn {
  margin-top: 0.5rem;
  font-size: 0.82rem;
}

/* Weixin OC Token Info (Edit Mode) */
.wx-oc-token-info {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.token-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.token-field label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 500;
}

.token-value {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-family: monospace;
  background: var(--bg-secondary);
  color: var(--text-primary);
  word-break: break-all;
}

.token-masked {
  letter-spacing: 2px;
}

.status-logged-in {
  color: #22c55e;
  font-weight: 600;
}

.status-not-logged {
  color: #ef4444;
}

.wx-oc-edit-hint {
  margin-top: 0.5rem;
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  font-size: 0.82rem;
  color: var(--text-secondary);
  background: rgba(99, 102, 241, 0.08);
  border: 1px solid rgba(99, 102, 241, 0.15);
  line-height: 1.5;
}

/* Weixin OC Create Hint */
.wx-oc-create-hint {
  padding: 0.8rem 1rem;
  border-radius: 8px;
  font-size: 0.88rem;
  color: var(--text-secondary);
  background: rgba(99, 102, 241, 0.06);
  border: 1px dashed rgba(99, 102, 241, 0.2);
  line-height: 1.6;
}

/* Weixin OC Success State */
.wx-oc-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 1.5rem 0;
}

.success-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  font-size: 24px;
  color: #fff;
  background: #22c55e;
}

.success-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: #22c55e;
  margin: 0;
}
</style>
