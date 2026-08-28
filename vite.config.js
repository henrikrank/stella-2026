import { defineConfig } from 'vite';

export default defineConfig({
  // Relative, so the build works wherever it is mounted: the project path
  // (/<repo>/) and a custom domain's root both resolve correctly from the
  // page's own URL. An absolute base has to guess which one it is, and guessing
  // wrong 404s every script and asset. VITE_BASE can still force one.
  base: process.env.VITE_BASE || './',
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
