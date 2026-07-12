import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ command }) => ({
  // cloudflare() spins up a local Workers runtime (miniflare/workerd) that needs
  // macOS 13.5+; this app has no server-side Worker code, so skip it for `dev`
  // and only load it for `build`, where it's needed to emit dist/wrangler.json.
  plugins: [react(), ...(command === "build" ? [cloudflare()] : [])],
  base: "./",
}));