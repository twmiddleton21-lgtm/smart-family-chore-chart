import { defineConfig } from 'vite';

// Bundles the Node server (server/ plus the shared src/lib business rules)
// into dist-server/. Dependencies such as fastify stay external and are
// installed from package-lock.json; Node built-ins (node:sqlite) are external.
export default defineConfig({
  // public/ belongs to the app build (npm run build:app -> dist-app), which
  // the server serves via SFCC_STATIC_DIR; don't copy it here.
  publicDir: false,
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist-server',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'server/main.ts',
        cli: 'server/cli.ts',
      },
      output: { format: 'es', entryFileNames: '[name].js' },
    },
  },
});
