import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApexOptions, ApexAxisChartSeries } from 'apexcharts'
import Chart from './chart'
import {
  Activity, MessageSquare, Cpu, HardDrive, Timer,
  RefreshCw, Bot, Sparkles, AlertCircle
} from 'lucide-react'
import { apiFetch } from '../lib/api'

type TokenRange = 1 | 3 | 7
type ChartSeries = ApexAxisChartSeries

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
  trend: { series: ProviderTrendItem[]; total_series: Array<[number, number]>; cached_trend: Array<[number, number]> }
  range_total_tokens: number
  range_total_calls: number
  range_avg_ttft_ms: number
  range_avg_duration_ms: number
  range_avg_tpm: number
  range_success_rate: number
  range_total_cached_tokens: number
  range_cache_hit_rate: number
  range_by_provider: ProviderRankingItem[]
  range_by_umo: UmoRankingItem[]
  today_total_tokens: number
  today_total_calls: number
  today_by_provider: ProviderRankingItem[]
}

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
  if (typeof running === 'number') {
    const totalSec = Math.floor(running)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    const parts = [h > 0 ? `${h}h` : '', m > 0 || h > 0 ? `${m}m` : '', `${s}s`].filter(Boolean)
    return parts.join(' ')
  }
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
    { name: '其他', data: mergedPoints, total_tokens: otherTotalTokens }
  ]
}

export default function Dashboard({ isLightMode }: { isLightMode: boolean }) {
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [baseStats, setBaseStats] = useState<BaseStatsResponse | null>(null)
  const [providerStats, setProviderStats] = useState<ProviderTokenStatsResponse | null>(null)
  const [selectedRange, setSelectedRange] = useState<TokenRange>(1)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const refreshTimerRef = useRef<number | null>(null)

  // Keep a ref to the latest `selectedRange` so the 30s interval callback
  // (which is captured once on mount) always reads the current value instead
  // of the stale closure from the initial render.
  const selectedRangeRef = useRef(selectedRange)
  selectedRangeRef.current = selectedRange

  // Theme is now received as a prop from App, so the chart re-renders
  // immediately when the user toggles light/dark mode.
  const isDark = !isLightMode

  async function fetchBaseStats(): Promise<void> {
    const range = selectedRangeRef.current
    const res = await apiFetch(`/api/stat/get?offset_sec=${range * 24 * 60 * 60}`)
    if (!res.ok) throw new Error('Failed to fetch base stats')
    const json = await res.json()
    setBaseStats(json.data)
  }

  async function fetchProviderStats(): Promise<void> {
    const range = selectedRangeRef.current
    const res = await apiFetch(`/api/stat/provider-tokens?days=${range}`)
    if (!res.ok) throw new Error('Failed to fetch provider stats')
    const json = await res.json()
    setProviderStats(json.data)
  }

  async function refreshStats(): Promise<void> {
    try {
      setErrorMessage('')
      await Promise.all([fetchBaseStats(), fetchProviderStats()])
      setLastUpdatedAt(new Date())
    } catch (error) {
      console.error('Failed to load stats page data:', error)
      setErrorMessage('加载数据失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  // Keep a ref to `refreshStats` so the interval always calls the latest
  // version without needing to re-create the interval on every render.
  const refreshStatsRef = useRef(refreshStats)
  refreshStatsRef.current = refreshStats

  // Initial mount + auto-refresh every 30s
  useEffect(() => {
    void refreshStatsRef.current()
    refreshTimerRef.current = window.setInterval(() => { void refreshStatsRef.current() }, 30_000)
    return () => {
      if (refreshTimerRef.current) window.clearInterval(refreshTimerRef.current)
    }
  }, [])

  // Range switch — re-fetch immediately when the user changes the range
  useEffect(() => {
    if (baseStats === null) return // skip on initial mount
    Promise.all([fetchBaseStats(), fetchProviderStats()])
      .then(() => setLastUpdatedAt(new Date()))
      .catch((error) => {
        console.error('Failed to refresh stats range:', error)
        setErrorMessage('切换时间范围失败')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRange])

  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdatedAt) return '未更新'
    return lastUpdatedAt.toLocaleTimeString('zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    })
  }, [lastUpdatedAt])

  const rangeLabel = useMemo(() => {
    if (selectedRange === 3) return '3 天'
    if (selectedRange === 7) return '1 周'
    return '1 天'
  }, [selectedRange])

  const overviewCards = useMemo(() => [
    { label: '消息平台实例数', value: formatNumber(baseStats?.platform_count ?? 0), note: '已连接的消息平台实例', icon: 'bot' as const },
    { label: '消息总数', value: formatNumber(baseStats?.message_count ?? 0), note: '接收到的消息总量', icon: 'message' as const },
    { label: '今日模型调用', value: formatCompactNumber(providerStats?.today_total_calls ?? 0), note: `Token 消耗: ${formatCompactNumber(providerStats?.today_total_tokens ?? 0)}`, icon: 'sparkles' as const },
    { label: 'CPU', value: `${baseStats?.cpu_percent ?? 0}%`, note: '当前处理器使用率', icon: 'cpu' as const },
    { label: '进程内存', value: formatMemory(baseStats?.memory?.process ?? 0), note: `系统内存: ${formatMemory(baseStats?.memory?.system ?? 0)}`, icon: 'memory' as const },
    { label: '运行时间', value: formatRunningTime(baseStats?.running), note: `启动于 ${formatDateTime(baseStats?.start_time ?? 0)}`, icon: 'timer' as const },
  ], [baseStats, providerStats])

  const providerTrendSeries = useMemo<ChartSeries>(() => {
    const modelSeries = aggregateOverflowSeries(providerStats?.trend.series ?? []).map((item) => ({
      name: item.name,
      data: item.data
    }))
    const cachedTrend = providerStats?.trend.cached_trend ?? []
    if (cachedTrend.length > 0) {
      return [
        ...modelSeries,
        { name: '缓存命中 Token', data: cachedTrend }
      ]
    }
    return modelSeries
  }, [providerStats])

  const hasCacheLine = (providerStats?.trend.cached_trend?.length ?? 0) > 0

  const rangeProviderRanking = providerStats?.range_by_provider ?? []

  const rangeAvgTtftLabel = formatDurationMs(providerStats?.range_avg_ttft_ms ?? 0)
  const rangeAvgDurationLabel = formatDurationMs(providerStats?.range_avg_duration_ms ?? 0)
  const rangeAvgTpmLabel = formatTpm(providerStats?.range_avg_tpm ?? 0)
  const rangeSuccessRateLabel = (() => {
    if (!(providerStats?.range_total_calls ?? 0)) return '—'
    const rate = providerStats?.range_success_rate ?? 0
    return `${(rate * 100).toFixed(1)}%`
  })()
  const rangeCachedTokensLabel = formatCompactNumber(providerStats?.range_total_cached_tokens ?? 0)
  const rangeCacheHitRateLabel = (() => {
    const rate = providerStats?.range_cache_hit_rate ?? 0
    if (rate <= 0) return '—'
    return `${(rate * 100).toFixed(1)}%`
  })()

  const cacheLineColor = isDark ? '#22D3EE' : '#06B6D4'
  const chartColors = isDark
    ? ['#6F8FAF', '#7E9A73', '#A78468', '#8A78A8', '#6B9995', '#B07A87', '#8C8F62', '#7C8798', cacheLineColor]
    : ['#5F7E9B', '#708865', '#9A7557', '#786696', '#5D8985', '#9C6674', '#80844F', '#69788D', cacheLineColor]

  const chartTextColor = isDark ? '#A1A1AA' : '#64748B'
  const chartBorderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)'

  const providerChartOptions: ApexOptions = useMemo(() => {
    const modelCount = providerTrendSeries.length - (hasCacheLine ? 1 : 0)
    // 模型系列用实线，缓存命中系列用虚线突出显示
    const strokeDash = hasCacheLine
      ? [...Array(modelCount).fill(0), 6]
      : Array(providerTrendSeries.length).fill(0)
    const strokeWidth = hasCacheLine
      ? [...Array(modelCount).fill(2), 3]
      : Array(providerTrendSeries.length).fill(2)
    return {
      chart: {
        background: 'transparent',
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif'
      },
      theme: { mode: isDark ? 'dark' : 'light' },
      colors: chartColors,
      stroke: {
        curve: 'smooth',
        width: strokeWidth,
        dash: strokeDash
      },
      markers: {
        size: 0,
        hover: { size: 4 }
      },
      dataLabels: { enabled: false },
      grid: { borderColor: chartBorderColor },
      xaxis: {
        type: 'datetime',
        labels: { datetimeUTC: false, style: { colors: chartTextColor } },
        axisBorder: { color: chartBorderColor },
        axisTicks: { color: chartBorderColor }
      },
      yaxis: {
        labels: {
          formatter: (value) => formatCompactNumber(Number(value)),
          style: { colors: chartTextColor }
        }
      },
      tooltip: { theme: isDark ? 'dark' : 'light', x: { format: 'MM/dd HH:mm' } },
      legend: {
        position: 'top',
        horizontalAlign: 'left',
        labels: { colors: chartTextColor }
      }
    }
  }, [isDark, chartColors, chartTextColor, chartBorderColor, providerTrendSeries, hasCacheLine])

  const renderCardIcon = (icon: string) => {
    switch (icon) {
      case 'bot': return <Bot size={18} />
      case 'message': return <MessageSquare size={18} />
      case 'sparkles': return <Sparkles size={18} />
      case 'cpu': return <Cpu size={18} />
      case 'memory': return <HardDrive size={18} />
      case 'timer': return <Timer size={18} />
      default: return <Activity size={18} />
    }
  }

  return (
    <div className="stats-page animate-fade-in">
      <div className="stats-shell">
        <div className="stats-header">
          <div>
            <h1 className="stats-title">仪表盘</h1>
            <p className="stats-subtitle">实时监控平台运行状态、消息流量与模型调用趋势</p>
          </div>
          <div className="header-meta">
            <div className="range-selector">
              {([1, 3, 7] as TokenRange[]).map(r => (
                <button
                  key={r}
                  className={`range-btn${selectedRange === r ? ' active' : ''}`}
                  onClick={() => setSelectedRange(r)}
                >
                  {r === 7 ? '1 周' : `${r} 天`}
                </button>
              ))}
            </div>
            <div className="meta-pill">
              <RefreshCw size={14} />
              <span>{lastUpdatedLabel}</span>
            </div>
          </div>
        </div>

        {errorMessage && (
          <div className="error-alert">
            <AlertCircle size={16} />
            <span>{errorMessage}</span>
          </div>
        )}

        {loading && !baseStats ? (
          <div className="loading-wrap">
            <div className="spinner"></div>
          </div>
        ) : (
          <>
            <div className="overview-grid">
              {overviewCards.map((card) => (
                <section key={card.label} className="stat-card overview-card">
                  <div className="card-icon">{renderCardIcon(card.icon)}</div>
                  <div className="card-label">{card.label}</div>
                  <div className="card-value">{card.value}</div>
                  <div className="card-note">{card.note}</div>
                </section>
              ))}
            </div>

            <div className="token-section-head">
              <div>
                <div className="section-title">模型调用</div>
                <div className="section-subtitle">模型 Token 使用与缓存指标</div>
              </div>
            </div>

            <div className="token-grid">
              <section className="stat-card chart-card chart-card-wide provider-trend-card">
                <div className="card-head">
                  <div>
                    <div className="section-title">模型调用趋势</div>
                    <div className="section-subtitle">各模型 Token 消耗与缓存命中趋势（虚线为缓存命中）</div>
                  </div>
                </div>
                <Chart type="line" height={420} options={providerChartOptions} series={providerTrendSeries} />
              </section>

              <section className="token-side-column">
                <section className="stat-card token-total-card">
                  <div className="card-label">近 {rangeLabel} Token 总量</div>
                  <div className="token-total-value">
                    {formatNumber(providerStats?.range_total_tokens ?? 0)}
                    <span style={{ fontSize: '18px' }}>Tokens</span>
                  </div>
                  <div className="card-note">调用次数: {formatNumber(providerStats?.range_total_calls ?? 0)}</div>
                  <div className="token-meta-list">
                    <div className="token-meta-item"><span>平均 TTFT</span><strong>{rangeAvgTtftLabel}</strong></div>
                    <div className="token-meta-item"><span>平均响应时间</span><strong>{rangeAvgDurationLabel}</strong></div>
                    <div className="token-meta-item"><span>平均 TPM</span><strong>{rangeAvgTpmLabel}</strong></div>
                    <div className="token-meta-item"><span>缓存命中 Token</span><strong>{rangeCachedTokensLabel}</strong></div>
                    <div className="token-meta-item"><span>缓存命中率</span><strong>{rangeCacheHitRateLabel}</strong></div>
                    <div className="token-meta-item"><span>成功率</span><strong>{rangeSuccessRateLabel}</strong></div>
                  </div>
                </section>

                <section className="stat-card provider-list-card">
                  <div className="card-head compact">
                    <div>
                      <div className="section-title">模型排名 ({rangeLabel})</div>
                      <div className="section-subtitle">按 Token 消耗排名</div>
                    </div>
                  </div>
                  {rangeProviderRanking.length ? (
                    <div className="provider-list provider-list--scrollable">
                      {rangeProviderRanking.map((provider) => (
                        <div key={provider.model} className="provider-row">
                          <span className="provider-name">{provider.model}</span>
                          <strong>{formatNumber(provider.tokens)}</strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">近 {rangeLabel} 无模型调用数据</div>
                  )}
                </section>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
