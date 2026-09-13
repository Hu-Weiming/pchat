import { randomUUID } from "node:crypto";
import { createHarness } from "../../../harness/src/index";
import { createTestDependencies, testSettings } from "../../../testing/src/index";
import { openSqliteStore } from "../index";

const [path, backupDirectory] = process.argv.slice(2);
if (!path || !backupDirectory) throw new Error("Database paths are required");
const store = await openSqliteStore({ path, backupDirectory });
const fakes = createTestDependencies();
fakes.model.holdNext();
const harness = await createHarness({ ...fakes, store, ids: { next: randomUUID } });
const created = await harness.dispatch({ type: "CreateConversation", commandId: "create", title: "Crash recovery", settings: testSettings });
if (!created.ok || !created.conversationId) throw new Error("Conversation failed");
const first = await harness.dispatch({ type: "SubmitQuestion", commandId: "first", conversationId: created.conversationId, text: "First question" });
await harness.dispatch({ type: "SubmitQuestion", commandId: "second", conversationId: created.conversationId, text: "Second question" });
for (let wait = 0; wait < 1000 && fakes.model.calls.length === 0; wait++) await Promise.resolve();
const call = fakes.model.calls[0];
if (!call) throw new Error("Model call was not started");
call.delta("Saved before forced termination");
let checkpointed = false;
for (let wait = 0; wait < 1000; wait++) {
  checkpointed = await store.read((state) => state.turns[0]?.roleRuns[0]?.textSoFar === "Saved before forced termination");
  if (checkpointed) break;
}
if (!checkpointed) throw new Error("Checkpoint was not persisted");
process.send?.({ type: "ready", conversationId: created.conversationId, receipt: first });
setInterval(() => {}, 1000);
