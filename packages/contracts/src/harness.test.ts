import { describe, expect, it } from "vitest";
import { HarnessCommandSchema, HarnessEventSchema, HarnessQuerySchema, ConversationProjectionSchema, CommandReceiptSchema } from "./index";

describe("Harness command trust boundary", () => {
  it("accepts a JSON conversation command without platform or credential data", () => {
    const command = {
      type: "CreateConversation",
      commandId: "create-1",
      title: "A question about freedom",
      settings: {
        participantId: "kant-1785",
        knowledgeMode: "INFERENCE",
        model: { connectionId: "model-test", modelId: "fake", configRevision: "1" },
        ragConnectionId: "rag-test",
      },
    };
    expect(HarnessCommandSchema.parse(JSON.parse(JSON.stringify(command)))).toEqual(command);
  });

  it("validates queued questions and rejects unknown credential fields", () => {
    const command = { type: "SubmitQuestion", commandId: "submit-1", conversationId: "conversation-1", text: "What is freedom?" };
    expect(HarnessCommandSchema.parse(command)).toEqual(command);
    expect(HarnessCommandSchema.safeParse({ ...command, text: " " }).success).toBe(false);
    expect(HarnessCommandSchema.safeParse({ ...command, apiKey: "not-a-secret" }).success).toBe(false);
  });

  it("keeps stopping, queue resumption, regeneration and host suspension distinct", () => {
    for (const command of [
      { type: "StopTurn", commandId: "s", turnId: "t" },
      { type: "ResumeQueue", commandId: "r", conversationId: "c" },
      { type: "RegenerateRole", commandId: "g", roleRunId: "r" },
      { type: "SuspendRuntime", commandId: "suspend" },
      { type: "WithdrawQuestion", commandId: "w", questionId: "q" },
    ]) expect(HarnessCommandSchema.parse(command)).toEqual(command);
    expect(HarnessCommandSchema.safeParse({ type: "RegenerateRole", commandId: "g", turnId: "t" }).success).toBe(false);
  });

  it("validates read projections, command failures and safe event bookmarks", () => {
    expect(HarnessQuerySchema.parse({ type: "GetConversation", conversationId: "c" })).toEqual({ type: "GetConversation", conversationId: "c" });
    const snapshot = { id: "c", title: "A discussion", queueStatus: "RUNNING", activeTurnId: null, questions: [], turnIds: [], settings: {
      participantId: "kant-1785", knowledgeMode: "INFERENCE", model: { connectionId: "model-test", modelId: "fake", configRevision: "1" }, ragConnectionId: "rag-test",
    } };
    expect(ConversationProjectionSchema.parse(snapshot)).toEqual(snapshot);
    expect(CommandReceiptSchema.parse({ ok: false, commandId: "bad", lastEventSeq: 0, error: { code: "INVALID_TRANSITION", message: "This action is not valid in the current state." } }).ok).toBe(false);
    const event = { type: "ConversationCreated", seq: 1, at: 0, conversationId: "c" };
    expect(HarnessEventSchema.parse(event)).toEqual(event);
    expect(HarnessEventSchema.safeParse({ ...event, seq: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
});
