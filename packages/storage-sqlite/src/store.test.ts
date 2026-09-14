import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openSqliteStore as openActual, type SqliteRuntimeStore } from "./index";
import { createHarness } from "../../harness/src/index";
import { createConversation, waitForTurn } from "../../harness/test-support";
import { createTestDependencies, testEvidence } from "../../testing/src/index";

const directories: string[] = [];
const stores: SqliteRuntimeStore[] = [];
async function openSqliteStore(configuration: Parameters<typeof openActual>[0]) {
  const store = await openActual(configuration);
  stores.push(store);
  return store;
}
const devRoot = process.env.PCHAT_DEV_ROOT;
if (!devRoot || !isAbsolute(devRoot)) throw new Error("PCHAT_DEV_ROOT must be absolute");
const tempRoot = resolve(devRoot, "temp", "pchat");
mkdirSync(tempRoot, { recursive: true });
function options() {
  const directory = mkdtempSync(join(tempRoot, "sqlite-store-"));
  directories.push(directory);
  return { path: join(directory, "runtime.db"), backupDirectory: join(directory, "backups") };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error("Refusing cleanup outside test temporary directory");
    rmSync(target, { recursive: true, force: true });
  }
});

it("preserves committed runtime state after closing and reopening", async () => {
  const configuration = options();
  const store = await openSqliteStore(configuration);
  await store.transaction((state) => { state.epoch = 7; state.suspended = true; });
  store.close();
  const reopened = await openSqliteStore(configuration);
  try {
    expect(await reopened.read((state) => state)).toEqual({
      epoch: 7, suspended: true, lastEventSeq: 0,
      conversations: [], turns: [], commands: [], events: [],
    });
  } finally { reopened.close(); }
});

it("reopens a complete Harness turn with its evidence, attempts, receipt and event bookmark", async () => {
  const configuration = options();
  const store = await openSqliteStore(configuration);
  const fakes = createTestDependencies();
  const harness = await createHarness({ ...fakes, store });
  const conversationId = await createConversation(harness);
  const command = { type: "SubmitQuestion", commandId: "question", conversationId, text: "What is freedom?" } as const;
  const receipt = await harness.dispatch(command);
  expect(receipt.ok).toBe(true);
  const completed = await waitForTurn(harness, conversationId, "COMPLETED");
  const bookmark = await harness.query({ type: "GetTurn", turnId: completed.id });
  store.close();
  const reopened = await openSqliteStore(configuration);
  try {
    const recovered = await createHarness({ ...fakes, store: reopened });
    expect(await recovered.dispatch(command)).toEqual(receipt);
    expect(await recovered.query({ type: "GetTurn", turnId: completed.id })).toEqual(bookmark);
    expect(completed.roleRuns[0]?.evidence).toEqual([testEvidence]);
    expect(completed.roleRuns[0]?.attempts.map((attempt) => attempt.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(fakes.model.calls).toHaveLength(1);
    expect(await reopened.read((state) => state.events.at(-1)?.seq)).toBe(bookmark.lastEventSeq);
  } finally { reopened.close(); }
});

it("persists the actual model input and budget separately from the streaming draft", async () => {
  const configuration = options();
  const store = await openSqliteStore(configuration);
  const fakes = createTestDependencies();
  const harness = await createHarness({ ...fakes, store });
  const conversationId = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "input", conversationId, text: "Auditable input" });
  const complete = await waitForTurn(harness, conversationId, "COMPLETED");
  const input = fakes.model.calls[0]!.request.input;
  expect(input).toBeDefined();
  expect(complete.roleRuns[0]!.attempts.at(-1)?.input).toEqual(input);
  store.close();
  const reopened = await openSqliteStore(configuration);
  const recovered = await createHarness({ ...fakes, store: reopened });
  expect(await recovered.query({ type: "GetTurn", turnId: complete.id })).toMatchObject({ ok: true, data: complete });
  expect(fakes.model.calls).toHaveLength(1);
});

it("rejects asynchronous writers without committing or publishing them", async () => {
  const store = await openSqliteStore(options());
  try {
    const notices: number[] = [];
    store.subscribe((notice) => { notices.push(notice.epoch); });
    await expect(store.transaction(async (state) => {
      state.epoch = 9;
      await Promise.resolve();
      throw new Error("late writer rejection");
    })).rejects.toThrow("synchronous");
    expect(await store.read((state) => state.epoch)).toBe(0);
    expect(notices).toEqual([0]);
  } finally { store.close(); }
});

it("isolates state, rolls back failed writers, and publishes commits before acknowledging them", async () => {
  const store = await openSqliteStore(options());
  try {
    const notices: string[] = [];
    store.subscribe(() => { throw new Error("broken subscriber"); });
    const unsubscribe = store.subscribe((notice) => { notices.push(`commit:${notice.epoch}`); });
    let captured = () => {};
    const written = store.transaction((state) => { state.epoch = 3; captured = () => { state.epoch = 99; }; return state; });
    expect(notices).toEqual(["commit:0", "commit:3"]);
    const result = await written;
    result.epoch = 100;
    captured();
    const readResult = await store.read((state) => state);
    readResult.turns.length = 3;
    await expect(store.transaction((state) => { state.epoch = 4; throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await store.read((state) => ({ epoch: state.epoch, turns: state.turns }))).toEqual({ epoch: 3, turns: [] });
    expect(notices).toEqual(["commit:0", "commit:3"]);
    unsubscribe();
    expect(await Promise.all([store.transaction((state) => ++state.epoch), store.transaction((state) => ++state.epoch)])).toEqual([4, 5]);
    expect(notices).toHaveLength(2);
  } finally { store.close(); }
});

it("closing revokes execution permissions and rejects further subscriptions", async () => {
  const store = await openSqliteStore(options());
  const notices: boolean[] = [];
  store.subscribe((notice) => { notices.push(notice.suspended); });
  store.close();
  expect(notices).toEqual([false, true]);
  expect(() => store.subscribe(() => {})).toThrow("closed");
  await expect(store.transaction((state) => { state.epoch++; })).rejects.toThrow("closed");
  expect(() => store.close()).not.toThrow();
});

it("allows only one Runtime owner until the owner closes", async () => {
  const configuration = options();
  const owner = await openSqliteStore(configuration);
  let accidental: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await expect(openSqliteStore(configuration).then((value) => { accidental = value; return "opened"; })).rejects.toThrow("owned");
  } finally { accidental?.close(); owner.close(); }
  const successor = await openSqliteStore(configuration);
  successor.close();
});

it("rolls back all state and receipts when a database constraint rejects a commit", async () => {
  const store = await openSqliteStore(options());
  try {
    const notices: number[] = [];
    store.subscribe((notice) => { notices.push(notice.epoch); });
    await expect(store.transaction((state) => {
      state.epoch = 6;
      state.commands.push(
        { fingerprint: "first", receipt: { ok: true, commandId: "duplicate", lastEventSeq: 0 } },
        { fingerprint: "second", receipt: { ok: true, commandId: "duplicate", lastEventSeq: 0 } },
      );
    })).rejects.toThrow();
    expect(await store.read((state) => ({ epoch: state.epoch, commands: state.commands }))).toEqual({ epoch: 0, commands: [] });
    expect(notices).toEqual([0]);
    expect(await store.transaction((state) => ++state.epoch)).toBe(1);
  } finally { store.close(); }
});

it("executes queued questions in FIFO with frozen contexts on SQLite", async () => {
  const store = await openSqliteStore(options());
  const fakes = createTestDependencies();
  fakes.model.holdNext();
  const harness = await createHarness({ ...fakes, store });
  const conversationId = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "a", conversationId, text: "Question A" });
  await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[0]?.attempts.at(-1)?.kind === "MODEL");
  await harness.dispatch({ type: "SubmitQuestion", commandId: "b", conversationId, text: "Question B" });
  await harness.dispatch({ type: "SubmitQuestion", commandId: "c", conversationId, text: "Question C" });
  expect(fakes.model.calls).toHaveLength(1);
  expect(fakes.model.calls[0]?.request.context.question.text).toBe("Question A");
  expect(fakes.model.calls[0]?.request.context.history).toEqual([]);
  fakes.model.calls[0]?.complete();
  await waitForTurn(harness, conversationId, "COMPLETED", 2);
  expect(fakes.model.calls.map((call) => call.request.context.question.text)).toEqual(["Question A", "Question B", "Question C"]);
  expect(fakes.model.calls.map((call) => call.request.context.history.map((history) => history.question))).toEqual([
    [], ["Question A"], ["Question A", "Question B"],
  ]);
});

it("persists stop and resume without losing bookmarked events or accepting late provider output", async () => {
  const store = await openSqliteStore(options());
  const fakes = createTestDependencies();
  fakes.model.holdNext();
  const harness = await createHarness({ ...fakes, store });
  const conversationId = await createConversation(harness);
  await harness.dispatch({ type: "SubmitQuestion", commandId: "a", conversationId, text: "Question A" });
  const running = await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[0]?.attempts.at(-1)?.status === "IN_FLIGHT" && turn.roleRuns[0]?.attempts.at(-1)?.kind === "MODEL");
  await harness.dispatch({ type: "SubmitQuestion", commandId: "b", conversationId, text: "Question B" });
  const snapshot = await harness.query({ type: "GetConversation", conversationId });
  await harness.dispatch({ type: "StopTurn", commandId: "stop", turnId: running.id });
  const events = harness.events(snapshot.lastEventSeq)[Symbol.asyncIterator]();
  try {
    const stop = await waitForTurn(harness, conversationId, "STOPPED");
    expect(stop.roleRuns[0]?.attempts.at(-1)?.status).toBe("OUTCOME_UNKNOWN");
    expect(fakes.model.calls[0]?.cancellation.cancelled).toBe(true);
    fakes.model.calls[0]?.delta("Forbidden late text");
    fakes.model.calls[0]?.complete();
    const first = await events.next();
    expect(first.value?.seq).toBe(snapshot.lastEventSeq + 1);
    const paused = await harness.query({ type: "GetConversation", conversationId });
    expect(paused.ok && paused.data.queueStatus).toBe("PAUSED");
    await harness.dispatch({ type: "ResumeQueue", commandId: "resume", conversationId });
    await waitForTurn(harness, conversationId, "COMPLETED", 1);
    const stillStopped = await harness.query({ type: "GetTurn", turnId: running.id });
    expect(stillStopped.ok && stillStopped.data.status).toBe("STOPPED");
    expect(stillStopped.ok && stillStopped.data.roleRuns[0]?.textSoFar).not.toContain("Forbidden late text");
    expect(fakes.model.calls.map((call) => call.request.context.question.text)).toEqual(["Question A", "Question B"]);
  } finally { await events.return?.(); }
});

it("checkpoints a new draft without rewriting the stored discussion history", async () => {
  const configuration = options();
  const store = await openSqliteStore(configuration);
  const fakes = createTestDependencies();
  const harness = await createHarness({ ...fakes, store });
  const conversationId = await createConversation(harness);
  for (let index = 0; index < 12; index++) {
    await harness.dispatch({ type: "SubmitQuestion", commandId: `history-${index}`, conversationId, text: `Question ${index}: ${"a".repeat(8000)}` });
    await waitForTurn(harness, conversationId, "COMPLETED", index);
  }
  fakes.model.holdNext();
  await harness.dispatch({ type: "SubmitQuestion", commandId: "current", conversationId, text: "Current question" });
  await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[0]?.attempts.at(-1)?.kind === "MODEL", 12);
  const historyReader = new DatabaseSync(configuration.path, { readOnly: true });
  try {
    // A real long-lived history reader prevents WAL reuse, so growth measures
    // writes across checkpoints rather than a previously allocated file size.
    historyReader.exec("BEGIN");
    historyReader.prepare("SELECT count(*) FROM questions").get();
    const before = statSync(`${configuration.path}-wal`).size;
    for (let checkpoint = 0; checkpoint < 16; checkpoint++) {
      await store.transaction((state) => {
        const role = state.turns.at(-1)?.roleRuns[0];
        if (!role) throw new Error("Current role missing");
        role.textSoFar += "small checkpoint ";
        role.revision++;
      });
    }
    const writtenBytes = statSync(`${configuration.path}-wal`).size - before;
    expect(writtenBytes).toBeLessThan(1024 * 1024);
    expect(await store.read((state) => state.turns.at(-1)?.roleRuns[0]?.textSoFar)).toBe("small checkpoint ".repeat(16));
    expect(await store.read((state) => state.conversations[0]?.questions)).toHaveLength(13);
  } finally { historyReader.close(); }
}, 20000);
