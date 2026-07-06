import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works at any mount point
  // (GitHub Pages serves under /vibe-blender/, dev under /).
  base: './',
});
