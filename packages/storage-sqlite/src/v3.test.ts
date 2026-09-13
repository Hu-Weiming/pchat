import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { CommandReceipt, HarnessCommand, HarnessEvent, RoleRunProjection } from "@pchat/contracts";
import { createHarness } from "../../harness/src/index";
import { createConversation, waitForTurn } from "../../harness/test-support";
import { createTestDependencies, testRole, testSettings } from "../../testing/src/index";
import { openSqliteStore, type SqliteRuntimeStore } from "./index";

const devRoot = process.env.PCHAT_DEV_ROOT;
if (!devRoot || !isAbsolute(devRoot)) throw new Error("PCHAT_DEV_ROOT must be absolute");
const tempRoot = resolve(devRoot, "temp", "pchat");
mkdirSync(tempRoot, { recursive: true });
const directories: string[] = [];
const stores: SqliteRuntimeStore[] = [];
interface Archive {
  turns: Array<{ id: string; context: { history: unknown[]; participant: unknown }; roleRuns: Array<Pick<RoleRunProjection, "answer" | "evidence" | "attempts" | "textSoFar">> }>;
  commands: Array<{ receipt: CommandReceipt }>;
  events: HarnessEvent[];
}
const archive: Archive = JSON.parse(readFileSync(new URL("./fixtures/legacy-v2-state.json", import.meta.url), "utf8"));
function testOptions(seedLegacy = true) {
  const directory = mkdtempSync(join(tempRoot, "sqlite-v3-"));
  directories.push(directory);
  const options = { path: join(directory, "runtime.db"), backupDirectory: join(directory, "backups") };
  if (seedLegacy) {
    const old = new DatabaseSync(options.path);
    try { old.exec(readFileSync(new URL("./fixtures/legacy-v2.sql", import.meta.url), "utf8")); }
    finally { old.close(); }
  }
  return options;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error("Refusing cleanup outside test temporary directory");
    rmSync(target, { recursive: true, force: true });
  }
});

it("migrates real v2 history to per-role contexts without changing answers, evidence, attempts or receipts", async () => {
  const configuration = testOptions();
  const store = await openSqliteStore(configuration);
  stores.push(store);
  const state = await store.read((state) => state);
  expect(state.conversations[0]).toMatchObject({
    settings: { participantIds: ["test-role"] }, queueStatus: "PAUSED",
    questions: [
      { text: "A completed historical question", status: "COMPLETED", participants: [{ id: "test-role" }] },
      { text: "An uncertain historical question", status: "WAITING_USER", participants: [{ id: "test-role" }] },
      { text: "A question still in the queue", status: "QUEUED", participants: [{ id: "test-role" }] },
    ],
  });
  for (const historical of archive.turns) {
    const migrated = state.turns.find((turn) => turn.id === historical.id);
    expect(migrated).toMatchObject({ context: { settings: { participantIds: ["test-role"] }, participants: [historical.context.participant] }, comparison: null });
    expect(migrated?.context.history).toEqual(historical.context.history);
    expect(migrated?.roleRuns).toHaveLength(1);
    expect(migrated?.roleRuns[0]).toMatchObject(historical.roleRuns[0]!);
    expect(migrated?.roleRuns[0]).toMatchObject({ context: { participant: historical.context.participant, settings: { participantIds: ["test-role"] }, history: historical.context.history } });
  }
  expect(state.commands.map((command) => command.receipt)).toEqual(archive.commands.map((command) => command.receipt));
  expect(state.events).toEqual(archive.events);
  expect(state.lastEventSeq).toBe(22);
  const backups = readdirSync(configuration.backupDirectory).filter((name) => name.endsWith(".sqlite"));
  expect(backups).toHaveLength(1);
  const backup = new DatabaseSync(join(configuration.backupDirectory, backups[0]!), { readOnly: true });
  try { expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(2); }
  finally { backup.close(); }
});

it("replays equivalent current commands after upgrading and preserves rejected-command idempotency", async () => {
  const store = await openSqliteStore(testOptions());
  stores.push(store);
  const fakes = createTestDependencies();
  const harness = await createHarness({ ...fakes, store });
  const commands: HarnessCommand[] = [
    { type: "CreateConversation", commandId: "legacy-create", title: "Legacy single-role discussion", settings: testSettings },
    { type: "SubmitQuestion", commandId: "legacy-first", conversationId: "fake-1-1", text: "A completed historical question" },
    { type: "ChangeParticipants", commandId: "legacy-change", conversationId: "fake-1-1", participantIds: ["test-role"] },
    { type: "SubmitQuestion", commandId: "legacy-second", conversationId: "fake-1-1", text: "An uncertain historical question" },
    { type: "SubmitQuestion", commandId: "legacy-queued", conversationId: "fake-1-1", text: "A question still in the queue" },
    { type: "RegenerateRole", commandId: "legacy-regenerate", roleRunId: "fake-1-9" },
    { type: "SubmitQuestion", commandId: "legacy-rejected", conversationId: "missing", text: "Rejected historical question" },
  ];
  for (const command of commands) {
    const original = archive.commands.find((item) => item.receipt.commandId === command.commandId)?.receipt;
    expect(original).toBeDefined();
    expect(await harness.dispatch(command)).toEqual(original);
  }
  for (let tick = 0; tick < 100; tick++) await Promise.resolve();
  expect(await store.read((state) => state.commands)).toHaveLength(7);
  expect(await store.read((state) => state.turns)).toHaveLength(2);
  expect(fakes.rag.calls).toHaveLength(0);
  expect(fakes.model.calls).toHaveLength(0);
  const conflict = await harness.dispatch({ type: "SubmitQuestion", commandId: "legacy-rejected", conversationId: "missing", text: "A different request" });
  expect(conflict).toMatchObject({ ok: false, error: { code: "COMMAND_CONFLICT" } });
});

it("an unreadable legacy command stops migration with the old schema and backup intact", async () => {
  const configuration = testOptions();
  const old = new DatabaseSync(configuration.path);
  old.prepare("UPDATE command_receipts SET fingerprint = ? WHERE command_id = ?").run("not valid JSON", "legacy-create");
  old.close();
  await expect(openSqliteStore(configuration)).rejects.toThrow();
  const unchanged = new DatabaseSync(configuration.path);
  try {
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'role_contexts'").get()).toBeUndefined();
    expect(unchanged.prepare("SELECT count(*) AS count FROM command_receipts").get()?.count).toBe(7);
    expect(unchanged.prepare("SELECT status FROM external_attempts WHERE previous_attempt_id IS NOT NULL").get()?.status).toBe("OUTCOME_UNKNOWN");
    expect(readdirSync(configuration.backupDirectory).filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
  } finally { unchanged.close(); }
});

it("rejects broken foreign-key relationships in an already-current database", async () => {
  const configuration = testOptions();
  const initial = await openSqliteStore(configuration);
  initial.close();
  const corrupt = new DatabaseSync(configuration.path);
  corrupt.exec("PRAGMA foreign_keys = OFF; UPDATE questions SET conversation_id = 'missing-parent' WHERE id = 'fake-1-2'");
  corrupt.close();
  await expect(openSqliteStore(configuration)).rejects.toThrow("integrity");
  const repaired = new DatabaseSync(configuration.path);
  repaired.exec("UPDATE questions SET conversation_id = 'fake-1-1' WHERE id = 'fake-1-2'");
  repaired.close();
  const store = await openSqliteStore(configuration);
  stores.push(store);
  expect(await store.read((state) => state.conversations[0]?.questions)).toHaveLength(3);
});

it.each([2, 3])("persists %i independent role answers and their comparison across reopening", async (count) => {
  const configuration = testOptions(false);
  const roles = [testRole, { ...testRole, id: "second", label: "Second stage", corpusId: "corpus-two" },
    { ...testRole, id: "third", label: "Third stage", corpusId: "corpus-three" }].slice(0, count);
  const fakes = createTestDependencies({ roles });
  const store = await openSqliteStore(configuration);
  stores.push(store);
  const harness = await createHarness({ ...fakes, store });
  const conversationId = await createConversation(harness, "create", { ...testSettings, participantIds: roles.map((role) => role.id) });
  const command = { type: "SubmitQuestion", commandId: "shared-question", conversationId, text: "What supports each position?" } as const;
  const receipt = await harness.dispatch(command);
  const completed = await waitForTurn(harness, conversationId, "COMPLETED");
  expect(completed.roleRuns.map((role) => role.context.participant.corpusId)).toEqual(roles.map((role) => role.corpusId));
  expect(completed.roleRuns.map((role) => role.evidence[0]?.corpusId)).toEqual(roles.map((role) => role.corpusId));
  expect(completed.comparison?.columns.map((column) => column.participantId)).toEqual(roles.map((role) => role.id));
  store.close();
  const reopened = await openSqliteStore(configuration);
  stores.push(reopened);
  const recovered = await createHarness({ ...fakes, store: reopened });
  expect(await recovered.query({ type: "GetTurn", turnId: completed.id })).toMatchObject({ ok: true, data: completed });
  expect(await recovered.dispatch(command)).toEqual(receipt);
  expect(fakes.model.calls).toHaveLength(count);
  expect(await reopened.read((state) => state.conversations[0]?.questions)).toHaveLength(1);
});

it("stores pending roles and stops all members without dispatching their delayed work", async () => {
  const roles = [testRole, { ...testRole, id: "second", label: "Second stage", corpusId: "corpus-two" },
    { ...testRole, id: "third", label: "Third stage", corpusId: "corpus-three" }];
  const fakes = createTestDependencies({ roles });
  fakes.rag.holdNext();
  const store = await openSqliteStore(testOptions(false));
  stores.push(store);
  const harness = await createHarness({ ...fakes, store, limits: { ...fakes.limits, maxRoleRuns: 1, maxExternalCalls: 1 } });
  const conversationId = await createConversation(harness, "create", { ...testSettings, participantIds: roles.map((role) => role.id) });
  await harness.dispatch({ type: "SubmitQuestion", commandId: "question", conversationId, text: "Stop before the other roles begin" });
  const running = await waitForTurn(harness, conversationId, (turn) => turn.roleRuns[0]?.attempts[0]?.status === "IN_FLIGHT");
  expect(running.roleRuns.map((role) => role.status)).toEqual(["RETRIEVING", "PENDING", "PENDING"]);
  await harness.dispatch({ type: "StopTurn", commandId: "stop", turnId: running.id });
  fakes.rag.calls[0]?.complete();
  const stopped = await waitForTurn(harness, conversationId, "STOPPED");
  expect(stopped.roleRuns.map((role) => role.status)).toEqual(["STOPPED", "STOPPED", "STOPPED"]);
  expect(stopped.roleRuns.map((role) => role.attempts.length)).toEqual([1, 0, 0]);
  for (let tick = 0; tick < 100; tick++) await Promise.resolve();
  expect(fakes.rag.calls).toHaveLength(1);
  expect(fakes.model.calls).toHaveLength(0);
});
