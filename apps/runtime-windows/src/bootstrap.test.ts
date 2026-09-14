import { mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import { createTestDependencies } from "../../../packages/testing/src/index";
import { createConversation, waitForTurn } from "../../../packages/harness/test-support";
import { openWindowsRuntime } from "./bootstrap";

it("composes injected ports with durable SQLite and reopens the same completed turn and receipt", async () => {
  const root = process.env.PCHAT_DEV_ROOT;
  if (!root || !isAbsolute(root)) throw new Error("PCHAT_DEV_ROOT required");
  const parent = join(root, "temp", "pchat");
  const stateDirectory = mkdtempSync(join(parent, "runtime-bootstrap-"));
  const dependencies = createTestDependencies();
  let runtime: Awaited<ReturnType<typeof openWindowsRuntime>> | undefined;
  try {
    runtime = await openWindowsRuntime({ stateDirectory, dependencies });
    const conversationId = await createConversation(runtime.harness);
    const command = { type: "SubmitQuestion" as const, commandId: "question", conversationId, text: "自由是什么？" };
    const receipt = await runtime.harness.dispatch(command);
    const turn = await waitForTurn(runtime.harness, conversationId, "COMPLETED");
    await runtime.close();
    const reopened = createTestDependencies();
    runtime = await openWindowsRuntime({ stateDirectory, dependencies: reopened });
    expect(await runtime.harness.dispatch(command)).toEqual(receipt);
    expect(await runtime.harness.query({ type: "GetTurn", turnId: turn.id })).toMatchObject({ ok: true, data: turn });
    expect(reopened.model.calls).toHaveLength(0);
    expect(reopened.rag.calls).toHaveLength(0);
  } finally {
    await runtime?.close();
    const target = resolve(stateDirectory);
    const within = relative(resolve(parent), target);
    if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Unsafe cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});
