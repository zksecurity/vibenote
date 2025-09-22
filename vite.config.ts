import { defineConfig } from 'vite';

// In `vercel dev`, the CLI runs Vite itself on PORT and serves
// API routes at the same origin. In that mode, Vite should NOT
// proxy `/api` — the Vercel router handles it. For dual‑server
// local dev (vite on 5173 + vercel dev on 3000), we keep the proxy.
const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_DEV);

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
});
