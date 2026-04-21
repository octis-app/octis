import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Dev build: served at /dev/ — PWA disabled (avoids service worker scope conflict with prod)
export default defineConfig({
  base: '/dev/',
  plugins: [
    react(),
    VitePWA({ disable: true, registerType: 'autoUpdate' }),
  ],
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
  },
})
