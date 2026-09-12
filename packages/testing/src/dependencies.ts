import type { HarnessDependencies } from "@pchat/harness";
import { clone } from "./clone";
import { FakeClock, FakeId, FakeModel, FakeRAG } from "./fakes";
import { testRole } from "./fixtures";
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
    ...options,
  };
}
