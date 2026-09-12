import { isAbsolute, join } from "node:path";
import { defineConfig } from "vitest/config";

const devRoot = process.env.PCHAT_DEV_ROOT;

if (!devRoot || !isAbsolute(devRoot)) {
  throw new Error(
    "Set PCHAT_DEV_ROOT to an absolute development-output directory before running tests.",
  );
}

export default defineConfig({
  cacheDir: join(devRoot, "cache", "pchat", "vitest"),
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      enabled: false,
      reportsDirectory: join(devRoot, "build", "pchat", "coverage"),
    },
  },
});
