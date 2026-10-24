import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Under WSL, edits made from Windows to /mnt/... don't fire inotify events,
// so files have to be watched by polling.
const wslOnWindowsDrive = !!process.env.WSL_DISTRO_NAME && process.cwd().startsWith('/mnt/');

// Version of the app (package.json), shown in Settings.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    watch: wslOnWindowsDrive ? { usePolling: true, interval: 300 } : undefined,
  },
  build: {
    // Libraries go in their own files, so a new version of the app only
    // changes (and downloads) the app's own code.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'firebase', test: /[\\/]node_modules[\\/](@firebase|firebase|re2js|idb)[\\/]/, priority: 3 },
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 2 },
            { name: 'icons', test: /[\\/]node_modules[\\/]lucide-react[\\/]/, priority: 1 },
          ],
        },
      },
    },
    // Firestore alone is bigger than the default warning size.
    chunkSizeWarningLimit: 700,
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // The page decides when to switch to a new version (see main.tsx).
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      manifest: {
        name: 'Casa',
        short_name: 'Casa',
        description: 'Calendario familiar y cosas de casa · Family calendar and household organizer',
        lang: 'es',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#F4EEE5',
        theme_color: '#F4EEE5',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});
