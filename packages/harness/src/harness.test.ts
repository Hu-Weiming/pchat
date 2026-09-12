import { describe, expect, it } from "vitest";
import { createHarness } from "./index";
import { createTestDependencies, testSettings } from "../../testing/src/index";
import { createConversation, waitForTurn } from "../test-support";

describe("PchatHarness", () => {
  it("creates a conversation retrievable through the same public interface", async () => {
    const harness = await createHarness(createTestDependencies());
    const receipt = await harness.dispatch({ type: "CreateConversation", commandId: "create-1", title: "Freedom", settings: testSettings });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok || !receipt.conversationId) throw new Error("Expected a conversation receipt");
    const result = await harness.query({ type: "GetConversation", conversationId: receipt.conversationId });
    expect(result).toMatchObject({ ok: true, data: { title: "Freedom", questions: [], activeTurnId: null }, lastEventSeq: 1 });
  });

  it("completes a single-role turn with frozen evidence and an auditable external attempt", async () => {
    const harness = await createHarness(createTestDependencies());
    const conversationId = await createConversation(harness);
    expect(await harness.dispatch({ type: "SubmitQuestion", commandId: "submit-1", conversationId, text: "What is freedom?" })).toMatchObject({ ok: true });
    const turn = await waitForTurn(harness, conversationId, "COMPLETED");
    expect(turn.context.question.text).toBe("What is freedom?");
    expect(turn.context.history).toEqual([]);
    expect(turn.roleRuns[0]?.answer).toMatchObject({ kind: "PARAPHRASE", evidenceIds: ["test-evidence"] });
    expect(turn.roleRuns[0]?.evidence[0]?.text).toBe("A test passage about freedom.");
    expect(turn.roleRuns[0]?.attempts.map((attempt) => [attempt.kind, attempt.status])).toEqual([["RAG", "SUCCEEDED"], ["MODEL", "SUCCEEDED"]]);
  });
});
