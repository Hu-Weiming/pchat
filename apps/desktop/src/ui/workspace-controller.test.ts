import { expect, it } from "vitest";
import { createHarness } from "../../../../packages/harness/src/index";
import { createConversation, until, waitForTurn } from "../../../../packages/harness/test-support";
import { createTestDependencies } from "../../../../packages/testing/src/index";
import { createWorkspaceController } from "./workspace-controller";
import type { PchatClient } from "@pchat/client";
import type { QueryMap, QueryResult } from "@pchat/contracts";

it("reads the conversation and role projections before showing a ready workspace", async () => {
  const harness = await createHarness(createTestDependencies());
  const conversationId = await createConversation(harness);
  const controller = createWorkspaceController(harness, () => "ui-command");
  try {
    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", selectedConversationId: conversationId,
      conversations: [{ id: conversationId }], roles: [{ id: "test-role", status: "CONFIRMED" }], turns: [] });
  } finally { controller.stop(); }
});

it("replays changes committed between the initial query and event subscription", async () => {
  const harness = await createHarness(createTestDependencies());
  const bookmarks: Array<number | undefined> = [];
  let injected = false;
  const client: PchatClient = {
    ...harness,
    async query<K extends keyof QueryMap>(request: QueryMap[K]["request"] & { type: K }): Promise<QueryResult<QueryMap[K]["response"]>> {
      const result = await harness.query<K>(request);
      if (request.type === "ListConversations" && !injected) { injected = true; await createConversation(harness); }
      return result;
    },
    events(after) { bookmarks.push(after); return harness.events(after); },
  };
  const controller = createWorkspaceController(client, () => "ui-command");
  try {
    await controller.start();
    await until(() => controller.getSnapshot().conversations.length === 1);
    expect(bookmarks).toEqual([0]);
    expect(controller.getSnapshot().status).toBe("ready");
  } finally { controller.stop(); }
});

it("does not let a late conversation query overwrite a newer selection", async () => {
  const harness = await createHarness(createTestDependencies());
  const first = await createConversation(harness, "first");
  const second = await createConversation(harness, "second");
  await harness.dispatch({ type: "SubmitQuestion", commandId: "a", conversationId: first, text: "First discussion" });
  await harness.dispatch({ type: "SubmitQuestion", commandId: "b", conversationId: second, text: "Second discussion" });
  const firstTurn = await waitForTurn(harness, first, "COMPLETED");
  await waitForTurn(harness, second, "COMPLETED");
  let held = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client: PchatClient = { ...harness, async query<K extends keyof QueryMap>(request: QueryMap[K]["request"] & { type: K }): Promise<QueryResult<QueryMap[K]["response"]>> {
    const result = await harness.query<K>(request);
    if (request.type === "GetTurn" && "turnId" in request && request.turnId === firstTurn.id && !held) { held = true; await gate; }
    return result;
  } };
  const controller = createWorkspaceController(client, () => "ui-command");
  try {
    const ready = controller.start();
    await until(() => held);
    controller.selectConversation(second);
    release();
    await ready;
    expect(controller.getSnapshot()).toMatchObject({ selectedConversationId: second, turns: [{ context: { question: { text: "Second discussion" } } }] });
  } finally { release(); controller.stop(); }
});

it("keeps an uncertain command identity for explicit retry without submitting a second question", async () => {
  const fakes = createTestDependencies();
  const harness = await createHarness(fakes);
  const conversationId = await createConversation(harness);
  const sentIds: string[] = [];
  const client: PchatClient = { ...harness, async dispatch(command) {
    sentIds.push(command.commandId);
    const receipt = await harness.dispatch(command);
    if (sentIds.length === 1) throw new Error("untrusted provider detail must never appear in the view");
    return receipt;
  } };
  let next = 0;
  const controller = createWorkspaceController(client, () => `ui-${++next}`);
  try {
    await controller.start();
    await controller.execute({ type: "SubmitQuestion", conversationId, text: "Submit only once" });
    expect(controller.getSnapshot()).toMatchObject({ busy: false, pendingCommand: { commandId: "ui-1" } });
    expect(controller.getSnapshot().error).not.toContain("untrusted provider");
    await controller.retryPending();
    expect(sentIds).toEqual(["ui-1", "ui-1"]);
    expect(controller.getSnapshot()).toMatchObject({ busy: false, pendingCommand: null });
    await waitForTurn(harness, conversationId, "COMPLETED");
    expect(fakes.model.calls).toHaveLength(1);
    expect(controller.getSnapshot().conversations[0]?.questions).toHaveLength(1);
  } finally { controller.stop(); }
});
