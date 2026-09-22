import { build } from "esbuild";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildPaths, configureBuildEnvironment, repositoryRoot } from "./build-runtime.mjs";

if (!process.argv.includes("--run")) throw new Error("Pass --run for one live workflow turn. No automatic retries.");
const paths = buildPaths(); configureBuildEnvironment(paths);
const argument = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const roleIds = (argument("roles") ?? "sartre").split(",").filter(Boolean);
const retrievalOnly = process.argv.includes("--retrieval-only");
if (!retrievalOnly && roleIds.length > 3) throw new Error("At most three people");
const question = argument("question") ?? "我认为自由意味着可以逃避责任。萨特的原典支持这个看法吗？";
const root = mkdtempSync(join(paths.devRoot, "temp", "pchat", "workflow-live-"));
const state = join(root, "state", "pchat"); mkdirSync(state, { recursive: true });
for (const name of ["configuration.json", "deepseek-personal.vault", "qianfan-personal.vault"]) copyFileSync(join(paths.devRoot, "state", "pchat", name), join(state, name));
// Diagnostic alias only affects this isolated run, never the enabled account.
if (argument("wire-person") || argument("wire-group")) {
  if (!retrievalOnly || roleIds.length !== 1) throw new Error("A wire alias requires one retrieval-only role");
  const path = join(state, "configuration.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const entry = config.workflowRetrieval.find((item) => item.binding.corpusId === roleIds[0]);
  if (!entry) throw new Error("Unknown role alias");
  if (argument("wire-person")) entry.person = argument("wire-person");
  if (argument("wire-group")) entry.group = argument("wire-group");
  writeFileSync(path, JSON.stringify(config, null, 2));
}
const source = join(repositoryRoot, "apps", "desktop", "src-tauri");
const files = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const path of files(join(source, "src"))) if (hash(path) !== hash(join(paths.nativeStage, path.slice(source.length + 1)))) throw new Error("Stale Host stage: run pnpm desktop:stage and cargo test --no-run first.");
const artifacts = readFileSync(join(paths.devRoot, "logs", "pchat", "native-test-build.jsonl"), "utf8").split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const executable = artifacts.findLast((entry) => entry.reason === "compiler-artifact" && entry.target?.name === "pchat_desktop_lib" && entry.profile?.test && entry.executable)?.executable;
if (!executable || files(join(source, "src")).some((path) => statSync(path).mtimeMs > statSync(executable).mtimeMs)) throw new Error("Missing or stale native test executable");
const bundle = join(root, "workflow.mjs");
await build({ absWorkingDir: repositoryRoot, stdin: { contents: 'export { configuredPorts } from "./apps/runtime-windows/src/configuration"; export { openWindowsRuntime } from "./apps/runtime-windows/src/bootstrap"; export { createHostNetwork } from "./apps/runtime-windows/src/host-network";', resolveDir: repositoryRoot }, bundle: true, platform: "node", format: "esm", outfile: bundle });
const { configuredPorts, openWindowsRuntime, createHostNetwork } = await import(pathToFileURL(bundle).href);
const child = spawn(executable, ["--ignored", "--exact", "network::live_tests::live_provider_bridge", "--nocapture", "--test-threads=1"], { env: { ...process.env, PCHAT_DEV_ROOT: root, PCHAT_LIVE_BRIDGE: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const exit = new Promise((resolve) => { child.once("exit", resolve); });
const host = createHostNetwork((message) => new Promise((resolve, reject) => child.stdin.write(JSON.stringify(message) + "\n", (error) => error ? reject(error) : resolve())));
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => { const marker = line.indexOf("PCHAT_HOST_RESPONSE:"); if (marker >= 0) host.receive(JSON.parse(line.slice(marker + 20))); });
let nativeLog = ""; child.stderr.on("data", (bytes) => { nativeLog += bytes.toString(); });
child.once("error", () => host.close()); child.once("exit", () => host.close());
let runtime;
try {
  const tracedPort = retrievalOnly ? { request: async (request, cancellation) => {
    const response = await host.port.request(request, cancellation);
    if (!response.ok) return response;
    const original = response.body;
    return { ...response, body: (async function* () {
      let content = "";
      try { for await (const piece of original) { content += piece; yield piece; } }
      finally { writeFileSync(join(root, `${request.attemptId}-${request.operation}.json`), content); }
    })() };
  } } : host.port;
  const dependencies = configuredPorts(state, tracedPort);
  if (argument("replay-final")) {
    const input = JSON.parse(readFileSync(argument("replay-final"), "utf8"));
    const result = await dependencies.discussionModel.discuss({ attemptId: "replay-final", input }, { cancelled: false, subscribe: () => () => {} });
    writeFileSync(join(root, "discussion-result.json"), JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify({ directory: root, ok: result.ok, mode: input.settings.knowledgeMode,
      ...(result.ok ? { answers: result.answer.answers.map((item) => ({ role: item.roleId, kind: item.answer.kind, evidenceIds: item.answer.evidenceIds.length })), commentaryClaims: result.answer.commentary.claimIndexes, summaryRoles: result.answer.summary.roleIds } : { code: result.code }) }, null, 2) + "\n");
    if (!result.ok) process.exitCode = 1;
  } else if (retrievalOnly) {
    const cancellation = { cancelled: false, subscribe: () => () => {} };
    const results = [];
    for (const role of dependencies.roles.filter((role) => !roleIds.length || roleIds.includes(role.id))) {
      if (process.argv.includes("--diagnostic")) {
        const configuration = JSON.parse(readFileSync(join(state, "configuration.json"), "utf8"));
        const binding = configuration.workflowRetrieval.find((item) => item.binding.corpusId === role.corpusId);
        const read = async (operation, body) => {
          const response = await tracedPort.request({ operation, body, connectionId: "qianfan-personal", attemptId: `trace-${role.id}` }, cancellation);
          if (!response.ok) throw new Error(`Diagnostic rejected: ${response.code}`);
          let content = ""; for await (const chunk of response.body) content += chunk;
          if (response.status !== 200) throw new Error(`Diagnostic HTTP ${response.status}`);
          return JSON.parse(content);
        };
        const started = await read("qianfan.traceRun", { app_id: binding.appId, parameters: { _sys_origin_query: question, group: binding.group, per: binding.person } });
        if (!started.execute_id) throw new Error("Diagnostic did not provide execute_id; inspect private response");
        for (let count = 0; count < 10; count++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const result = await read("qianfan.traceRetrieve", { execute_id: started.execute_id });
          const events = result.content?.map((item) => item.event?.status);
          process.stdout.write(JSON.stringify({ role: role.id, diagnostic: true, events }) + "\n");
          if (events?.some((status) => ["success", "failed", "error", "done"].includes(status))) break;
        }
        results.push({ role: role.id, ok: true, diagnostic: true });
        continue;
      }
      const result = await dependencies.rag.retrieve({ attemptId: `probe-${role.id}`, roleRunId: `role-${role.id}`, connectionId: "qianfan-personal", query: question,
        corpusId: role.corpusId, corpusRevision: role.corpusRevision, retrievalConfigRevision: role.retrievalConfigRevision }, cancellation);
      writeFileSync(join(root, `retrieval-${role.id}.json`), JSON.stringify(result, null, 2));
      const summary = { role: role.id, ok: result.ok, ...(result.ok ? { evidenceCount: result.evidence.length } : { code: result.code }) };
      results.push(summary); process.stdout.write(JSON.stringify(summary) + "\n");
    }
    writeFileSync(join(root, "result.json"), JSON.stringify({ results, directory: root }, null, 2));
    process.stdout.write(JSON.stringify({ directory: root }) + "\n");
    if (!results.length || results.some((result) => !result.ok)) process.exitCode = 1;
  } else {
  if (dependencies.discussionModel) {
    const modelPort = dependencies.discussionModel;
    dependencies.discussionModel = {
      countInput: (input) => modelPort.countInput(input),
      plan: (...args) => modelPort.plan(...args),
      discuss: async (...args) => {
        const result = await modelPort.discuss(...args);
        writeFileSync(join(root, "discussion-result.json"), JSON.stringify(result, null, 2));
        return result;
      },
    };
  }
  runtime = await openWindowsRuntime({ stateDirectory: state, dependencies });
  const model = dependencies.modelExecution.policies.at(-1)?.binding;
  const created = await runtime.harness.dispatch({ type: "CreateConversation", commandId: "create", title: "真实流程验收", settings: { participantIds: roleIds, knowledgeMode: argument("mode") ?? "INFERENCE", model, ragConnectionId: "qianfan-personal" } });
  if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);
  await runtime.harness.dispatch({ type: "SubmitQuestion", commandId: "submit", conversationId: created.conversationId, text: question });
  const deadline = Date.now() + 300_000;
  let turn;
  while (Date.now() < deadline) {
    const conversation = await runtime.harness.query({ type: "GetConversation", conversationId: created.conversationId });
    const id = conversation.ok && conversation.data.turnIds[0];
    if (id) { const queried = await runtime.harness.query({ type: "GetTurn", turnId: id }); if (queried.ok) { turn = queried.data; if (turn.status !== "RUNNING") break; } }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  writeFileSync(join(root, "turn.json"), JSON.stringify(turn ?? null, null, 2));
  const result = { passed: turn?.status === "COMPLETED", status: turn?.status, errorCode: turn?.discussion?.errorCode,
    roles: turn?.roleRuns.map((role) => ({ id: role.context.participant.id, status: role.status, evidenceCount: role.evidence.length, answerKind: role.answer?.kind })),
    attempts: turn?.discussion?.attempts.map(({ kind, status }) => ({ kind, status })), directory: root };
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.passed) process.exitCode = 1;
  }
} finally {
  await runtime?.close();
  child.stdin.end("exit\n");
  const timer = setTimeout(() => child.kill(), 5000);
  await exit; clearTimeout(timer); host.close(); lines.close();
  writeFileSync(join(root, "native.log"), nativeLog);
}
