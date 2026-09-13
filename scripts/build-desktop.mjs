import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildPaths, buildRuntime, configureBuildEnvironment } from "./build-runtime.mjs";
import { prepareRuntimeSidecar } from "./prepare-runtime-sidecar.mjs";

const paths = buildPaths();
configureBuildEnvironment(paths);
const [mode = "build", ...args] = process.argv.slice(2);
if (!["frontend", "stage", "dev", "build", "info"].includes(mode)) {
  throw new Error("Usage: node scripts/build-desktop.mjs frontend|stage|dev|build|info [Tauri options]");
}

function runNode(script, arguments_, cwd) {
  return new Promise((resolve_, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], { cwd, env: process.env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve_() : reject(new Error(`Build command failed (${signal ?? code}): ${script}`)));
  });
}

async function buildFrontend() {
  await runNode(join(paths.desktopDirectory, "node_modules", "typescript", "bin", "tsc"), ["--noEmit"], paths.desktopDirectory);
  await runNode(join(paths.desktopDirectory, "node_modules", "vite", "bin", "vite.js"), ["build", "--configLoader", "runner"], paths.desktopDirectory);
}

function stageNativeInputs() {
  // This is a generated, dedicated crate. Verify its final path before replacing
  // it so removed capabilities and Rust inputs cannot survive from an old build.
  const within = relative(paths.outputRoot, resolve(paths.nativeStage));
  if (within !== "native-stage" || isAbsolute(within)) throw new Error("Refusing to replace an unexpected native staging directory.");
  rmSync(paths.nativeStage, { recursive: true, force: true });
  mkdirSync(paths.nativeStage, { recursive: true });
  const source = join(paths.desktopDirectory, "src-tauri");
  for (const file of ["Cargo.toml", "Cargo.lock", "build.rs"]) copyFileSync(join(source, file), join(paths.nativeStage, file));
  for (const directory of ["src", "capabilities", "icons", "permissions"]) {
    if (existsSync(join(source, directory))) cpSync(join(source, directory), join(paths.nativeStage, directory), { recursive: true });
  }
  const config = JSON.parse(readFileSync(join(source, "tauri.conf.json"), "utf8"));
  config.build = {
    ...config.build,
    beforeBuildCommand: null,
    beforeDevCommand: { script: "pnpm dev", cwd: paths.desktopDirectory },
    frontendDist: paths.frontendDirectory,
  };
  config.bundle = {
    ...config.bundle,
    useLocalToolsDir: true,
    externalBin: ["binaries/pchat-node"],
    resources: { [paths.runtimeBundle]: "runtime/main.mjs" },
  };
  writeFileSync(join(paths.nativeStage, "tauri.conf.json"), `${JSON.stringify(config, null, 2)}\n`);
  prepareRuntimeSidecar(paths);
  process.env.TAURI_APP_PATH = paths.nativeStage;
  process.env.TAURI_FRONTEND_PATH = paths.desktopDirectory;
  process.stdout.write(`Staged Tauri crate: ${paths.nativeStage}\n`);
}

if (mode === "frontend") {
  await buildFrontend();
} else {
  mkdirSync(paths.outputRoot, { recursive: true });
  const lockPath = join(paths.outputRoot, "native-stage.lock");
  const lock = openSync(lockPath, "wx");
  try {
    await buildRuntime(paths);
    if (mode !== "dev" && mode !== "info") await buildFrontend();
    stageNativeInputs();
    if (mode !== "stage") {
      await runNode(join(paths.desktopDirectory, "node_modules", "@tauri-apps", "cli", "tauri.js"), [mode, ...args], paths.nativeStage);
    }
  } finally {
    closeSync(lock);
    rmSync(lockPath);
  }
}
