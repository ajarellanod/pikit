/**
 * The chat page's build: static files in dist/, served by channel-web under /chat/.
 *
 * `bun run dev` serves it with hot reload and sends /chat/api to a running app (PIKIT_URL,
 * http://localhost:3000 by default: `pikit dev` or the deployed service). better-auth refuses a
 * change whose Origin is not the app's, so the proxy says the app's origin.
 */

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const app = process.env.PIKIT_URL ?? "http://localhost:3000";

export default defineConfig({
  base: "/chat/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  // Every asset a file of its own: the Content-Security-Policy (`font-src 'self'`) refuses a font
  // inlined as a data: URI.
  build: { assetsInlineLimit: 0 },
  server: {
    proxy: {
      "/chat/api": {
        target: app,
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", (request) => request.getHeader("origin") !== undefined && request.setHeader("origin", new URL(app).origin)),
      },
    },
  },
});
