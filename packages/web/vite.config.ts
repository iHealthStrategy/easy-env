import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies /api/* to the easy-env daemon so the frontend can
// run on its own port while talking to the same backend the MCP uses.
const DAEMON_TARGET = process.env.EASY_ENV_DAEMON_URL ?? 'http://127.0.0.1:7193';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: DAEMON_TARGET,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
