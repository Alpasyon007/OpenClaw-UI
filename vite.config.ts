import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Renderer build.
 *
 * This used to be electron.vite.config.ts, which built three bundles: a main
 * process, a preload, and the page. The shell is now saucer/C++ with a Node
 * sidecar behind it, so only the page is built here — the sidecar is bundled
 * by esbuild and the shell by CMake. build-release.mjs runs all three.
 *
 * Output stays at dist/renderer because build-release.mjs copies that tree
 * into shell/web, which is what the sidecar serves over loopback.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  // Assets are served from the web root over loopback, so relative URLs keep
  // working regardless of the port the sidecar picks.
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
})
