import { createHarness } from "../packages/harness/src/index";
import { createClient, inProcessTransport } from "../packages/client/src/index";
import { createTestDependencies, testSettings } from "../packages/testing/src/index";

/** Exercise public production behavior with only the explicitly injected fakes. */
export async function verifyHarness(): Promise<void> {
  const harness = await createHarness(createTestDependencies());
  let requestId = 0;
  const client = createClient({ transport: inProcessTransport(harness), ids: { next: () => `portable-request-${++requestId}` } });
  const created = await client.dispatch({
    type: "CreateConversation", commandId: "portable-create", title: "Portable turn", settings: testSettings,
  });
  if (!created.ok || !created.conversationId) throw new Error("Conversation creation failed.");
  const snapshot = await client.query({ type: "GetConversation", conversationId: created.conversationId });
  if (!snapshot.ok || snapshot.data.questions.length !== 0) throw new Error("Initial conversation projection is invalid.");
  const submitted = await client.dispatch({
    type: "SubmitQuestion", commandId: "portable-question", conversationId: created.conversationId,
    text: "What makes a choice free?",
  });
  if (!submitted.ok) throw new Error("Question submission failed.");

  for (let iteration = 0; iteration < 2_000; iteration++) {
    const conversation = await client.query({ type: "GetConversation", conversationId: created.conversationId });
    if (!conversation.ok) throw new Error("Conversation query failed.");
    const turnId = conversation.data.questions[0]?.turnId;
    if (!turnId) continue;
    const turn = await client.query({ type: "GetTurn", turnId });
    if (!turn.ok) throw new Error("Turn query failed.");
    if (turn.data.status === "COMPLETED") {
      if (turn.data.roleRuns.length !== 1 || !turn.data.roleRuns[0]?.answer?.text.trim()) {
        throw new Error("Completed turn has no single-role answer.");
      }
      // Start after completion to exercise the gap between a query snapshot and
      // its later subscription through both client envelope validation layers.
      const events = client.events(snapshot.lastEventSeq)[Symbol.asyncIterator]();
      let sawQuestion = false;
      let sawCompletion = false;
      try {
        for (let seq = snapshot.lastEventSeq + 1; seq <= turn.lastEventSeq; seq++) {
          const event = await events.next();
          if (event.done || event.value.seq !== seq) throw new Error("Client bookmark replay lost an event.");
          if (event.value.type === "QuestionAccepted" && event.value.questionId === submitted.questionId) sawQuestion = true;
          if (event.value.type === "TurnCompleted" && event.value.turnId === turnId) sawCompletion = true;
        }
      } finally {
        await events.return?.();
      }
      if (!sawQuestion || !sawCompletion) throw new Error("Client bookmark replay missed the accepted question or completed turn.");
      return;
    }
  }
  throw new Error("Single-role turn did not complete within 2000 ECMAScript microtask iterations.");
}
