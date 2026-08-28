import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/, so the build needs to
  // know its prefix. The workflow sets VITE_BASE; locally it stays at root.
  base: process.env.VITE_BASE || '/',
  server: { port: 5173 },
  // Character, manor and weapon assets are served straight from assets/ rather
  // than inlined or hashed by the bundler; scripts/copy-assets.mjs puts them
  // into dist/ at build time.
  publicDir: false,
  build: {
    target: 'es2022',
    // Keep the bundler's hashed output out of dist/assets, which is reserved
    // for the game's own asset tree.
    assetsDir: 'bundle',
  },
});
