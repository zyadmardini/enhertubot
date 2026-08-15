import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const page = (name: string): string => fileURLToPath(new URL(`./${name}.html`, import.meta.url))

/**
 * Whether the inspector pages are built as well as served in dev.
 *
 * `/lipsync.html` and `/faces.html` exist under the dev server unconditionally —
 * Vite serves any HTML file in the root, so `npm run dev` has always had them.
 * A *build* is different: Vite takes `index.html` as its only entry, so until
 * this existed the pages simply were not in `dist/` and 404d on every deploy.
 *
 * Off by default, because the booth build has no business shipping a debug page
 * a visitor could navigate to. On for the cloud preview, which is a review
 * surface rather than a kiosk, and where being able to look at the mouth against
 * the audio is most of the point of having a preview at all — see vercel.json.
 */
const debugPages = process.env.VITE_ENUBOT_DEBUG_PAGES === '1'

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
    rollupOptions: {
      input: debugPages
        ? { index: page('index'), lipsync: page('lipsync'), faces: page('faces') }
        : page('index'),
    },
  },
})
