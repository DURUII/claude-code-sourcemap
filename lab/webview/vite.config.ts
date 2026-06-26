import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/bridge": {
        target: "ws://127.0.0.1:8787",
        ws: true
      }
    }
  },
  build: {
    sourcemap: true
  }
});
