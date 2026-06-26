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
          // Suppress noisy ECONNREFUSED errors when the backend isn't running yet.
          // The frontend already handles API failures gracefully (error states / retries),
          // so these proxy log lines are pure noise during startup.
          proxy.on('error', (err, _req, res) => {
            if ('code' in err && err.code === 'ECONNREFUSED') {
              if (res && 'headersSent' in res && !res.headersSent && typeof res.writeHead === 'function') {
                res.writeHead(502, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Backend server not available' }))
              }
            }
          })
        },
      }
    }
  }
})
