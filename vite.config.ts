import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Development port. strictPort makes Vite fail loudly instead of silently
// moving to another port if this one is already in use.
const PORT = 4174;

// Data source, chosen at BUILD time (never auto-detected):
//   default            "local": browser localStorage (the released v0.3.0 behaviour)
//   --mode api         "api":   the shared-backend development implementation;
//                      /api is forwarded to the local development server.
// The API target defaults to the dev server on 127.0.0.1:3000.
const API_TARGET = process.env.SFCC_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig(({ mode }) => {
  const dataSource = mode === 'api' ? 'api' : 'local';
  return {
    plugins: [react()],
    define: {
      __SFCC_DATA_SOURCE__: JSON.stringify(dataSource),
    },
    server: {
      port: PORT,
      strictPort: true,
      // changeOrigin rewrites Host to the target (127.0.0.1:3000), which the
      // server's anti-DNS-rebinding check requires.
      proxy: dataSource === 'api' ? { '/api': { target: API_TARGET, changeOrigin: true } } : undefined,
    },
    preview: {
      port: PORT,
      strictPort: true,
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
    },
  };
});
