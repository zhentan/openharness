import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const KERNEL_PORT = process.env.KERNEL_PORT ?? "3000";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/_api": {
        target: `http://localhost:${KERNEL_PORT}`,
      },
      "/ws": {
        target: `ws://localhost:${KERNEL_PORT}`,
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
