import { useEffect, useState } from 'react'
import { Save, KeyRound, Eye, EyeOff } from 'lucide-react'
import { useToast, ToastPortal } from './shared'

const DASHBOARD_TOKEN_KEY = 'dashboardAuthToken'

interface AccountSettingsProps {
  onSuccess?: () => void
}

export default function AccountSettings({ onSuccess }: AccountSettingsProps) {
  const { toast, showMessage } = useToast()
  const [currentUsername, setCurrentUsername] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  useEffect(() => {
    fetch('/api/auth/status')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated && data.username) {
          setCurrentUsername(data.username)
          setNewUsername(data.username)
        }
      })
      .catch(() => {})
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const u = newUsername.trim()
    const p = newPassword.trim()
    const cp = currentPassword.trim()
    const cf = confirmPassword.trim()

    if (!cp || !u || !p || !cf) {
      showMessage('所有字段均为必填项', 'error')
      return
    }
    if (u.length < 3) {
      showMessage('用户名长度至少为3位', 'error')
      return
    }
    if (p.length < 8) {
      showMessage('密码长度至少为8位', 'error')
      return
    }
    if (p !== cf) {
      showMessage('两次输入的新密码不一致', 'error')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/auth/update-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: cp,
          newUsername: u,
          newPassword: p,
          confirmPassword: cf,
        }),
      })
      const data = await res.json()
      if (res.ok) {
        localStorage.setItem(DASHBOARD_TOKEN_KEY, data.token)
        setCurrentUsername(data.username)
        setNewUsername(data.username)
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
        showMessage('凭证更新成功', 'success')
        onSuccess?.()
      } else {
        showMessage(data.message || '更新凭证失败', 'error')
      }
    } catch {
      showMessage('无法连接到服务器', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <ToastPortal toast={toast} />

      {currentUsername && (
        <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-secondary)' }}>
          当前用户名：<span style={{ color: 'var(--text-primary)', fontWeight: 550 }}>{currentUsername}</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <KeyRound size={16} style={{ color: 'var(--accent-primary)' }} />
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>修改用户名与密码</h3>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20, lineHeight: 1.6 }}>
        修改凭证需要验证当前密码。修改成功后会自动重新签发会话令牌，无需重新登录。
      </p>

      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 14 }}>
          <label htmlFor="current-password" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>当前密码</label>
          <div className="input-with-toggle">
            <input
              id="current-password"
              type={showCurrentPassword ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="输入当前密码以验证身份"
              autoComplete="current-password"
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', paddingRight: '2.4rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
            />
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => setShowCurrentPassword(!showCurrentPassword)}
              title={showCurrentPassword ? '隐藏密码' : '显示密码'}
              tabIndex={-1}
            >
              {showCurrentPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="update-username" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>新用户名</label>
          <input
            id="update-username"
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="至少3个字符"
            autoComplete="username"
            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label htmlFor="update-password" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>新密码</label>
          <div className="input-with-toggle">
            <input
              id="update-password"
              type={showNewPassword ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="至少8个字符"
              autoComplete="new-password"
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', paddingRight: '2.4rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
            />
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => setShowNewPassword(!showNewPassword)}
              title={showNewPassword ? '隐藏密码' : '显示密码'}
              tabIndex={-1}
            >
              {showNewPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label htmlFor="update-confirm-password" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>确认新密码</label>
          <div className="input-with-toggle">
            <input
              id="update-confirm-password"
              type={showConfirmPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入新密码以确认"
              autoComplete="new-password"
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', paddingRight: '2.4rem', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 14 }}
            />
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              title={showConfirmPassword ? '隐藏密码' : '显示密码'}
              tabIndex={-1}
            >
              {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        <button type="submit" className="btn btn-primary" disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'center' }}>
          <Save size={15} />
          {loading ? '提交中…' : '保存修改'}
        </button>
      </form>
    </div>
  )
}
