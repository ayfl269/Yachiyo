import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure: (proxy) => {
          // Handle all proxy errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, etc.)
          // so the dev server returns a clean JSON 502 instead of crashing the
          // request with an unhandled error. The frontend already handles API
          // failures gracefully (error states / retries).
          proxy.on('error', (err, _req, res) => {
            const code = 'code' in err ? String(err.code) : 'ERROR'
            console.warn(`[vite-proxy] ${code}: ${err.message}`)
            if (res && 'headersSent' in res && !res.headersSent && typeof res.writeHead === 'function') {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Backend server not available', code }))
            }
          })
        },
      }
    }
  }
})
