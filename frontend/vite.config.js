import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: 'all',
    proxy: {
      '/api':      { target: 'http://backend-dev:8000', changeOrigin: true },
      '/trace':    { target: 'ws://backend-dev:8000',   ws: true },
      '/trace-ip': { target: 'ws://backend-dev:8000',   ws: true },
      '/signal':   { target: 'ws://backend-dev:8000',   ws: true },
    },
  },
})