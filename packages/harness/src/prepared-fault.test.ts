import { describe, expect, it } from "vitest";
import { createHarness, type RuntimeState, type RuntimeStore } from "./index";
import { createTestDependencies } from "../../testing/src/index";
import { createConversation, waitForTurn } from "../test-support";

/** Fail the durable send marker once, leaving the already committed preparation
 * untouched. Assertions use Harness projections and the external adapter ports. */
class SendMarkerRollbackStore implements RuntimeStore {
  private failed = false;
  constructor(private readonly delegate: RuntimeStore, private readonly kind: "RAG" | "MODEL") {}

  read<T>(reader: (snapshot: Readonly<RuntimeState>) => T) { return this.delegate.read(reader); }
  subscribe(listener: Parameters<RuntimeStore["subscribe"]>[0]) { return this.delegate.subscribe(listener); }

  transaction<T>(writer: (draft: RuntimeState) => T): Promise<T> {
    return this.delegate.transaction((draft) => {
      const result = writer(draft);
      if (!this.failed && draft.turns.some((turn) => turn.roleRuns.some((role) => role.attempts.some((attempt) => attempt.kind === this.kind && attempt.status === "IN_FLIGHT")))) {
        this.failed = true;
        throw new Error("Injected send-marker transaction rollback");
      }
      return result;
    });
  }
}

describe("prepared attempts whose send marker cannot be committed", () => {
  it.each(["RAG", "MODEL"] as const)("releases unsent %s cost and preserves its link on explicit regeneration", async (kind) => {
    const deps = createTestDependencies({ limits: { maxActiveTurns: 1, maxRoleRuns: 1, maxExternalCalls: 1, maxCostUnits: 2 } });
    const harness = await createHarness({ ...deps, store: new SendMarkerRollbackStore(deps.store, kind) });
    const conversationId = await createConversation(harness);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "question", conversationId, text: "What is freedom?" });

    const waiting = await waitForTurn(harness, conversationId, "WAITING_USER");
    const role = waiting.roleRuns[0]!;
    const unsentAttempt = role.attempts.at(-1)!;
    expect(unsentAttempt).toMatchObject({ kind, status: "CANCELLED", reservedCostUnits: 1 });
    expect(kind === "RAG" ? deps.rag.calls : deps.model.calls).toHaveLength(0);

    expect(await harness.dispatch({ type: "RegenerateRole", commandId: "regenerate", roleRunId: role.id })).toMatchObject({ ok: true });
    const completed = await waitForTurn(harness, conversationId, "COMPLETED");
    const attempts = completed.roleRuns[0]!.attempts;
    expect(attempts).toHaveLength(3);
    expect(attempts.find((attempt) => attempt.id === unsentAttempt.id)).toEqual(unsentAttempt);
    expect(attempts.filter((attempt) => attempt.kind === kind).at(-1)).toMatchObject({ status: "SUCCEEDED", previousAttemptId: unsentAttempt.id });
    expect(deps.rag.calls).toHaveLength(1);
    expect(deps.model.calls).toHaveLength(1);
  });
});
