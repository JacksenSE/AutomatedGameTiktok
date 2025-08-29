import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: './overlay',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared')
    }
  },
  server: {
    port: 5173
  }
});