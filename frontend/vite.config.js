import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        // `npm run dev` in the project root (wrangler dev) serves the Worker API here.
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  }
});