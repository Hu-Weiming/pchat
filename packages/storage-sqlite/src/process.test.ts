import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { createHarness } from "../../harness/src/index";
import { waitForTurn } from "../../harness/test-support";
import { createTestDependencies } from "../../testing/src/index";
import { openSqliteStore } from "./index";

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { reject(new Error("Child did not exit after termination")); }, 10000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

it("recovers acknowledged questions and unknown attempts after a real Runtime process is killed", async () => {
  const devRoot = process.env.PCHAT_DEV_ROOT;
  if (!devRoot || !isAbsolute(devRoot)) throw new Error("PCHAT_DEV_ROOT must be absolute");
  const tempRoot = resolve(devRoot, "temp", "pchat");
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, "sqlite-process-"));
  const configuration = { path: join(directory, "runtime.db"), backupDirectory: join(directory, "backups") };
  let child: ChildProcess | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const entry = join(directory, "runtime.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("./fixtures/interrupted-runtime.ts", import.meta.url))], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
    child = spawn(process.execPath, [entry, configuration.path, configuration.backupDirectory], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const message = await new Promise<{ conversationId: string; receipt: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`Child did not acknowledge its checkpoint: ${stderr}`)); }, 10000);
      child!.once("error", (error) => { clearTimeout(timer); reject(error); });
      child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Child exited before checkpoint (${code}): ${stderr}`)); });
      child!.once("message", (value: unknown) => {
        clearTimeout(timer);
        if (!value || typeof value !== "object" || !("conversationId" in value) || typeof value.conversationId !== "string" || !("receipt" in value)) {
          reject(new Error("Invalid child acknowledgement")); return;
        }
        resolve({ conversationId: value.conversationId, receipt: value.receipt });
      });
    });
    await expect(openSqliteStore(configuration)).rejects.toThrow("owned");
    const exited = waitForExit(child);
    expect(child.kill("SIGKILL")).toBe(true);
    await exited;
    store = await openSqliteStore(configuration);
    const fakes = createTestDependencies();
    const harness = await createHarness({ ...fakes, store, ids: { next: randomUUID } });
    const conversation = await harness.query({ type: "GetConversation", conversationId: message.conversationId });
    expect(conversation.ok).toBe(true);
    if (!conversation.ok) throw new Error("Recovered conversation missing");
    expect(conversation.data.queueStatus).toBe("PAUSED");
    expect(conversation.data.questions.map((question) => [question.text, question.status])).toEqual([
      ["First question", "WAITING_USER"], ["Second question", "QUEUED"],
    ]);
    const turnId = conversation.data.turnIds[0];
    if (!turnId) throw new Error("Recovered turn missing");
    const turn = await harness.query({ type: "GetTurn", turnId });
    expect(turn.ok).toBe(true);
    if (!turn.ok) throw new Error("Recovered turn missing");
    expect(turn.data.roleRuns[0]?.attempts.map((attempt) => attempt.status)).toEqual(["SUCCEEDED", "OUTCOME_UNKNOWN"]);
    expect(turn.data.roleRuns[0]?.textSoFar).toBe("Saved before forced termination");
    expect(await harness.dispatch({ type: "SubmitQuestion", commandId: "first", conversationId: message.conversationId, text: "First question" })).toEqual(message.receipt);
    for (let tick = 0; tick < 100; tick++) await Promise.resolve();
    expect(fakes.model.calls).toHaveLength(0);
    expect(fakes.rag.calls).toHaveLength(0);
    const role = turn.data.roleRuns[0];
    if (!role) throw new Error("Recovered role missing");
    const unknownAttempt = role.attempts.at(-1);
    expect((await harness.dispatch({ type: "RegenerateRole", commandId: "regenerate", roleRunId: role.id })).ok).toBe(true);
    const regenerated = await waitForTurn(harness, message.conversationId, "COMPLETED");
    expect(regenerated.roleRuns[0]?.attempts.map((attempt) => attempt.status)).toEqual(["SUCCEEDED", "OUTCOME_UNKNOWN", "SUCCEEDED"]);
    expect(regenerated.roleRuns[0]?.attempts.at(-1)?.previousAttemptId).toBe(unknownAttempt?.id);
    expect(regenerated.roleRuns[0]?.attempts.at(-1)?.id).not.toBe(unknownAttempt?.id);
    expect(fakes.rag.calls).toHaveLength(0);
    const stillPaused = await harness.query({ type: "GetConversation", conversationId: message.conversationId });
    expect(stillPaused.ok && stillPaused.data.queueStatus).toBe("PAUSED");
    await harness.dispatch({ type: "ResumeQueue", commandId: "resume", conversationId: message.conversationId });
    await waitForTurn(harness, message.conversationId, "COMPLETED", 1);
  } finally {
    store?.close();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = waitForExit(child); child.kill("SIGKILL"); await exited; }
    const target = resolve(directory);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error("Refusing cleanup outside test temporary directory");
    rmSync(target, { recursive: true, force: true });
  }
}, 20000);
