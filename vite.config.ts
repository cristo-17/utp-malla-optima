import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { APP_FULL_NAME, APP_NAME } from './src/config/appIdentity.ts';

// Vercel sirve la web en la raíz del dominio. VITE_BASE es opcional (p. ej. '/utp-malla-optima/' para una subruta).
// El manifest (start_url, scope) y el service worker de vite-plugin-pwa toman esta misma base.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: APP_FULL_NAME,
        short_name: APP_NAME,
        description: 'Planificador curricular y presupuestario offline-first',
        theme_color: '#2b2d42',
        background_color: '#f8f8fa',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          {
            src: 'icon.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icon.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ]
});
