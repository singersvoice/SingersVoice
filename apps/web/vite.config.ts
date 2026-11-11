import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the app from /SingersVoice/; local dev and Cloudflare serve from /.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: {
      '@singersvoice/protocol': fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)),
    },
  },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['brand/apple-touch-icon.png', 'brand/favicon-32.png', 'brand/sv-mark.png', 'worklets/*.js'],
      manifest: {
        name: 'SingersVoice',
        short_name: 'SingersVoice',
        description: 'Lyrics-first karaoke. Sing solo or together; your recordings stay in your own Google Drive.',
        id: base,
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#1B0A2E',
        theme_color: '#5A1583',
        lang: 'en',
        categories: ['music', 'entertainment', 'social'],
        icons: [
          { src: 'brand/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'brand/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'brand/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,webmanifest}', 'brand/icon-192.png', 'brand/sv-mark.png', 'worklets/*.js'],
        globIgnores: ['backgrounds/**', 'brand/*.mp4', 'brand/og-image.png'],
        navigateFallback: `${base}index.html`,
        // Static pages (privacy/terms) must not be swallowed by the SPA fallback.
        navigateFallbackDenylist: [/^\/api\//, /\/(privacy|terms)\.html$/],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/backgrounds/') || url.pathname.includes('/brand/'),
            handler: 'CacheFirst',
            options: { cacheName: 'sv-media', expiration: { maxEntries: 80, maxAgeSeconds: 60 * 86400 } },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://accounts.google.com' || url.origin === 'https://apis.google.com',
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/preact') || id.includes('node_modules/@preact')) return 'vendor';
          return undefined;
        },
      },
    },
  },
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
