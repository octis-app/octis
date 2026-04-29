import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate', // Install new SW in background; skipWaiting=false defers activation to next launch
      includeAssets: ['icons/*.png', 'apple-touch-icon.png', 'octis-logo.svg'],
      manifest: {
        name: 'Octis',
        short_name: 'Octis',
        description: 'Your AI command center',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f1117',
        theme_color: '#6366f1',
        orientation: 'portrait-primary',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        ],
      },
      strategies: 'generateSW',
      injectRegister: 'auto',
      workbox: {
        navigateFallbackDenylist: [/^\/dev\//],
        importScripts: ['sw-push.js'],
        skipWaiting: true,  // Activate new SW immediately on install — users get new code on next refresh
        clientsClaim: true,  // New SW takes control of all open tabs immediately after activation
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3747',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3747',
        ws: true,
      },
    },
  },
})
