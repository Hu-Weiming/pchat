import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { openWindowsRuntime } from "./bootstrap";
import { configuredPorts } from "./configuration";
import { createHostNetwork } from "./host-network";
import { runRuntimeSession } from "./runtime-session";
import { createKnowledgeSetup } from "./knowledge-setup";

async function main() {
  const stateDirectory = process.env.PCHAT_STATE_DIRECTORY;
  if (!stateDirectory || !isAbsolute(stateDirectory)) throw new Error("State directory required");
  const host = createHostNetwork((message) => new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(message) + "\n", (error) => error ? reject(error) : resolve());
  }));
  const runtime = await openWindowsRuntime({ stateDirectory, dependencies: configuredPorts(stateDirectory, host.port) });
  try {
    const result = await runRuntimeSession({ harness: runtime.harness, input: process.stdin, output: process.stdout, nextId: randomUUID, host, setup: createKnowledgeSetup(stateDirectory, host.port) });
    if (!result.suspended) process.exitCode = 1;
  } finally { host.close(); await runtime.close(); process.stdin.destroy(); }
}
void main().catch(() => { process.stderr.write("Pchat runtime startup or shutdown failed.\n"); process.exitCode = 1; process.stdin.destroy(); });
