import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { env } from "node:process";
import { isAbsolute, resolve } from "node:path";

const devRoot = env.PCHAT_DEV_ROOT;
if (!devRoot || !isAbsolute(devRoot)) throw new Error("PCHAT_DEV_ROOT must be an absolute development-output directory.");

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  cacheDir: resolve(devRoot, "cache", "pchat", "vite-desktop"),
  build: {
    outDir: resolve(devRoot, "build", "pchat", "frontend"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});
