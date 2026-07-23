import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ command }) => ({
  // cloudflare() spins up a local Workers runtime (miniflare/workerd) that needs macOS 13.5+.
  // Plain `npm run dev` skips it (fast, frontend-only, no /api/* — fine for UI work on
  // machines below that macOS version); `npm run dev:api` sets WORKER_DEV=1 to load it when
  // touching auth or persistence. Always loaded for `build`, where it's needed to emit the
  // deployable Worker.
  plugins: [react(), ...(command === "build" || process.env.WORKER_DEV === "1" ? [cloudflare()] : [])],
  base: "./",
}));