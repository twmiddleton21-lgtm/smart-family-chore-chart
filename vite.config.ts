import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Development port. strictPort makes Vite fail loudly instead of silently
// moving to another port if this one is already in use.
const PORT = 4174;

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    strictPort: true,
  },
  preview: {
    port: PORT,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
  },
});
