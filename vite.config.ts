import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// In `vercel dev`, the CLI runs Vite itself on PORT and serves
// API routes at the same origin. In that mode, Vite should NOT
// proxy `/api` — the Vercel router handles it. For dual-server
// local dev (vite on 5173 + vercel dev on 3000), we keep the proxy.
const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_DEV);

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const shareTemplate = readFileSync(resolve(rootDir, 'share.html'), 'utf8');

export default defineConfig({
  server: {
    port: 5173,
    proxy: isVercel
      ? undefined
      : {
          '/api': {
            target: 'http://localhost:3000',
            changeOrigin: true,
          },
        },
  },
  plugins: [
    {
      name: 'share-route-fallback',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url || req.method !== 'GET') {
            next();
            return;
          }
          if (!req.url.startsWith('/s/')) {
            next();
            return;
          }
          try {
            const html = await server.transformIndexHtml(req.url, shareTemplate);
            res.setHeader('Content-Type', 'text/html');
            res.end(html);
          } catch (error) {
            next(error as Error);
          }
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        share: resolve(rootDir, 'share.html'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: 'src/test/setup.ts',
    clearMocks: true,
    restoreMocks: true,
  },
} as any);
