import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MessageSquare,
  Plus,
  AlertCircle,
  RefreshCw,
  QrCode,
} from 'lucide-react'
import QRCode from 'qrcode'
import { useToast, ToastPortal, Modal } from './shared'
import { apiFetch } from '../lib/api'

// ===== Types =====
interface AdapterMeta {
  name: string
  description: string
  id: string
  supportStreamingMessage?: boolean
  supportProactiveMessage?: boolean
}

interface Adapter {
  id: string
  name: string
  type: string
  status: string
  isRunning: boolean
  meta: AdapterMeta
  config: Record<string, any>
}

interface QRLoginStatus {
  loggedIn: boolean
  accountId: string | null
  qrStatus: string | null
  qrImgContent: string | null
  qrError: string | null
}

type WxMode = 'create' | 'scanning' | 'success' | 'error'

// ===== Helpers =====
function getStatusText(status: string): string {
  switch (status.toLowerCase()) {
    case 'running': return '正在运行'
    case 'error': return '出错'
    case 'stopping': return '正在停止'
    case 'stopped': return '已停止'
    case 'initialized': return '已初始化'
    default: return status
  }
}

function getPlatformLogoUrl(adapter: Adapter): string {
  const key = `${adapter.id} ${adapter.type}`.toLowerCase()
  if (key.includes('aiocqhttp') || key.includes('onebot')) return '/platform_logos/onebot.png'
  if (key.includes('qqofficial') || key.includes('qq_official') || key.includes('qq')) return '/platform_logos/qq.png'
  if (key.includes('weixin_oc') || key.includes('wechat') || key.includes('wx') || key.includes('weixin')) return '/platform_logos/wechat.png'
  if (key.includes('wecom')) return '/platform_logos/wecom.png'
  if (key.includes('lark')) return '/platform_logos/lark.png'
  if (key.includes('dingtalk')) return '/platform_logos/dingtalk.svg'
  if (key.includes('telegram') || key.includes('tg')) return '/platform_logos/telegram.svg'
  if (key.includes('discord')) return '/platform_logos/discord.svg'
  if (key.includes('slack')) return '/platform_logos/slack.svg'
  if (key.includes('kook')) return '/platform_logos/kook.png'
  if (key.includes('vocechat')) return '/platform_logos/vocechat.png'
  if (key.includes('satori')) return '/platform_logos/satori.png'
  if (key.includes('misskey')) return '/platform_logos/misskey.png'
  if (key.includes('line')) return '/platform_logos/line.png'
  if (key.includes('matrix')) return '/platform_logos/matrix.svg'
  if (key.includes('mattermost')) return '/platform_logos/mattermost.svg'
  return '/platform_logos/onebot.png'
}

// ===== Component =====
export default function MessagePlatformManager() {
  const [adapters, setAdapters] = useState<Adapter[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // Modal state
  const [showModal, setShowModal] = useState(false)
  const [isEditMode, setIsEditMode] = useState(false)
  const [editingAdapterId, setEditingAdapterId] = useState('')
  const [modalAdapterType, setModalAdapterType] = useState<string>('onebot11')
  const [modalAdapterId, setModalAdapterId] = useState('')

  // OneBot11 form fields
  const [ob11Direction, setOb11Direction] = useState<'forward' | 'reverse'>('forward')
  const [ob11Port, setOb11Port] = useState(8080)
  const [ob11Host, setOb11Host] = useState('0.0.0.0')
  const [ob11Path, setOb11Path] = useState('/ws')
  const [ob11ReverseUrl, setOb11ReverseUrl] = useState('ws://127.0.0.1:6700')
  const [ob11ReconnectInterval, setOb11ReconnectInterval] = useState(5000)
  const [ob11AccessToken, setOb11AccessToken] = useState('')

  // QQ Official form fields
  const [qqAppId, setQqAppId] = useState('')
  const [qqAppSecret, setQqAppSecret] = useState('')
  const [qqIntents, setQqIntents] = useState<number | null>(null)

  // Weixin OC — post-create QR scan flow
  const [wxMode, setWxMode] = useState<WxMode>('create')
  const [wxPostCreateQrImage, setWxPostCreateQrImage] = useState<string | null>(null)
  const [wxPostCreateStatus, setWxPostCreateStatus] = useState('')
  const [wxPostCreateAccountId, setWxPostCreateAccountId] = useState('')
  const [wxPostCreateError, setWxPostCreateError] = useState('')
  const wxPostCreatePollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const wxPostCreateDelayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [wxScanningAdapterId, setWxScanningAdapterId] = useState('')

  // Weixin OC edit mode token info
  const [editingWxAccountId, setEditingWxAccountId] = useState('')
  const [editingWxToken, setEditingWxToken] = useState('')
  const [editingWxLoggedIn, setEditingWxLoggedIn] = useState(false)

  // QR code login state for weixin_oc (for edit mode)
  const qrPollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const { toast, showMessage } = useToast()

  const fetchAdapters = useCallback(async () => {
    setIsLoading(true)
    setErrorMsg('')
    try {
      const res = await apiFetch('/api/adapters')
      if (!res.ok) throw new Error('获取平台列表失败')
      setAdapters(await res.json())
    } catch (err: any) {
      setErrorMsg(err.message || '加载消息平台失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const stopWxPostCreatePolling = useCallback(() => {
    if (wxPostCreatePollTimer.current) {
      clearInterval(wxPostCreatePollTimer.current)
      wxPostCreatePollTimer.current = null
    }
    if (wxPostCreateDelayTimer.current) {
      clearTimeout(wxPostCreateDelayTimer.current)
      wxPostCreateDelayTimer.current = null
    }
  }, [])

  const fetchQrLoginStatus = useCallback(async (adapterId: string): Promise<QRLoginStatus | null> => {
    try {
      const res = await apiFetch(`/api/adapters/${encodeURIComponent(adapterId)}/qrcode`)
      if (res.ok) {
        const data: QRLoginStatus = await res.json()
        return data
      }
    } catch { /* ignore */ }
    return null
  }, [])

  const startWxPostCreateScan = useCallback(async (adapterId: string) => {
    setWxMode('scanning')
    setWxPostCreateQrImage(null)
    setWxPostCreateStatus('')
    setWxPostCreateAccountId('')
    setWxPostCreateError('')
    let pollCount = 0
    const MAX_POLLS = 60 // 60 * 3s = 3 minutes max

    const poll = async () => {
      pollCount++
      try {
        const res = await apiFetch(`/api/adapters/${encodeURIComponent(adapterId)}/qrcode`)
        if (!res.ok) {
          console.warn(`[WxOC] qrcode API returned ${res.status}`)
          if (pollCount > 3) {
            setWxPostCreateError(`无法连接到服务器 (HTTP ${res.status})，请检查后端是否运行中`)
          }
          return
        }

        const data = await res.json()
        setWxPostCreateStatus(data.qrStatus ?? '')
        setWxPostCreateAccountId(data.accountId ?? '')
        // Clear error on successful response
        setWxPostCreateError(prev => {
          if (prev.startsWith('无法连接') || prev.startsWith('网络错误')) {
            return ''
          }
          return prev
        })

        if (data.loggedIn) {
          setWxMode('success')
          stopWxPostCreatePolling()
          fetchAdapters()
          return
        }

        const url = data.qrImgContent || ''
        if (url) {
          const img = await QRCode.toDataURL(url, {
            margin: 2,
            width: 200,
            errorCorrectionLevel: 'M',
          })
          setWxPostCreateQrImage(img)
        } else {
          if (pollCount > 5) {
            setWxPostCreateError('二维码生成中，请稍候... (' + pollCount + ')')
          }
        }
      } catch (e) {
        console.error('[WxOC] Poll error:', e)
        setWxPostCreateError('网络错误，正在重试...')
      }
    }

    await new Promise<void>(resolve => {
      wxPostCreateDelayTimer.current = setTimeout(() => resolve(), 1500)
    })
    await poll()
    wxPostCreatePollTimer.current = setInterval(() => {
      if (pollCount >= MAX_POLLS) {
        stopWxPostCreatePolling()
        setWxPostCreateError('超时，请刷新重试或重新添加适配器')
        return
      }
      poll()
    }, 3000)
  }, [fetchAdapters, stopWxPostCreatePolling])

  const refreshWxPostCreateQr = useCallback(() => {
    if (wxPostCreatePollTimer.current && wxMode === 'scanning') {
      clearInterval(wxPostCreatePollTimer.current)
      wxPostCreatePollTimer.current = null
      const scanningId = wxScanningAdapterId
      ;(async () => {
        try {
          const res = await apiFetch(`/api/adapters/${encodeURIComponent(scanningId)}/qrcode`)
          if (res.ok) {
            const data = await res.json()
            const url = data.qrImgContent || ''
            if (url) {
              const img = await QRCode.toDataURL(url, {
                margin: 2, width: 200, errorCorrectionLevel: 'M',
              })
              setWxPostCreateQrImage(img)
            }
            setWxPostCreateStatus(data.qrStatus ?? '')
          }
        } catch { /* ignore */ }
        wxPostCreatePollTimer.current = setInterval(async () => {
          try {
            const res = await apiFetch(`/api/adapters/${encodeURIComponent(scanningId)}/qrcode`)
            if (res.ok) {
              const data = await res.json()
              if (data.loggedIn) {
                setWxMode('success')
                stopWxPostCreatePolling()
                fetchAdapters()
                return
              }
              const url = data.qrImgContent || ''
              if (url) {
                const img = await QRCode.toDataURL(url, { margin: 2, width: 200, errorCorrectionLevel: 'M' })
                setWxPostCreateQrImage(img)
              }
              setWxPostCreateStatus(data.qrStatus ?? '')
            }
          } catch { /* ignore */ }
        }, 3000)
      })()
    }
  }, [wxMode, wxScanningAdapterId, stopWxPostCreatePolling, fetchAdapters])

  const resetForm = useCallback(() => {
    setModalAdapterId('')
    setModalAdapterType('onebot11')
    setOb11Direction('forward')
    setOb11Port(8080)
    setOb11Host('0.0.0.0')
    setOb11Path('/ws')
    setOb11ReverseUrl('ws://127.0.0.1:6700')
    setOb11ReconnectInterval(5000)
    setOb11AccessToken('')
    setQqAppId('')
    setQqAppSecret('')
    setQqIntents(null)
    setWxMode('create')
    stopWxPostCreatePolling()
  }, [stopWxPostCreatePolling])

  const openAddModal = () => {
    setIsEditMode(false)
    setEditingAdapterId('')
    resetForm()
    setShowModal(true)
  }

  const openEditModal = (adapter: Adapter) => {
    setIsEditMode(true)
    setEditingAdapterId(adapter.id)
    setModalAdapterType(adapter.type)
    setModalAdapterId(adapter.id)

    if (adapter.type === 'onebot11') {
      setOb11Direction(adapter.config.direction ?? 'forward')
      setOb11Port(adapter.config.port ?? 8080)
      setOb11Host(adapter.config.host ?? '0.0.0.0')
      setOb11Path(adapter.config.path ?? '/ws')
      setOb11ReverseUrl(adapter.config.reverseUrl ?? 'ws://127.0.0.1:6700')
      setOb11ReconnectInterval(adapter.config.reconnectInterval ?? 5000)
      setOb11AccessToken(adapter.config.accessToken ?? '')
    } else if (adapter.type === 'qqofficial') {
      setQqAppId(adapter.config.appId ?? '')
      setQqAppSecret(adapter.config.appSecret ?? '')
      setQqIntents(adapter.config.intents ?? null)
    } else if (adapter.type === 'weixin_oc') {
      const initialAccountId = adapter.config.accountId ?? ''
      const initialLoggedIn = !!adapter.config.token
      setEditingWxAccountId(initialAccountId)
      setEditingWxToken(adapter.config.token ?? '')
      setEditingWxLoggedIn(initialLoggedIn)
      fetchQrLoginStatus(adapter.id).then((status) => {
        if (status) {
          setEditingWxAccountId(status.accountId ?? initialAccountId)
          setEditingWxLoggedIn(status.loggedIn ?? initialLoggedIn)
        }
      })
    }

    setShowModal(true)
  }

  const buildConfig = (): Record<string, any> => {
    const config: Record<string, any> = {}
    if (modalAdapterType === 'onebot11') {
      config.direction = ob11Direction
      if (ob11Direction === 'forward') {
        config.port = Number(ob11Port)
        config.host = ob11Host
        config.path = ob11Path
      } else {
        config.reverseUrl = ob11ReverseUrl
        config.reconnectInterval = Number(ob11ReconnectInterval)
      }
      if (ob11AccessToken.trim()) {
        config.accessToken = ob11AccessToken.trim()
      }
    } else if (modalAdapterType === 'qqofficial') {
      config.appId = qqAppId.trim()
      config.appSecret = qqAppSecret.trim()
      if (qqIntents != null) {
        config.intents = qqIntents
      }
    }
    return config
  }

  const submitAdapter = async () => {
    if (!isEditMode && !modalAdapterId.trim()) {
      showMessage('请输入平台实例 ID', 'error')
      return
    }

    const config = buildConfig()

    try {
      if (isEditMode) {
        const res = await apiFetch(`/api/adapters/${encodeURIComponent(editingAdapterId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: modalAdapterType, config })
        })
        const result = await res.json()
        if (!res.ok) throw new Error(result.error || '更新适配器失败')

        setShowModal(false)
        resetForm()
        await fetchAdapters()
      } else {
        const res = await apiFetch('/api/adapters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: modalAdapterType,
            id: modalAdapterId.trim(),
            config
          })
        })
        const result = await res.json()
        if (!res.ok) throw new Error(result.error || '添加适配器失败')

        if (modalAdapterType === 'weixin_oc') {
          setWxScanningAdapterId(modalAdapterId.trim())
          await startWxPostCreateScan(modalAdapterId.trim())
        } else {
          setShowModal(false)
          resetForm()
        }
        await fetchAdapters()
      }
    } catch (err: any) {
      showMessage(err.message, 'error')
    }
  }

  const deleteAdapter = async (id: string) => {
    // TODO: replace native confirm() with the shared <Modal> confirmation flow for consistency.
    const confirmMessage = `确定要移除平台适配器 "${id}" 吗？`
    if (!confirm(confirmMessage)) return
    try {
      const res = await apiFetch(`/api/adapters/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
      if (!res.ok) {
        const result = await res.json()
        throw new Error(result.error || '移除失败')
      }
      await fetchAdapters()
    } catch (err: any) {
      showMessage(err.message, 'error')
    }
  }

  const toggleAdapter = async (id: string) => {
    try {
      const res = await apiFetch(`/api/adapters/${encodeURIComponent(id)}/toggle`, { method: 'PATCH' })
      if (!res.ok) throw new Error('切换状态失败')
      await fetchAdapters()
    } catch (err: any) {
      showMessage(err.message, 'error')
    }
  }

  useEffect(() => {
    fetchAdapters()
    return () => {
      if (qrPollTimer.current) {
        clearInterval(qrPollTimer.current)
        qrPollTimer.current = null
      }
      stopWxPostCreatePolling()
    }
  }, [fetchAdapters, stopWxPostCreatePolling])

  const closeModal = () => setShowModal(false)

  return (
    <div>
      <div className="panel-container animate-fade-in">
        <div className="panel-header">
          <div className="header-info">
            <h2>消息平台</h2>
            <p className="subtitle">管理 OneBot、QQ、微信等接入平台，通过适配器管道与 Agent 双向通信</p>
          </div>
          <div className="header-actions">
            <button className="btn btn-secondary btn-icon" onClick={fetchAdapters} disabled={isLoading} aria-label="刷新平台列表">
              <RefreshCw className={`btn-icon-svg${isLoading ? ' animate-spin' : ''}`} />
            </button>
            <button className="btn btn-primary" onClick={openAddModal}>
              <Plus className="btn-icon-svg" />
              接入平台
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="error-banner">
            <AlertCircle className="error-icon" />
            <span>{errorMsg}</span>
          </div>
        )}

        {adapters.length === 0 && !isLoading ? (
          <div className="empty-state">
            <MessageSquare className="empty-icon" />
            <h3>暂未接入任何消息平台</h3>
            <p>点击上方"接入平台"按钮来配置接入通道。</p>
          </div>
        ) : (
          <div className="platform-grid">
            {adapters.map(adapter => (
              <div
                key={adapter.id}
                className={`platform-card${!adapter.isRunning ? ' card-stopped' : ''}`}
              >
                <div className="card-header">
                  <span className="card-title" title={adapter.id}>{adapter.id}</span>
                  <label className="toggle-switch" title={adapter.isRunning ? '停用' : '启用'}>
                    <input
                      type="checkbox"
                      checked={adapter.isRunning}
                      onChange={() => toggleAdapter(adapter.id)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                <div className="card-body">
                  {!adapter.isRunning && (
                    <span className="status-text">{getStatusText(adapter.status)}</span>
                  )}
                </div>

                <img src={getPlatformLogoUrl(adapter)} alt={`${adapter.id} 平台图标`} className="bg-logo" />

                <div className="card-footer">
                  <button className="btn-card-delete" onClick={() => deleteAdapter(adapter.id)}>删除</button>
                  <button className="btn-card-edit" onClick={() => openEditModal(adapter)}>编辑</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={showModal}
        onClose={closeModal}
        title={isEditMode ? '编辑平台连接' : '接入新消息平台'}
        footer={
          <>
            {(modalAdapterType !== 'weixin_oc' || wxMode === 'create' || isEditMode) && (
              <button
                className="btn btn-secondary"
                onClick={() => { setShowModal(false); stopWxPostCreatePolling() }}
              >取消</button>
            )}
            {modalAdapterType === 'weixin_oc' && wxMode === 'scanning' && (
              <button
                className="btn btn-secondary"
                onClick={() => { setShowModal(false); stopWxPostCreatePolling(); setWxMode('create') }}
              >取消</button>
            )}
            {wxMode === 'create' && !isEditMode && modalAdapterType === 'weixin_oc' && (
              <button className="btn btn-primary" onClick={submitAdapter}>确认接入</button>
            )}
            {(wxMode === 'scanning' || wxMode === 'success') && modalAdapterType === 'weixin_oc' && (
              <button
                className="btn btn-primary"
                onClick={() => { setShowModal(false); stopWxPostCreatePolling(); resetForm() }}
              >{wxMode === 'success' ? '完成' : '关闭'}</button>
            )}
            {(isEditMode || modalAdapterType !== 'weixin_oc') && (
              <button className="btn btn-primary" onClick={submitAdapter}>
                {isEditMode ? '保存更改' : '确认接入'}
              </button>
            )}
          </>
        }
      >
        <div className="form-group">
          <label>平台适配器类型</label>
          <select
            value={modalAdapterType}
            onChange={e => setModalAdapterType(e.target.value)}
            className="form-select"
            disabled={isEditMode}
          >
            <option value="onebot11">OneBot 11</option>
            <option value="qqofficial">QQ官方Bot</option>
            <option value="weixin_oc">个人微信</option>
          </select>
        </div>

        {!isEditMode && (
          <div className="form-group">
            <label>实例唯一 ID (例如: qq-bot, telegram-main)</label>
            <input
              type="text"
              value={modalAdapterId}
              onChange={e => setModalAdapterId(e.target.value)}
              placeholder="请输入英文字符实例ID"
              className="form-input"
            />
          </div>
        )}

        {modalAdapterType === 'onebot11' && (
          <div className="form-section">
            <h4>OneBot 11 参数配置</h4>

            <div className="form-group">
              <label>连接方向</label>
              <select
                value={ob11Direction}
                onChange={e => setOb11Direction(e.target.value as 'forward' | 'reverse')}
                className="form-select"
              >
                <option value="forward">反向WS (服务端)</option>
                <option value="reverse">正向WS (客户端)</option>
              </select>
            </div>

            {ob11Direction === 'forward' && (
              <>
                <div className="form-row">
                  <div className="form-group flex-1">
                    <label>Host 绑定</label>
                    <input
                      type="text"
                      value={ob11Host}
                      onChange={e => setOb11Host(e.target.value)}
                      className="form-input"
                    />
                  </div>
                  <div className="form-group flex-1">
                    <label>端口 Port</label>
                    <input
                      type="number"
                      value={ob11Port}
                      onChange={e => setOb11Port(Number(e.target.value))}
                      className="form-input"
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>WS 路径</label>
                  <input
                    type="text"
                    value={ob11Path}
                    onChange={e => setOb11Path(e.target.value)}
                    className="form-input"
                  />
                </div>
              </>
            )}

            {ob11Direction === 'reverse' && (
              <>
                <div className="form-group">
                  <label>目标 WS 地址</label>
                  <input
                    type="text"
                    value={ob11ReverseUrl}
                    onChange={e => setOb11ReverseUrl(e.target.value)}
                    placeholder="ws://127.0.0.1:6700"
                    className="form-input"
                  />
                </div>

                <div className="form-group">
                  <label>重连间隔 (毫秒)</label>
                  <input
                    type="number"
                    value={ob11ReconnectInterval}
                    onChange={e => setOb11ReconnectInterval(Number(e.target.value))}
                    className="form-input"
                  />
                </div>
              </>
            )}

            <div className="form-group">
              <label>鉴权 Token (可选)</label>
              <input
                type="password"
                value={ob11AccessToken}
                onChange={e => setOb11AccessToken(e.target.value)}
                placeholder="不填则不启用验证"
                className="form-input"
              />
            </div>
          </div>
        )}

        {modalAdapterType === 'qqofficial' && (
          <div className="form-section">
            <h4>QQ官方Bot参数配置</h4>

            <div className="form-group">
              <label>AppID</label>
              <input
                type="text"
                value={qqAppId}
                onChange={e => setQqAppId(e.target.value)}
                placeholder="QQ 机器人 AppID"
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label>AppSecret</label>
              <input
                type="password"
                value={qqAppSecret}
                onChange={e => setQqAppSecret(e.target.value)}
                placeholder="QQ 机器人 AppSecret"
                className="form-input"
              />
            </div>

            <div className="form-group">
              <label>Intents 位掩码 (可选)</label>
              <input
                type="number"
                value={qqIntents === null ? '' : qqIntents}
                onChange={e => setQqIntents(e.target.value === '' ? null : Number(e.target.value))}
                placeholder="留空自动计算 (默认: 群消息+C2C消息)"
                className="form-input"
              />
              <small style={{ color: 'var(--text-secondary)', marginTop: '4px', display: 'block' }}>
                常用值: 群@消息=33554432, C2C消息=67108864, 群+C2C=100663296
              </small>
            </div>
          </div>
        )}

        {modalAdapterType === 'weixin_oc' && (
          <div className="form-section">
            <h4>个人微信</h4>

            {isEditMode ? (
              <div className="wx-oc-token-info">
                <div className="token-field">
                  <label>Account ID</label>
                  <div className="token-value">{editingWxAccountId ? '••••••' : '未登录'}</div>
                </div>
                <div className="token-field">
                  <label>Bot Token</label>
                  <div className="token-value token-masked">{editingWxToken ? '••••••' : '未获取'}</div>
                </div>
                <div className="token-field">
                  <label>状态</label>
                  <div className={`token-value ${editingWxLoggedIn ? 'status-logged-in' : 'status-not-logged'}`}>
                    {editingWxLoggedIn ? '已登录' : '未登录'}
                  </div>
                </div>
                <p className="wx-oc-edit-hint">Token 在扫码登录后自动保存，无需手动配置。如需重新登录请删除此适配器后重新添加。</p>
              </div>
            ) : wxMode === 'create' ? (
              <p className="wx-oc-create-hint">
                点击「确认接入」后将自动创建适配器并生成二维码。<br />
                请在弹出的扫码页面中使用手机微信完成登录。
              </p>
            ) : wxMode === 'scanning' ? (
              <div className="wx-oc-modal-qr">
                <p className="wx-oc-hint-text">适配器已创建，请使用手机微信扫码登录</p>

                {!wxPostCreateQrImage && !wxPostCreateError ? (
                  <div className="qr-waiting">
                    <QrCode className="qr-waiting-icon" />
                    <span>正在获取二维码...</span>
                  </div>
                ) : wxPostCreateError ? (
                  <p className="wx-oc-error">{wxPostCreateError}</p>
                ) : wxPostCreateQrImage ? (
                  <>
                    <img src={wxPostCreateQrImage} alt="微信扫码登录" className="wx-modal-qr-img" />
                    {wxPostCreateStatus === 'expired' && (
                      <p className="qr-expired-hint">二维码已过期，正在刷新...</p>
                    )}
                    <button className="btn btn-secondary wx-qr-refresh-btn" onClick={refreshWxPostCreateQr}>
                      刷新二维码
                    </button>
                  </>
                ) : null}
              </div>
            ) : wxMode === 'success' ? (
              <div className="wx-oc-success">
                <span className="success-icon">✓</span>
                <p className="success-title">登录成功！</p>
                <div className="token-field">
                  <label>Account ID</label>
                  <div className="token-value">{wxPostCreateAccountId || '-'}</div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Modal>

      <ToastPortal toast={toast} />
    </div>
  )
}
