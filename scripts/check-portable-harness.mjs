import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const forbiddenGlobals = [
  "process", "Buffer", "require", "module", "exports", "global",
  "window", "document", "navigator", "HTMLElement", "Worker",
  "AbortController", "AbortSignal", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "setImmediate", "clearImmediate",
  "queueMicrotask", "fetch", "XMLHttpRequest", "WebSocket",
];

/** Execute only self-contained ECMAScript code, including its microtasks. */
export function runPortableBundle(source) {
  const context = vm.createContext(Object.create(null), {
    name: "Pchat portable core",
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const script = new vm.Script(`
    delete globalThis.console;
    for (const name of ${JSON.stringify(forbiddenGlobals)}) {
      if (name in globalThis) throw new Error("Unexpected platform global: " + name);
    }
    ${source}
    Promise.resolve().then(() => PchatPortable.verifyHarness()).then(
      () => { globalThis.__portableOutcome = { ok: true }; },
      (error) => { globalThis.__portableOutcome = { ok: false, message: String(error?.message ?? error) }; }
    );
  `, { filename: "pchat-portable-memory-bundle.js" });
  // afterEvaluate drains the VM's own Promise queue under this CPU timeout.
  // No host callbacks, clocks, timers, network, or IO are provided to the core.
  script.runInContext(context, { timeout: 5_000 });
  const outcome = context.__portableOutcome;
  if (!outcome) throw new Error("Workflow did not finish using ECMAScript microtasks.");
  if (!outcome.ok) throw new Error(outcome.message);
}

function probe(body) {
  return `var PchatPortable = { verifyHarness: async () => { ${body} } };`;
}

/** Negative controls prevent a permissive runner from passing this gate. */
export function checkRunnerControls() {
  runPortableBundle(probe("await Promise.resolve(); return 'completed';"));
  for (const name of forbiddenGlobals) {
    let rejected = false;
    try {
      runPortableBundle(probe(`${name};`));
    } catch (error) {
      if (error.message !== `${name} is not defined`) throw error;
      rejected = true;
    }
    if (!rejected) throw new Error(`Runner accepted forbidden global access: ${name}.`);
  }
  let rejected = false;
  try {
    runPortableBundle(probe("await new Promise(() => {});"));
  } catch (error) {
    if (error.message !== "Workflow did not finish using ECMAScript microtasks.") throw error;
    rejected = true;
  }
  if (!rejected) throw new Error("Runner accepted an unfinished workflow.");
}

export async function checkPortableHarness() {
  checkRunnerControls();
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    entryPoints: ["scripts/portable-harness-fixture.ts"],
    bundle: true,
    write: false,
    platform: "neutral",
    format: "iife",
    globalName: "PchatPortable",
    target: "es2023",
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1) throw new Error("Expected one in-memory portable bundle.");
  runPortableBundle(result.outputFiles[0].text);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === "--self-test") {
      checkRunnerControls();
      console.log("Portable runner controls passed: platform globals and unfinished workflows are rejected.");
    } else {
      await checkPortableHarness();
      console.log("Portable Harness check passed: ECMAScript-only client turn, bookmark replay and runner controls.");
    }
  } catch (error) {
    console.error(`Portable Harness check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
