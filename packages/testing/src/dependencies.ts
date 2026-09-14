import type { HarnessDependencies } from "@pchat/harness";
import { clone } from "./clone";
import { FakeClock, FakeId, FakeModel, FakeRAG } from "./fakes";
import { testRole, testSettings } from "./fixtures";
import { InMemoryStore } from "./store";

export interface TestDependencies extends HarnessDependencies {
  store: InMemoryStore;
  model: FakeModel;
  rag: FakeRAG;
  clock: FakeClock;
  ids: FakeId;
}

export function createTestDependencies(options: Partial<TestDependencies> = {}): TestDependencies {
  return {
    store: new InMemoryStore(), model: new FakeModel(), rag: new FakeRAG(),
    clock: new FakeClock(), ids: new FakeId(), roles: [clone(testRole)],
    limits: { maxActiveTurns: 8, maxRoleRuns: 8, maxExternalCalls: 8, maxCostUnits: 1_000 },
    attemptCostUnits: { RAG: 1, MODEL: 1 }, draftCheckpointChars: 1,
    modelExecution: {
      policies: [{ binding: clone(testSettings.model), windowTokens: 1_000_000, outputReserveTokens: 1_000, policyVersion: "fake-policy-v1", counterVersion: "fake-tokens-v1", promptVersion: "fake-prompt-v1", countMode: "EXACT" }],
      // Test units only: deliberately not a production tokenizer or estimate.
      counter: { version: "fake-tokens-v1", count: (input) => 100 + input.context.history.length * 10 + input.evidence.length * 10 + (input.checkpoint ? 10 : 0) },
    },
    ...options,
  };
}
