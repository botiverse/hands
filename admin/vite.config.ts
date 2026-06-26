import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

// Vite config for quiver admin SPA.
// Dev: proxies /api to the local Worker (wrangler dev :8787).
// Prod: deployed to Cloudflare Pages; /api calls go to the deployed Worker.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        // Admin UI sends Authorization: Bearer <ADMIN_API_TOKEN>; pass through.
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});