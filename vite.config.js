import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// BASE_PATH lets the same build run at the domain root or under a sub-path
// (e.g. GitHub Pages serves the app at /ai-dictation/).
const base = process.env.BASE_PATH || '/'

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      workbox: {
        // Precache icons too, so the launcher keeps working fully offline.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
      manifest: {
        id: base,
        name: 'Nota AI',
        short_name: 'Nota AI',
        description: 'Grabe reuniones, transcríbalas y resúmalas con IA. Sus notas, calendario y pendientes en un solo lugar.',
        lang: 'es',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        theme_color: '#6658e8',
        background_color: '#f7f8fc',
        categories: ['productivity', 'business'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        // Long-press the launcher icon (Android) or right-click it (desktop).
        shortcuts: [
          { name: 'Grabar reunión', short_name: 'Grabar', url: `${base}?action=record`, icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] },
          { name: 'Nueva nota', short_name: 'Nueva nota', url: `${base}?action=new`, icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] },
        ],
      },
    }),
  ],
})
