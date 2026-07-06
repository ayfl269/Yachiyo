import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import App from './App'

// 鉴权头注入逻辑已迁移至 src/lib/api.ts 的 apiFetch 函数。
// 此前对 window.fetch 的全局 monkey-patch 会影响所有第三方库
// （apexcharts、qrcode 等）的请求，现已被移除。业务代码应使用
// apiFetch('/api/...') 替代原生 fetch('/api/...')。

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
