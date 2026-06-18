<script setup lang="ts">
import type { ApexOptions } from 'apexcharts'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import VueApexCharts from 'vue3-apexcharts'
import {
  Activity, MessageSquare, Cpu, HardDrive, Timer,
  RefreshCw, Bot, Sparkles, AlertCircle
} from 'lucide-vue-next'

type TokenRange = 1 | 3 | 7
type ChartSeries = Array<{ name: string; data: unknown[] }>

interface RunningStats {
  hours: number
  minutes: number
  seconds: number
}

interface BaseStatsResponse {
  message_count: number
  platform_count: number
  platform: Array<{ name: string; count: number; timestamp: number }>
  message_time_series: Array<[number, number]>
  memory: { process: number; system: number }
  cpu_percent: number
  running: RunningStats
  thread_count: number
  start_time: number
}

interface ProviderTrendItem {
  name: string
  data: Array<[number, number]>
  total_tokens: number
}

interface ProviderRankingItem {
  model: string
  tokens: number
}

interface UmoRankingItem {
  umo: string
  tokens: number
}

interface ProviderTokenStatsResponse {
  days: TokenRange
  trend: { series: ProviderTrendItem[]; total_series: Array<[number, number]> }
  range_total_tokens: number
  range_total_calls: number
  range_avg_ttft_ms: number
  range_avg_duration_ms: number
  range_avg_tpm: number
  range_success_rate: number
  range_by_provider: ProviderRankingItem[]
  range_by_umo: UmoRankingItem[]
  today_total_tokens: number
  today_total_calls: number
  today_by_provider: ProviderRankingItem[]
}

const loading = ref(true)
const errorMessage = ref('')
const baseStats = ref<BaseStatsResponse | null>(null)
const providerStats = ref<ProviderTokenStatsResponse | null>(null)
const selectedRange = ref<TokenRange>(1)
const lastUpdatedAt = ref<Date | null>(null)

const isDark = computed(() => !document.body.classList.contains('light-theme'))

let refreshTimer: number | null = null

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  return formatNumber(value)
}

function formatMemory(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

function formatDurationMs(value: number): string {
  if (!value || value <= 0) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(2)} s`
}

function formatTpm(value: number): string {
  if (!value || value <= 0) return '—'
  return `${value.toFixed(0)} TPM`
}

function formatDateTime(timestampSec: number): string {
  if (!timestampSec) return '—'
  return new Date(timestampSec * 1000).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
}

function formatRunningTime(running?: RunningStats | number | null): string {
  if (!running) return '—'
  // 后端返回的是秒数
  if (typeof running === 'number') {
    const totalSec = Math.floor(running)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    const parts = [h > 0 ? `${h}h` : '', m > 0 || h > 0 ? `${m}m` : '', `${s}s`].filter(Boolean)
    return parts.join(' ')
  }
  // 对象格式兼容
  const parts = [
    running.hours > 0 ? `${running.hours}h` : '',
    running.minutes > 0 || running.hours > 0 ? `${running.minutes}m` : '',
    `${running.seconds ?? 0}s`
  ].filter(Boolean)
  return parts.join(' ')
}

function aggregateOverflowSeries(series: ProviderTrendItem[]): ProviderTrendItem[] {
  if (series.length <= 5) return series
  const leading = series.slice(0, 4)
  const overflow = series.slice(4)
  const mergedPoints = overflow[0].data.map(([timestamp], index) => {
    const total = overflow.reduce((sum, item) => sum + (item.data[index]?.[1] ?? 0), 0)
    return [timestamp, total] as [number, number]
  })
  const otherTotalTokens = overflow.reduce((sum, item) => {
    return sum + item.data.reduce((s, [, v]) => s + v, 0)
  }, 0)
  return [
    ...leading,
    {
      name: '其他',
      data: mergedPoints,
      total_tokens: otherTotalTokens
    }
  ]
}

async function fetchBaseStats(): Promise<void> {
  const res = await fetch(`/api/stat/get?offset_sec=${selectedRange.value * 24 * 60 * 60}`)
  if (!res.ok) throw new Error('Failed to fetch base stats')
  const json = await res.json()
  baseStats.value = json.data
}

async function fetchProviderStats(): Promise<void> {
  const res = await fetch(`/api/stat/provider-tokens?days=${selectedRange.value}`)
  if (!res.ok) throw new Error('Failed to fetch provider stats')
  const json = await res.json()
  providerStats.value = json.data
}

async function refreshStats(): Promise<void> {
  try {
    errorMessage.value = ''
    await Promise.all([fetchBaseStats(), fetchProviderStats()])
    lastUpdatedAt.value = new Date()
  } catch (error) {
    console.error('Failed to load stats page data:', error)
    errorMessage.value = '加载数据失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

const lastUpdatedLabel = computed(() => {
  if (!lastUpdatedAt.value) return '未更新'
  return lastUpdatedAt.value.toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
})

const rangeLabel = computed(() => {
  if (selectedRange.value === 3) return '3 天'
  if (selectedRange.value === 7) return '1 周'
  return '1 天'
})

const overviewCards = computed(() => [
  {
    label: '消息平台实例数',
    value: formatNumber(baseStats.value?.platform_count ?? 0),
    note: '已连接的消息平台实例',
    icon: 'bot'
  },
  {
    label: '消息总数',
    value: formatNumber(baseStats.value?.message_count ?? 0),
    note: '接收到的消息总量',
    icon: 'message'
  },
  {
    label: '今日模型调用',
    value: formatCompactNumber(providerStats.value?.today_total_calls ?? 0),
    note: `Token 消耗: ${formatCompactNumber(providerStats.value?.today_total_tokens ?? 0)}`,
    icon: 'sparkles'
  },
  {
    label: 'CPU',
    value: `${baseStats.value?.cpu_percent ?? 0}%`,
    note: '当前处理器使用率',
    icon: 'cpu'
  },
  {
    label: '进程内存',
    value: formatMemory(baseStats.value?.memory?.process ?? 0),
    note: `系统内存: ${formatMemory(baseStats.value?.memory?.system ?? 0)}`,
    icon: 'memory'
  },
  {
    label: '运行时间',
    value: formatRunningTime(baseStats.value?.running),
    note: `启动于 ${formatDateTime(baseStats.value?.start_time ?? 0)}`,
    icon: 'timer'
  }
])

const providerTrendSeries = computed<ChartSeries>(() =>
  aggregateOverflowSeries(providerStats.value?.trend.series ?? []).map((item) => ({
    name: item.name,
    data: item.data
  }))
)

const rangeProviderRanking = computed(() => providerStats.value?.range_by_provider ?? [])

const rangeAvgTtftLabel = computed(() => formatDurationMs(providerStats.value?.range_avg_ttft_ms ?? 0))
const rangeAvgDurationLabel = computed(() => formatDurationMs(providerStats.value?.range_avg_duration_ms ?? 0))
const rangeAvgTpmLabel = computed(() => formatTpm(providerStats.value?.range_avg_tpm ?? 0))
const rangeSuccessRateLabel = computed(() => {
  if (!(providerStats.value?.range_total_calls ?? 0)) return '—'
  const rate = providerStats.value?.range_success_rate ?? 0
  return `${(rate * 100).toFixed(1)}%`
})

const chartColors = computed(() =>
  isDark.value
    ? ['#6F8FAF', '#7E9A73', '#A78468', '#8A78A8', '#6B9995', '#B07A87', '#8C8F62', '#7C8798']
    : ['#5F7E9B', '#708865', '#9A7557', '#786696', '#5D8985', '#9C6674', '#80844F', '#69788D']
)

const chartTextColor = computed(() => isDark.value ? '#A1A1AA' : '#64748B')
const chartBorderColor = computed(() => isDark.value ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)')

const providerChartOptions = computed<ApexOptions>(() => ({
  chart: {
    background: 'transparent',
    toolbar: { show: false },
    zoom: { enabled: false },
    stacked: true,
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif'
  },
  theme: { mode: isDark.value ? 'dark' : 'light' },
  plotOptions: { bar: { horizontal: false, borderRadius: 4, columnWidth: '58%' } },
  colors: chartColors.value,
  dataLabels: { enabled: false },
  grid: { borderColor: chartBorderColor.value },
  xaxis: {
    type: 'datetime',
    labels: { datetimeUTC: false, style: { colors: chartTextColor.value } },
    axisBorder: { color: chartBorderColor.value },
    axisTicks: { color: chartBorderColor.value }
  },
  yaxis: {
    labels: {
      formatter: (value) => formatCompactNumber(Number(value)),
      style: { colors: chartTextColor.value }
    }
  },
  tooltip: { theme: isDark.value ? 'dark' : 'light', x: { format: 'MM/dd HH:mm' } },
  legend: {
    position: 'top',
    horizontalAlign: 'left',
    labels: { colors: chartTextColor.value }
  }
}))

watch(selectedRange, async () => {
  try {
    await Promise.all([fetchBaseStats(), fetchProviderStats()])
    lastUpdatedAt.value = new Date()
  } catch (error) {
    console.error('Failed to refresh stats range:', error)
    errorMessage.value = '切换时间范围失败'
  }
})

onMounted(async () => {
  await refreshStats()
  refreshTimer = window.setInterval(() => { void refreshStats() }, 30_000)
})

onBeforeUnmount(() => {
  if (refreshTimer !== null) window.clearInterval(refreshTimer)
})
</script>

<template>
  <div class="stats-page animate-fade-in">
    <div class="stats-shell">
      <!-- Header -->
      <div class="stats-header">
        <div>
          <h1 class="stats-title">仪表盘</h1>
          <p class="stats-subtitle">平台、消息与模型调用的统一视图</p>
        </div>
        <div class="header-meta">
          <div class="meta-pill">
            <RefreshCw :size="14" />
            <span>{{ lastUpdatedLabel }}</span>
          </div>
        </div>
      </div>

      <!-- Error -->
      <div v-if="errorMessage" class="error-alert">
        <AlertCircle :size="16" />
        <span>{{ errorMessage }}</span>
      </div>

      <!-- Loading -->
      <div v-if="loading && !baseStats" class="loading-wrap">
        <div class="spinner"></div>
      </div>

      <template v-else>
        <!-- Overview Cards -->
        <div class="overview-grid">
          <section v-for="card in overviewCards" :key="card.label" class="stat-card overview-card">
            <div class="card-icon">
              <Bot v-if="card.icon === 'bot'" :size="18" />
              <MessageSquare v-else-if="card.icon === 'message'" :size="18" />
              <Sparkles v-else-if="card.icon === 'sparkles'" :size="18" />
              <Cpu v-else-if="card.icon === 'cpu'" :size="18" />
              <HardDrive v-else-if="card.icon === 'memory'" :size="18" />
              <Timer v-else-if="card.icon === 'timer'" :size="18" />
              <Activity v-else :size="18" />
            </div>
            <div class="card-label">{{ card.label }}</div>
            <div class="card-value">{{ card.value }}</div>
            <div class="card-note">{{ card.note }}</div>
          </section>
        </div>

        <!-- Model Calls Section -->
        <div class="token-section-head">
          <div>
            <div class="section-title">模型调用</div>
            <div class="section-subtitle">模型 Token 消耗与调用指标</div>
          </div>
        </div>

        <div class="token-grid">
          <!-- Provider Trend Chart -->
          <section class="stat-card chart-card chart-card-wide provider-trend-card">
            <div class="card-head">
              <div>
                <div class="section-title">模型调用趋势</div>
                <div class="section-subtitle">各模型 Token 消耗随时间变化</div>
              </div>
            </div>
            <VueApexCharts type="bar" height="420" :options="providerChartOptions" :series="providerTrendSeries" />
          </section>

          <section class="token-side-column">
            <!-- Token Total Card -->
            <section class="stat-card token-total-card">
              <div class="card-label">近 {{ rangeLabel }} Token 总量</div>
              <div class="token-total-value">
                {{ formatNumber(providerStats?.range_total_tokens ?? 0) }}
                <span style="font-size: 18px;">Tokens</span>
              </div>
              <div class="card-note">调用次数: {{ formatNumber(providerStats?.range_total_calls ?? 0) }}</div>
              <div class="token-meta-list">
                <div class="token-meta-item">
                  <span>平均 TTFT</span>
                  <strong>{{ rangeAvgTtftLabel }}</strong>
                </div>
                <div class="token-meta-item">
                  <span>平均响应时间</span>
                  <strong>{{ rangeAvgDurationLabel }}</strong>
                </div>
                <div class="token-meta-item">
                  <span>平均 TPM</span>
                  <strong>{{ rangeAvgTpmLabel }}</strong>
                </div>
                <div class="token-meta-item">
                  <span>成功率</span>
                  <strong>{{ rangeSuccessRateLabel }}</strong>
                </div>
              </div>
            </section>

            <!-- Model Ranking -->
            <section class="stat-card provider-list-card">
              <div class="card-head compact">
                <div>
                  <div class="section-title">模型排名 ({{ rangeLabel }})</div>
                  <div class="section-subtitle">按 Token 消耗排名</div>
                </div>
              </div>
              <div v-if="rangeProviderRanking.length" class="provider-list provider-list--scrollable">
                <div v-for="provider in rangeProviderRanking" :key="provider.model" class="provider-row">
                  <span class="provider-name">{{ provider.model }}</span>
                  <strong>{{ formatNumber(provider.tokens) }}</strong>
                </div>
              </div>
              <div v-else class="empty-state">近 {{ rangeLabel }} 无模型调用数据</div>
            </section>
          </section>
        </div>

      </template>
    </div>
  </div>
</template>

<style scoped>
.stats-page {
  min-height: 100%;
}

.stats-shell {
  max-width: 1600px;
  margin: 0 auto;
  color: var(--text-primary);
}

.stats-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 24px;
  margin-bottom: 24px;
}

.stats-title {
  margin: 0;
  font-size: 1.5rem;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: 0;
}

.stats-subtitle {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.header-meta {
  display: flex;
  gap: 12px;
}

.meta-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-card);
  color: var(--text-muted);
  font-size: 13px;
}

.error-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.2);
  color: var(--accent-danger);
  font-size: 14px;
  margin-bottom: 16px;
}

.loading-wrap {
  display: flex;
  justify-content: center;
  padding: 80px 0;
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

.overview-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.panel-grid,
.token-grid {
  display: grid;
  grid-template-columns: 1.6fr 0.9fr;
  gap: 20px;
  margin-bottom: 20px;
  align-items: stretch;
}

.panel-grid > *,
.token-grid > * {
  min-width: 0;
  width: 100%;
}

.token-side-column {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 20px;
  min-width: 0;
  width: 100%;
}

.token-side-column > * {
  min-width: 0;
}

.stat-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-card);
  backdrop-filter: var(--glass-blur);
}

.overview-card {
  padding: 20px 20px 18px;
}

.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 12px;
  background: rgba(99, 102, 241, 0.08);
  color: var(--accent-primary);
}

body.light-theme .card-icon {
  background: rgba(99, 102, 241, 0.1);
}

.card-label {
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
}

.card-value {
  margin-top: 8px;
  font-size: clamp(24px, 2vw, 34px);
  line-height: 1.1;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.card-note {
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.chart-card,
.provider-list-card,
.token-total-card {
  padding: 22px;
}

.card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  margin-bottom: 18px;
}

.section-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-end;
  margin-bottom: 16px;
}

.section-toolbar .section-subtitle {
  max-width: 680px;
}

.card-head-actions {
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 14px;
  flex-wrap: wrap;
}

.card-head.compact {
  margin-bottom: 14px;
}

.section-title {
  font-size: 19px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.section-subtitle {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 13px;
}

.section-metric {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.metric-label {
  color: var(--text-muted);
  font-size: 12px;
}

.metric-value {
  font-size: 22px;
  font-weight: 650;
}

.token-section-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 16px;
}

.range-switch {
  display: inline-flex;
  gap: 8px;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-card);
}

.range-chip {
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.18s ease, color 0.18s ease;
}

.range-chip.active {
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent-primary);
}

.token-total-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 170px;
  width: 100%;
}

.provider-trend-card {
  min-height: 520px;
}

.provider-list-card {
  width: 100%;
}

.token-total-value {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: clamp(32px, 3vw, 44px);
  line-height: 1.02;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.token-meta-list {
  margin-top: 18px;
  border-top: 1px solid var(--border-color);
  padding-top: 14px;
  display: grid;
  gap: 10px;
}

.token-meta-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  color: var(--text-muted);
  font-size: 14px;
}

.provider-list {
  display: grid;
  gap: 12px;
}

.provider-list--scrollable {
  max-height: 296px;
  overflow-y: auto;
  padding-right: 6px;
}

.provider-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
  font-size: 14px;
}

.provider-row:last-child {
  border-bottom: 0;
}

.provider-name {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.token-total-card .card-label,
.token-total-card .card-note,
.token-side-column .section-subtitle {
  overflow-wrap: anywhere;
}

.empty-state {
  color: var(--text-muted);
  font-size: 14px;
}

@media (max-width: 1400px) {
  .overview-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 1080px) {
  .panel-grid,
  .token-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stats-header,
  .token-section-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .section-toolbar {
    justify-content: flex-start;
    align-items: flex-start;
    flex-direction: column;
  }

  .card-head,
  .card-head-actions {
    flex-direction: column;
    align-items: flex-start;
  }
}

@media (max-width: 640px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }

  .chart-card,
  .provider-list-card,
  .token-total-card {
    padding: 18px;
    border-radius: 14px;
  }
}
</style>
