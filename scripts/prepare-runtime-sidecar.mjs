import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("P0 currently prepares only the Windows x64 runtime sidecar");
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeBundle = resolve(
  repositoryRoot,
  "apps/runtime-windows/dist/main.mjs",
);
if (!existsSync(runtimeBundle)) {
  throw new Error(`Runtime bundle is missing: ${runtimeBundle}`);
}

const destinationDirectory = resolve(
  repositoryRoot,
  "apps/desktop/src-tauri/binaries",
);
const destination = resolve(
  destinationDirectory,
  "pchat-node-x86_64-pc-windows-msvc.exe",
);

mkdirSync(destinationDirectory, { recursive: true });
copyFileSync(process.execPath, destination);
process.stdout.write(`Prepared bundled Node runtime: ${destination}\n`);
