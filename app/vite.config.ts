import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Tauri shell loads the dev server during `tauri dev` and the built bundle
// in release. Proxy /api → the embedded daemon so the same fetch path works in
// both. Daemon port matches packages/mcp-server (default 7193).
const DAEMON_TARGET = process.env.EASY_ENV_DAEMON_URL ?? 'http://127.0.0.1:7193';

export default defineConfig({
  plugins: [react()],
  // Tauri uses a custom URL scheme in prod; relative paths are safest.
  base: './',
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: DAEMON_TARGET, changeOrigin: false },
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Tauri supports modern targets; Safari 13+ / Chrome 105+ via WebView.
    target: ['es2022', 'safari14'],
    minify: 'esbuild',
    emptyOutDir: true,
  },
});
