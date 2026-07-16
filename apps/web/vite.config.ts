import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
      '/api': { target: 'http://localhost:3001', ws: true },
    },
  },
});
