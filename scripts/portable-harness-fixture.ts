import { createHarness } from "../packages/harness/src/index";
import { createTestDependencies, testSettings } from "../packages/testing/src/index";

/** Exercise public production behavior with only the explicitly injected fakes. */
export async function verifyHarness(): Promise<void> {
  const harness = await createHarness(createTestDependencies());
  const created = await harness.dispatch({
    type: "CreateConversation", commandId: "portable-create", title: "Portable turn", settings: testSettings,
  });
  if (!created.ok || !created.conversationId) throw new Error("Conversation creation failed.");
  const submitted = await harness.dispatch({
    type: "SubmitQuestion", commandId: "portable-question", conversationId: created.conversationId,
    text: "What makes a choice free?",
  });
  if (!submitted.ok) throw new Error("Question submission failed.");

  for (let iteration = 0; iteration < 2_000; iteration++) {
    const conversation = await harness.query<"GetConversation">({ type: "GetConversation", conversationId: created.conversationId });
    if (!conversation.ok) throw new Error("Conversation query failed.");
    const turnId = conversation.data.questions[0]?.turnId;
    if (!turnId) continue;
    const turn = await harness.query<"GetTurn">({ type: "GetTurn", turnId });
    if (!turn.ok) throw new Error("Turn query failed.");
    if (turn.data.status === "COMPLETED") {
      if (turn.data.roleRuns.length !== 1 || !turn.data.roleRuns[0]?.answer?.text.trim()) {
        throw new Error("Completed turn has no single-role answer.");
      }
      return;
    }
  }
  throw new Error("Single-role turn did not complete within 2000 ECMAScript microtask iterations.");
}
