import { describe, expect, it } from "vitest";
import { createHarness } from "./index";
import { createTestDependencies, testRole, testSettings } from "../../testing/src/index";
import { createConversation } from "../test-support";

describe("catalog and conversation settings projections", () => {
  it("shows confirmed and draft thought-stage packages without allowing draft execution", async () => {
    const draft = { ...testRole, id: "draft-role", status: "DRAFT" as const };
    const harness = await createHarness(createTestDependencies({ roles: [testRole, draft] }));
    expect(await harness.query({ type: "ListRoles" })).toMatchObject({ ok: true, data: [testRole, draft], lastEventSeq: 0 });
    expect(await harness.dispatch({ type: "CreateConversation", commandId: "draft", title: "Draft", settings: { ...testSettings, participantId: draft.id } }))
      .toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("projects current settings while keeping an earlier query snapshot unchanged", async () => {
    const next = { ...testRole, id: "second-role", corpusId: "second-corpus" };
    const harness = await createHarness(createTestDependencies({ roles: [testRole, next] }));
    const conversationId = await createConversation(harness);
    const before = await harness.query({ type: "GetConversation", conversationId });
    expect(before).toMatchObject({ ok: true, data: { settings: testSettings } });
    await harness.dispatch({ type: "ChangeParticipants", commandId: "change", conversationId, participantId: next.id });
    expect(await harness.query({ type: "GetConversation", conversationId }))
      .toMatchObject({ ok: true, data: { settings: { ...testSettings, participantId: next.id } } });
    expect(before).toMatchObject({ ok: true, data: { settings: testSettings } });
  });
});
