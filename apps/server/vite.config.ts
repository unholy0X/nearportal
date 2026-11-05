import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // AI calls can take up to a minute on the free tier: keep the proxy open long enough.
  server: { port: 5173, proxy: { "/auth": { target: "http://localhost:8787", timeout: 30000 }, "/api": { target: "http://localhost:8787", timeout: 180_000, proxyTimeout: 180_000 } } },
});
