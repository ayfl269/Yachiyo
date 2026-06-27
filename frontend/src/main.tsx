import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import App from './App'

// ── Global auth header injection ──────────────────────────────────────────
// The Dashboard API requires `Authorization: Bearer <token>` when the server
// is configured with an authToken. We wrap window.fetch so every same-origin
// /api/ request automatically carries the token stored in localStorage by the
// login screen (see App.tsx). This avoids editing fetch calls in every
// component. The token is only sent to same-origin /api/ paths, never to
// cross-origin URLs or static assets.
const DASHBOARD_TOKEN_KEY = 'dashboardAuthToken'
const originalFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let url: string
  if (input instanceof Request) {
    url = input.url
  } else if (input instanceof URL) {
    url = input.toString()
  } else {
    url = input
  }
  // Only inject auth for same-origin API calls.
  const isSameOriginApi =
    url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`)
  if (isSameOriginApi) {
    const token = localStorage.getItem(DASHBOARD_TOKEN_KEY)
    if (token) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      // Don't overwrite an explicitly-provided Authorization header.
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`)
      }
      init = { ...init, headers }
    }
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
