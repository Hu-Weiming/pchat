import { ThoughtStagePackageSchema } from "@pchat/contracts";
import type { HarnessDependencies } from "./ports";

function positiveSafeInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0 }
function nonnegativeFinite(value: number): boolean { return Number.isFinite(value) && value >= 0 }

/** Keep untrusted configuration details out of startup errors. */
export function validateConfiguration(dependencies: HarnessDependencies): HarnessDependencies {
  try {
    const parsed = ThoughtStagePackageSchema.array().safeParse(dependencies.roles);
    const limits = {
      maxActiveTurns: dependencies.limits.maxActiveTurns,
      maxRoleRuns: dependencies.limits.maxRoleRuns,
      maxExternalCalls: dependencies.limits.maxExternalCalls,
      maxCostUnits: dependencies.limits.maxCostUnits,
    };
    const attemptCostUnits = { RAG: dependencies.attemptCostUnits.RAG, MODEL: dependencies.attemptCostUnits.MODEL };
    const draftCheckpointChars = dependencies.draftCheckpointChars;
    if (!parsed.success || new Set(parsed.data.map((role) => role.id)).size !== parsed.data.length ||
        !positiveSafeInteger(limits.maxActiveTurns) || !positiveSafeInteger(limits.maxRoleRuns) ||
        !positiveSafeInteger(limits.maxExternalCalls) || !nonnegativeFinite(limits.maxCostUnits) ||
        !nonnegativeFinite(attemptCostUnits.RAG) || !nonnegativeFinite(attemptCostUnits.MODEL) ||
        !positiveSafeInteger(draftCheckpointChars)) {
      throw new Error();
    }
    // Copy data before any await; preserve behavior ports as injected instances.
    return {
      store: dependencies.store, model: dependencies.model, rag: dependencies.rag,
      clock: dependencies.clock, ids: dependencies.ids,
      roles: parsed.data, limits, attemptCostUnits, draftCheckpointChars,
    };
  } catch {
    throw new Error("Harness configuration is invalid.");
  }
}
