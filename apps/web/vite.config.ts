import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the app is served same-origin with the API (proxied to the gateway), so the
// httpOnly SameSite=Strict refresh cookie works exactly as in production.
const GATEWAY = process.env['DORKAR_GATEWAY_URL'] ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: GATEWAY, changeOrigin: false },
      '/.well-known': { target: GATEWAY, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
