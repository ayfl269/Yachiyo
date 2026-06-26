import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApexOptions, ApexAxisChartSeries } from 'apexcharts'
import Chart from './chart'
import {
  Activity, MessageSquare, Cpu, HardDrive, Timer,
  RefreshCw, Bot, Sparkles, AlertCircle
} from 'lucide-react'

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

export default function Dashboard() {
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [baseStats, setBaseStats] = useState<BaseStatsResponse | null>(null)
  const [providerStats, setProviderStats] = useState<ProviderTokenStatsResponse | null>(null)
  const [selectedRange, setSelectedRange] = useState<TokenRange>(1)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const refreshTimerRef = useRef<number | null>(null)

  const isDark = useMemo(() => !document.body.classList.contains('light-theme'), [lastUpdatedAt])

  async function fetchBaseStats(): Promise<void> {
    const res = await fetch(`/api/stat/get?offset_sec=${selectedRange * 24 * 60 * 60}`)
    if (!res.ok) throw new Error('Failed to fetch base stats')
    const json = await res.json()
    setBaseStats(json.data)
  }

  async function fetchProviderStats(): Promise<void> {
    const res = await fetch(`/api/stat/provider-tokens?days=${selectedRange}`)
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

  // Initial mount + auto-refresh every 30s
  useEffect(() => {
    void refreshStats()
    refreshTimerRef.current = window.setInterval(() => { void refreshStats() }, 30_000)
    return () => {
      if (refreshTimerRef.current) window.clearInterval(refreshTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Range switch
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

  const providerTrendSeries = useMemo<ChartSeries>(() =>
    aggregateOverflowSeries(providerStats?.trend.series ?? []).map((item) => ({
      name: item.name,
      data: item.data
    }))
  , [providerStats])

  const rangeProviderRanking = providerStats?.range_by_provider ?? []

  const rangeAvgTtftLabel = formatDurationMs(providerStats?.range_avg_ttft_ms ?? 0)
  const rangeAvgDurationLabel = formatDurationMs(providerStats?.range_avg_duration_ms ?? 0)
  const rangeAvgTpmLabel = formatTpm(providerStats?.range_avg_tpm ?? 0)
  const rangeSuccessRateLabel = (() => {
    if (!(providerStats?.range_total_calls ?? 0)) return '—'
    const rate = providerStats?.range_success_rate ?? 0
    return `${(rate * 100).toFixed(1)}%`
  })()

  const chartColors = isDark
    ? ['#6F8FAF', '#7E9A73', '#A78468', '#8A78A8', '#6B9995', '#B07A87', '#8C8F62', '#7C8798']
    : ['#5F7E9B', '#708865', '#9A7557', '#786696', '#5D8985', '#9C6674', '#80844F', '#69788D']

  const chartTextColor = isDark ? '#A1A1AA' : '#64748B'
  const chartBorderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)'

  const providerChartOptions: ApexOptions = useMemo(() => ({
    chart: {
      background: 'transparent',
      toolbar: { show: false },
      zoom: { enabled: false },
      stacked: true,
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif'
    },
    theme: { mode: isDark ? 'dark' : 'light' },
    plotOptions: { bar: { horizontal: false, borderRadius: 4, columnWidth: '58%' } },
    colors: chartColors,
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
  }), [isDark, chartColors, chartTextColor, chartBorderColor])

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
            <p className="stats-subtitle">平台、消息与模型调用的统一视图</p>
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
                <div className="section-subtitle">模型 Token 消耗与调用指标</div>
              </div>
            </div>

            <div className="token-grid">
              <section className="stat-card chart-card chart-card-wide provider-trend-card">
                <div className="card-head">
                  <div>
                    <div className="section-title">模型调用趋势</div>
                    <div className="section-subtitle">各模型 Token 消耗随时间变化</div>
                  </div>
                </div>
                <Chart type="bar" height={420} options={providerChartOptions} series={providerTrendSeries} />
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
