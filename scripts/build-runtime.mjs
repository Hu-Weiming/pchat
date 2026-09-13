import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildPaths() {
  const configured = process.env.PCHAT_DEV_ROOT;
  if (!configured || !isAbsolute(configured)) throw new Error("PCHAT_DEV_ROOT must be an absolute development-output directory.");
  const devRoot = resolve(configured);
  const outputRoot = join(devRoot, "build", "pchat");
  const withinRepository = relative(repositoryRoot, outputRoot);
  if (!withinRepository || (!withinRepository.startsWith("..") && !isAbsolute(withinRepository))) {
    throw new Error("Development outputs must be outside the source repository.");
  }
  return {
    devRoot, outputRoot,
    runtimeBundle: join(outputRoot, "runtime", "main.mjs"),
    frontendDirectory: join(outputRoot, "frontend"),
    nativeStage: join(outputRoot, "native-stage"),
    desktopDirectory: join(repositoryRoot, "apps", "desktop"),
  };
}

/** Only this build process and its children receive these settings. */
export function configureBuildEnvironment(paths) {
  const directories = {
    TEMP: join(paths.devRoot, "temp", "pchat"),
    TMP: join(paths.devRoot, "temp", "pchat"),
    NODE_COMPILE_CACHE: join(paths.devRoot, "cache", "pchat", "node"),
    CARGO_HOME: join(paths.devRoot, "cargo-home"),
    CARGO_TARGET_DIR: join(paths.devRoot, "cargo-target", "pchat"),
    npm_config_cache: join(paths.devRoot, "cache", "pchat", "npm"),
    pnpm_config_store_dir: join(paths.devRoot, "pnpm-store"),
    pnpm_config_cache_dir: join(paths.devRoot, "cache", "pchat", "pnpm"),
    pnpm_config_state_dir: join(paths.devRoot, "state", "pchat", "pnpm"),
  };
  for (const [name, directory] of Object.entries(directories)) {
    mkdirSync(directory, { recursive: true });
    process.env[name] = directory;
  }
  process.env.pnpm_config_verify_deps_before_run = "false";
}

export async function buildRuntime(paths = buildPaths()) {
  configureBuildEnvironment(paths);
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ["apps/runtime-windows/src/main.ts"],
    bundle: true, platform: "node", format: "esm", target: "node24",
    outfile: paths.runtimeBundle,
  });
  process.stdout.write(`Built Runtime: ${paths.runtimeBundle}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildRuntime();
}
