import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), wgslVitePlugin({ minify: true })],
  server: {
    port: 5180,
    strictPort: true,
    proxy: { "/api/market": { target: "https://plugin.maibot.chat", changeOrigin: true } },
  },
  preview: {
    port: 5180,
    strictPort: true,
  },
  build: {
    target: "es2024",
  },
});
