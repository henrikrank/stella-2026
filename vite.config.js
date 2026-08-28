import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  // The 93 MB character GLB is served straight from assets/ rather than
  // inlined or copied through the bundler.
  publicDir: false,
  build: { target: 'es2022' },
});
