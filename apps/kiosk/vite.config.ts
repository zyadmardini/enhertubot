import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    // The kiosk ships two inspector pages alongside the kiosk itself. Vite only
    // picks up index.html by default, so name them here or they never reach dist
    // and can't be opened on a deploy.
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        lipsync: fileURLToPath(new URL('./lipsync.html', import.meta.url)),
        faces: fileURLToPath(new URL('./faces.html', import.meta.url)),
      },
    },
  },
})
