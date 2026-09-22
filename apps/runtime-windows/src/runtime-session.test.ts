import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { createHarness } from "../../../packages/harness/src/index";
import { createTestDependencies, testSettings } from "../../../packages/testing/src/index";
import { runRuntimeSession } from "./runtime-session";
import { createConversation, until } from "../../../packages/harness/test-support";
import type { PchatClient } from "@pchat/client";
import type { QueryMap } from "@pchat/contracts";

it("serves fragmented UTF-8 requests and commits suspension before acknowledging shutdown", async () => {
  const deps = createTestDependencies();
  const harness = await createHarness(deps);
  const input = new PassThrough();
  const output = new PassThrough();
  let received = "";
  output.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
  const running = runRuntimeSession({ harness, input, output, nextId: () => deps.ids.next() });
  const command = Buffer.from(JSON.stringify({ protocolVersion: 2, requestId: "host-create", method: "harness.request", params: {
    protocolVersion: 3, requestId: "client-create", type: "command", command: { type: "CreateConversation", commandId: "create", title: "自由的意义", settings: testSettings },
  } }) + "\n");
  for (let index = 0; index < command.length; index += 7) input.write(command.subarray(index, index + 7));
  await expect.poll(() => received).toContain('"requestId":"host-create"');
  input.write(JSON.stringify({ protocolVersion: 2, requestId: "exit", method: "runtime.shutdown", params: {} }) + "\n");
  expect(await running).toEqual({ reason: "SHUTDOWN", suspended: true });
  expect(await deps.store.read((state) => state.suspended)).toBe(true);
  const messages: unknown[] = received.trim().split("\n").map((line) => JSON.parse(line));
  expect(messages[0]).toMatchObject({ kind: "runtime.ready", protocolVersion: 2 });
  expect(messages.at(-1)).toMatchObject({ kind: "runtime.response", protocolVersion: 2, requestId: "exit", ok: true, result: { suspended: true } });
  expect(await harness.query({ type: "ListConversations" })).toMatchObject({ ok: true, data: [{ title: "自由的意义" }] });
});

it("suspends on host pipe loss and keeps possibly delivered calls unknown", async () => {
  const deps = createTestDependencies();
  deps.rag.holdNext();
  const harness = await createHarness(deps);
  const conversationId = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "question", conversationId, text: "自由是什么？" });
  await until(() => deps.rag.calls.length === 1);
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const running = runRuntimeSession({ harness, input, output, nextId: () => deps.ids.next() });
  input.end();
  expect(await running).toEqual({ reason: "INPUT_CLOSED", suspended: true });
  const conversation = await harness.query({ type: "GetConversation", conversationId });
  expect(conversation).toMatchObject({ ok: true, data: { queueStatus: "PAUSED", questions: [{ status: "WAITING_USER" }] } });
  if (!conversation.ok) throw new Error("missing conversation");
  expect(await harness.query({ type: "GetTurn", turnId: conversation.data.turnIds[0]! })).toMatchObject({ ok: true, data: {
    roleRuns: [{ status: "WAITING_USER", attempts: [{ status: "OUTCOME_UNKNOWN" }] }],
  } });
});

it("bounds an unterminated input frame and suspends instead of accumulating arbitrary bytes", async () => {
  const deps = createTestDependencies();
  const harness = await createHarness(deps);
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const running = runRuntimeSession({ harness, input, output, nextId: () => deps.ids.next() });
  input.write(Buffer.alloc(1_048_577, 120));
  let finished = false;
  void running.then(() => { finished = true; });
  try {
    await expect.poll(() => finished, { timeout: 200 }).toBe(true);
    expect(await running).toEqual({ reason: "INVALID_FRAME", suspended: true });
  } finally { input.end(); await running; }
});

it("limits outstanding requests while allowing suspension to pass a delayed query", async () => {
  const deps = createTestDependencies();
  const harness = await createHarness(deps);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const delayed: PchatClient = { ...harness, async query<K extends keyof QueryMap>(query: QueryMap[K]["request"] & { type: K }) { await held; return harness.query<K>(query); } };
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const running = runRuntimeSession({ harness: delayed, input, output, nextId: () => deps.ids.next() });
  for (let index = 0; index < 65; index++) input.write(JSON.stringify({ protocolVersion: 2, requestId: `host-${index}`, method: "harness.request", params: {
    protocolVersion: 3, requestId: `client-${index}`, type: "query", query: { type: "ListConversations" },
  } }) + "\n");
  try {
    await expect.poll(() => deps.store.read((state) => state.suspended), { timeout: 200 }).toBe(true);
    release();
    expect(await running).toEqual({ reason: "INVALID_FRAME", suspended: true });
  } finally { input.end(); release(); await running; }
});

it("does not acknowledge a shutdown that failed to commit", async () => {
  const deps = createTestDependencies();
  const harness = await createHarness(deps);
  const unavailable: PchatClient = { ...harness, async dispatch(command) {
    if (command.type === "SuspendRuntime") throw new Error("private storage path and credential must not escape");
    return harness.dispatch(command);
  } };
  const input = new PassThrough();
  const output = new PassThrough();
  let received = "";
  output.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
  const running = runRuntimeSession({ harness: unavailable, input, output, nextId: () => deps.ids.next() });
  input.write(JSON.stringify({ protocolVersion: 2, requestId: "exit", method: "runtime.shutdown", params: {} }) + "\n");
  expect(await running).toEqual({ reason: "SHUTDOWN", suspended: false });
  expect(JSON.parse(received.trim().split("\n").at(-1)!)).toEqual({ kind: "runtime.response", protocolVersion: 2, requestId: "exit", ok: false, error: "RUNTIME_UNAVAILABLE" });
  expect(received).not.toContain("private storage");
});

it.each([Buffer.from([0xff, 10]), Buffer.from('{"partial":')])("rejects malformed UTF-8 or a truncated final frame without leaking its contents", async (frame) => {
  const deps = createTestDependencies();
  const harness = await createHarness(deps);
  const input = new PassThrough();
  const output = new PassThrough();
  let received = "";
  output.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
  const running = runRuntimeSession({ harness, input, output, nextId: () => deps.ids.next() });
  input.end(frame);
  expect(await running).toEqual({ reason: "INVALID_FRAME", suspended: true });
  expect(received.trim().split("\n")).toHaveLength(1);
});
