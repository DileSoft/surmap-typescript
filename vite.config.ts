import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Deployed as a project page: https://dilesoft.github.io/surmap-typescript/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/surmap-typescript/' : '/',
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
}));
