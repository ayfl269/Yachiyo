/**
 * Auth token store & API fetch wrapper.
 *
 * 设计说明：
 * - Token 主存储为模块级内存变量，生命周期仅限当前页面。
 * - sessionStorage 仅用于页面刷新后恢复会话，浏览器关闭即清除
 *   （相比 localStorage 缩短了暴露窗口）。
 * - 提供从旧 localStorage 的一次性迁移逻辑，迁移后立即清除旧值。
 * - apiFetch 仅对同源 /api/ 路径注入 Authorization 头，第三方库的
 *   fetch 调用（apexcharts、qrcode 等）不受影响，替代了此前对
 *   window.fetch 的全局 monkey-patch。
 */

const SESSION_STORAGE_KEY = 'dashboardAuthToken'
const LEGACY_LOCAL_STORAGE_KEY = 'dashboardAuthToken'

// 内存中的 token（主存储）。XSS 在页面卸载后无法访问。
let memoryToken: string | null = null
let migrated = false

/**
 * 一次性迁移：将旧 localStorage 中的 token 迁移到 sessionStorage，
 * 迁移成功后立即清除 localStorage 中的旧值。
 */
function migrateFromLocalStorage(): void {
  if (migrated) return
  migrated = true
  try {
    const legacy = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY)
    if (legacy) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, legacy)
      localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY)
      memoryToken = legacy
    }
  } catch {
    // 受限环境（如沙箱 iframe）下 storage 可能抛错，忽略即可
  }
}

/**
 * Auth token store。
 * 内存变量优先，sessionStorage 作为页面刷新后的恢复来源。
 */
export const authStore = {
  getToken(): string | null {
    if (memoryToken) return memoryToken
    migrateFromLocalStorage()
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY)
      if (stored) {
        memoryToken = stored
        return stored
      }
    } catch {
      // 受限环境下忽略
    }
    return null
  },

  setToken(token: string): void {
    memoryToken = token
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, token)
    } catch {
      // 存储失败不影响当前会话（内存 token 仍有效）
    }
  },

  clearToken(): void {
    memoryToken = null
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY)
    } catch {
      // 忽略
    }
  },
}

/**
 * fetch 包装函数：对同源 /api/ 请求自动注入 Bearer token。
 *
 * 替代了此前 main.tsx 中对 window.fetch 的全局 monkey-patch。
 * 第三方库的 fetch 调用不会被注入鉴权头，避免凭证泄漏到外部。
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let url: string
  if (input instanceof Request) {
    url = input.url
  } else if (input instanceof URL) {
    url = input.toString()
  } else {
    url = input
  }

  const isSameOriginApi =
    url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`)

  if (isSameOriginApi) {
    const token = authStore.getToken()
    if (token) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )
      // 不覆盖调用方显式设置的 Authorization 头
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`)
      }
      init = { ...init, headers }
    }
  }

  return fetch(input, init)
}
