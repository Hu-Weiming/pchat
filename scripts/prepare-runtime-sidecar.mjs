import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPaths, configureBuildEnvironment } from "./build-runtime.mjs";

export function prepareRuntimeSidecar(paths = buildPaths()) {
  configureBuildEnvironment(paths);
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Pchat currently prepares only the Windows x64 runtime sidecar");
  }
  if (!existsSync(paths.runtimeBundle)) throw new Error(`Runtime bundle is missing: ${paths.runtimeBundle}`);
  const destinationDirectory = join(paths.nativeStage, "binaries");
  const destination = join(destinationDirectory, "pchat-node-x86_64-pc-windows-msvc.exe");
  mkdirSync(destinationDirectory, { recursive: true });
  copyFileSync(process.execPath, destination);
  process.stdout.write(`Prepared bundled Node runtime: ${destination}\n`);
  return destination;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  prepareRuntimeSidecar();
}
