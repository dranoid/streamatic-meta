import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

// In development the API runs from `npm run serve` in ../service; Vite forwards to it.
const api = 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': decodeURIComponent(new URL('./src', import.meta.url).pathname) } },
  server: { proxy: { '/api': api, '/media': api, '/camera-pictures': api } },
  build: { outDir: 'dist', emptyOutDir: true },
});
