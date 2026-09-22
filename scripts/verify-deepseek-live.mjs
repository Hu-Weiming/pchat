import { build } from "esbuild";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { buildPaths, configureBuildEnvironment, repositoryRoot } from "./build-runtime.mjs";

// Intentionally outside the ordinary test suite: this makes ONE paid request.
if (!process.argv.includes("--run")) throw new Error("Pass --run to make one live DeepSeek request (maximum 512 output tokens).");
const paths = buildPaths();
configureBuildEnvironment(paths);
const directory = mkdtempSync(join(paths.devRoot, "temp", "pchat", "deepseek-live-"));
const config = JSON.parse(readFileSync(join(paths.devRoot, "state", "pchat", "configuration.json"), "utf8"));
const connection = config.connections.find((item) => item.id === "deepseek-personal");
const model = config.models.findLast((item) => item.binding.connectionId === connection?.id && item.binding.configRevision === connection.revision);
if (!model) throw new Error("Configure DeepSeek in Pchat first.");
const modulePath = join(directory, "adapter.mjs");
await build({ absWorkingDir: repositoryRoot, stdin: { contents: 'export { DeepSeekModel } from "./packages/providers/src/index"; export { testRole, testSettings } from "./packages/testing/src/fixtures";', resolveDir: repositoryRoot }, bundle: true, platform: "node", format: "esm", outfile: modulePath });
const { DeepSeekModel, testRole, testSettings } = await import(pathToFileURL(modulePath).href);
const request = { attemptId: "live-connection-check", roleRunId: "live-check", context: {
  question: { id: "live-check-question", text: "这是接口连通性测试，请用中文简短回答：连接成功。不要作哲学论断。" },
  settings: { ...testSettings, knowledgeMode: "FICTION", model: model.binding }, participant: { ...testRole, label: "接口连通性测试（非真实人物资料）" }, history: [],
}, evidence: [] };
const token = { cancelled: false, subscribe: () => () => {} };
const configurations = { resolve: () => ({ ...model, maxOutputTokens: Math.min(512, model.maxOutputTokens) }) };
let expectedRequest;
const capture = new DeepSeekModel({ configurations, network: { request: async (value) => { expectedRequest = value; return { ok: false, code: "REJECTED" }; } } });
for await (const _ of capture.generate(request, token)) { /* capture the actual adapter request */ }
if (!expectedRequest) throw new Error("Adapter rejected the probe before transport.");
writeFileSync(join(directory, "request.json"), JSON.stringify(expectedRequest));
// Rebuild the staged Host before any paid request; an old staging directory
// would otherwise validate a different Rust implementation than this checkout.
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(repositoryRoot, "scripts", "build-desktop.mjs"), "stage"], {
    env: process.env, stdio: "inherit", windowsHide: true,
  });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Native staging failed; no request sent.")));
});
await new Promise((resolve, reject) => {
  const child = spawn("cargo", ["test", "--manifest-path", join(paths.nativeStage, "Cargo.toml"), "live_deepseek_connection", "--", "--ignored", "--exact", "network::live_tests::live_deepseek_connection"], {
    env: { ...process.env, PCHAT_LIVE_PROBE_DIRECTORY: directory }, stdio: "inherit", windowsHide: true,
  });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Native live probe failed; no automatic retry.")));
});
const wire = readFileSync(join(directory, "response.sse"), "utf8");
const replay = new DeepSeekModel({ configurations, network: { request: async (value) => {
  if (JSON.stringify(value) !== JSON.stringify(expectedRequest)) throw new Error("Probe request changed.");
  return { ok: true, status: 200, body: (async function* () { yield wire; })() };
} } });
const chunks = [];
for await (const chunk of replay.generate(request, token)) chunks.push(chunk);
const complete = chunks.at(-1);
if (complete?.type !== "complete") throw new Error("Actual supplier stream failed production adapter validation.");
const result = { passed: true, model: model.binding.modelId, hostCredentialAndNetwork: true, adapterValidated: true, answer: complete.answer, directory };
writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
