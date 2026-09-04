import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        control: resolve(__dirname, "src/control/index.html"),
        overlay: resolve(__dirname, "src/overlay/index.html"),
        translate: resolve(__dirname, "src/translate/index.html"),
        web: resolve(__dirname, "src/web/index.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    exclude: ["@xenova/transformers"],
  },
});
