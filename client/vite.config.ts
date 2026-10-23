import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    // Phaser is a substantial engine; keep it out of the app entry bundle.
    // The higher threshold avoids a noisy warning for the expected engine chunk.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/phaser/')) return 'phaser';
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/scheduler/')
          ) return 'react-vendor';
          if (
            id.includes('/socket.io-client/') ||
            id.includes('/socket.io-parser/') ||
            id.includes('/engine.io-client/') ||
            id.includes('/engine.io-parser/') ||
            id.includes('/@socket.io/')
          ) return 'socket-vendor';
          return 'vendor';
        },
      },
    },
  },
});
