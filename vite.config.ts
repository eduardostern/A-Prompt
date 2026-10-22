import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // The telnet relay is the Worker: run `npx wrangler dev` alongside.
  server: {
    proxy: { '/relay': { target: 'ws://localhost:8787', ws: true } },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
