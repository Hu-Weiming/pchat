import type { ConversationSettings, TurnProjection } from "@pchat/contracts";
import type { PchatHarness } from "./src/index";
import { testSettings } from "../testing/src/index";

export async function createConversation(harness: PchatHarness, commandId = "create", settings: ConversationSettings = testSettings) {
  const receipt = await harness.dispatch({ type: "CreateConversation", commandId, title: "Freedom", settings });
  if (!receipt.ok || !receipt.conversationId) throw new Error(JSON.stringify(receipt));
  return receipt.conversationId;
}

export async function waitForTurn(harness: PchatHarness, conversationId: string, status: string | ((turn: TurnProjection) => boolean), index = 0) {
  for (let tries = 0; tries < 500; tries++) {
    const conversation = await harness.query({ type: "GetConversation", conversationId });
    if (!conversation.ok) throw new Error(JSON.stringify(conversation));
    const turnId = conversation.data.turnIds[index];
    if (turnId) {
      const turn = await harness.query({ type: "GetTurn", turnId });
      if (turn.ok && (typeof status === "string" ? turn.data.status === status : status(turn.data))) return turn.data;
    }
  }
  throw new Error(`Turn did not reach ${status}`);
}

export async function until(predicate: () => boolean) {
  for (let tries = 0; tries < 1_000; tries++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Expected operation was not observed");
}
