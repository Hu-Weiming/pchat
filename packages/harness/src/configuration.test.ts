import { describe, expect, expectTypeOf, it } from "vitest";
import { TurnProjectionSchema, type ConversationProjection, type QueryResult, type TurnProjection } from "@pchat/contracts";
import { createHarness } from "./index";
import { createTestDependencies, testRole } from "../../testing/src/index";
import { createConversation, until, waitForTurn } from "../test-support";
import type { HarnessDependencies } from "./ports";

const concurrencyFields: Exclude<keyof HarnessDependencies["limits"], "maxCostUnits">[] = [
  "maxActiveTurns", "maxRoleRuns", "maxExternalCalls",
];
const costFields: (keyof HarnessDependencies["attemptCostUnits"])[] = ["RAG", "MODEL"];
const invalidPositiveIntegers = [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1];

describe("Harness configuration", () => {
  it.each([
    { name: "unknown fields", roles: [Object.assign({}, testRole, { credentialMarker: "sensitive-config-value" })] },
    { name: "empty corpus", roles: [{ ...testRole, corpusId: "" }] },
    { name: "duplicate participant ids", roles: [testRole, { ...testRole, revision: "role-v2" }] },
  ])("rejects $name before starting a runtime with a sanitized error", async ({ roles }) => {
    await expect(createHarness(createTestDependencies({ roles }))).rejects.toThrow(/^Harness configuration is invalid\.$/);
  });

  it.each(concurrencyFields.flatMap((field) => invalidPositiveIntegers.map((value) => ({ field, value }))))(
    "rejects invalid concurrency $field = $value", async ({ field, value }) => {
      const dependencies = createTestDependencies();
      dependencies.limits[field] = value;
      await expect(createHarness(dependencies)).rejects.toThrow(/^Harness configuration is invalid\.$/);
    },
  );

  it.each([-1, NaN, Infinity])("rejects invalid total cost budget %s", async (value) => {
    const dependencies = createTestDependencies();
    dependencies.limits.maxCostUnits = value;
    await expect(createHarness(dependencies)).rejects.toThrow(/^Harness configuration is invalid\.$/);
  });

  it.each(costFields.flatMap((field) => [-1, NaN, Infinity].map((value) => ({ field, value }))))(
    "rejects invalid attempt cost $field = $value", async ({ field, value }) => {
      const dependencies = createTestDependencies();
      dependencies.attemptCostUnits[field] = value;
      await expect(createHarness(dependencies)).rejects.toThrow(/^Harness configuration is invalid\.$/);
    },
  );

  it.each(invalidPositiveIntegers)("rejects invalid draft checkpoint size %s", async (draftCheckpointChars) => {
    await expect(createHarness(createTestDependencies({ draftCheckpointChars }))).rejects.toThrow(/^Harness configuration is invalid\.$/);
  });

  it("accepts zero total budget and nonnegative fractional attempt prices", async () => {
    const dependencies = createTestDependencies({ attemptCostUnits: { RAG: 0, MODEL: 0.5 } });
    dependencies.limits.maxCostUnits = 0;
    const harness = await createHarness(dependencies);
    const conversationId = await createConversation(harness);
    expect(await harness.query({ type: "GetConversation", conversationId })).toMatchObject({ ok: true });
  });

  it("isolates caller configuration changes while preserving injected adapter instances", async () => {
    const participant = { ...testRole };
    const dependencies = createTestDependencies({ roles: [participant] });
    dependencies.rag.holdNext();
    const harness = await createHarness(dependencies);
    const conversationId = await createConversation(harness);
    await harness.dispatch({ type: "SubmitQuestion", commandId: "first", conversationId, text: "What is freedom?" });
    await until(() => dependencies.rag.calls.length === 1);

    participant.corpusId = "changed-corpus";
    participant.revision = "changed-role";
    dependencies.limits.maxActiveTurns = 0;
    dependencies.limits.maxRoleRuns = 0;
    dependencies.limits.maxExternalCalls = 0;
    dependencies.limits.maxCostUnits = 0;
    dependencies.attemptCostUnits.MODEL = 700;
    dependencies.rag.calls[0]!.complete();

    const first = await waitForTurn(harness, conversationId, "COMPLETED");
    expect(TurnProjectionSchema.parse(first).roleRuns[0]?.context.participant).toEqual(testRole);
    expect(first.roleRuns[0]?.attempts.map((attempt) => attempt.reservedCostUnits)).toEqual([1, 1]);

    await harness.dispatch({ type: "SubmitQuestion", commandId: "second", conversationId, text: "And responsibility?" });
    const second = await waitForTurn(harness, conversationId, "COMPLETED", 1);
    expect(TurnProjectionSchema.parse(second).roleRuns[0]?.context.participant).toEqual(testRole);
  });

  it("keeps startup errors sanitized when configuration cannot be read", async () => {
    const participant = Object.defineProperty({ ...testRole }, "corpusId", {
      get() { throw new Error("sensitive-config-value") },
    });
    await expect(createHarness(createTestDependencies({ roles: [participant] }))).rejects.toThrow(/^Harness configuration is invalid\.$/);
  });

  it("rejects missing numeric configuration with the same safe startup error", async () => {
    const dependencies = Object.assign(createTestDependencies(), { limits: null });
    await expect(createHarness(dependencies)).rejects.toThrow(/^Harness configuration is invalid\.$/);
  });

  it("does not replace an existing runtime when new startup configuration is invalid", async () => {
    const dependencies = createTestDependencies();
    const harness = await createHarness(dependencies);
    const conversationId = await createConversation(harness);
    await expect(createHarness({ ...dependencies, roles: [{ ...testRole, corpusId: "" }] })).rejects.toThrow(/^Harness configuration is invalid\.$/);
    expect(await harness.dispatch({ type: "SubmitQuestion", commandId: "still-owner", conversationId, text: "What is freedom?" })).toMatchObject({ ok: true });
    expect((await waitForTurn(harness, conversationId, "COMPLETED")).status).toBe("COMPLETED");
  });

  it("infers query projections from request types and rejects mismatched request ids at compile time", async () => {
    const harness = await createHarness(createTestDependencies());
    const conversationId = await createConversation(harness);
    const conversation = await harness.query({ type: "GetConversation", conversationId });
    expectTypeOf(conversation).toEqualTypeOf<QueryResult<ConversationProjection>>();
    expect(conversation.ok).toBe(true);
    const turn = await harness.query({ type: "GetTurn", turnId: "missing" });
    expectTypeOf(turn).toEqualTypeOf<QueryResult<TurnProjection>>();
    expect(turn).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    if (false) {
      // @ts-expect-error Callers cannot request arbitrary response types.
      void harness.query<{ fabricated: true }>({ type: "GetConversation", conversationId });
      // @ts-expect-error A turn query requires turnId, not conversationId.
      void harness.query({ type: "GetTurn", conversationId });
      // @ts-expect-error An explicit query type must agree with the discriminator.
      void harness.query<"GetTurn">({ type: "GetConversation", conversationId });
    }
  });
});
