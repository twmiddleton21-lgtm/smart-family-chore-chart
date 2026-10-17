import { defineConfig } from 'vite';

// Bundles the Node server (server/ plus the shared src/lib business rules)
// into dist-server/. Dependencies such as fastify stay external and are
// installed from package-lock.json; Node built-ins (node:sqlite) are external.
export default defineConfig({
  // The server does not serve public/ yet (Stage E); don't copy it.
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
