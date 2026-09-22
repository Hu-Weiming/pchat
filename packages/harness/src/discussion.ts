import { DiscussionAnswerSchema, DiscussionPlanSchema, RetrievalResultSchema, type DiscussionInput, type DiscussionState } from "@pchat/contracts";
import type { Cancellation, HarnessDependencies, RuntimeState, TurnRecord } from "./ports";
import { copy } from "./data";
import { emit } from "./journal";
import { transition } from "./transitions";
import { captureComparison, pauseQueue } from "./settlement";
import { insufficientEvidenceAnswer, validAnswer, validEvidence } from "./evidence-policy";

class Failure extends Error { constructor(readonly code: string) { super(code); } }
type Attempt = DiscussionState["attempts"][number];

/** One durable execution per turn: plan, serial isolated retrievals, one final
 * generation. Attempts belong to the turn because the final call serves all
 * participants; charging/retrying it per RoleRun would duplicate paid work. */
export class DiscussionExecutor {
  constructor(private readonly deps: HarnessDependencies, private readonly epoch: number,
    private readonly external: <T>(operation: () => Promise<T>) => Promise<T | undefined>,
    private readonly drafts: Map<string, { attemptId: string; text: string }>,
    private readonly checkpoint: (state: RuntimeState, turn: TurnRecord) => void) {}

  private active(state: RuntimeState, id: string, token: Cancellation) {
    if (token.cancelled || state.epoch !== this.epoch || state.suspended) return undefined;
    return state.turns.find((turn) => turn.id === id && turn.status === "RUNNING" && turn.discussion);
  }
  private async current(id: string, token: Cancellation) {
    const turn = await this.deps.store.read((state) => this.active(state, id, token));
    if (!turn?.discussion) throw new Failure("CANCELLED");
    return turn as TurnRecord & { discussion: DiscussionState };
  }
  private async change(id: string, token: Cancellation, change: (turn: TurnRecord & { discussion: DiscussionState }, state: RuntimeState) => void) {
    return this.deps.store.transaction((state) => {
      const turn = this.active(state, id, token);
      if (!turn?.discussion) return false;
      change(turn as TurnRecord & { discussion: DiscussionState }, state);
      return true;
    });
  }
  private async call<T>(id: string, token: Cancellation, kind: Attempt["kind"], roleId: string | null, input: Attempt["input"], operation: (attemptId: string) => Promise<T>) {
    const value = await this.external(async () => {
      let attemptId = "";
      if (!await this.change(id, token, (turn, state) => {
        const cost = this.deps.attemptCostUnits[kind === "RAG" ? "RAG" : "MODEL"];
        const reserved = state.turns.flatMap((item) => [...item.roleRuns.flatMap((role) => role.attempts), ...(item.discussion?.attempts ?? [])])
          .filter((attempt) => attempt.status !== "CANCELLED").reduce((sum, attempt) => sum + attempt.reservedCostUnits, 0);
        if (reserved > this.deps.limits.maxCostUnits - cost) throw new Failure("BUDGET_EXCEEDED");
        attemptId = this.deps.ids.next();
        const previous = turn.discussion.attempts.filter((attempt) => attempt.kind === kind && attempt.roleId === roleId).at(-1);
        turn.discussion.attempts.push({ id: attemptId, kind, roleId, status: "PREPARED", reservedCostUnits: cost, previousAttemptId: previous?.id ?? null, input: copy(input) });
      })) throw new Failure("CANCELLED");
      if (!await this.change(id, token, (turn) => { transition("attempt", turn.discussion.attempts.find((a) => a.id === attemptId)!, "IN_FLIGHT"); })) throw new Failure("CANCELLED");
      // A delayed transaction acknowledgement cannot grant a revoked lease.
      await this.current(id, token);
      if (token.cancelled) throw new Failure("CANCELLED");
      return { attemptId, result: await operation(attemptId) };
    });
    if (!value) throw new Failure("CANCELLED");
    return value;
  }

  async execute(id: string, token: Cancellation): Promise<void> {
    const draftedRoles = new Set<string>();
    try {
      const model = this.deps.discussionModel;
      if (!model) throw new Failure("CONTEXT_UNAVAILABLE");
      let turn = await this.current(id, token);
      if (!turn.discussion.plan) {
        const { attemptId, result } = await this.call(id, token, "PLAN", null, turn.discussion.planningInput,
          (attemptId) => model.plan({ attemptId, input: copy(turn.discussion.planningInput) }, token));
        if (!result.ok) throw new Failure(result.code);
        const parsed = DiscussionPlanSchema.safeParse(result.plan);
        if (!parsed.success) throw new Failure("INVALID_PROVIDER_RESULT");
        const plan = parsed.data;
        const ids = plan.targets.map((target) => target.roleId);
        const explicit = turn.discussion.planningInput.settings.participantIds;
        const catalog = turn.discussion.planningInput.catalog;
        if (ids.length > (turn.discussion.planningInput.maxParticipants ?? 3) || new Set(ids).size !== ids.length || ids.some((roleId) => !catalog.some((role) => role.id === roleId && role.status === "CONFIRMED"))
          || (explicit.length > 0 && (explicit.length !== ids.length || explicit.some((roleId) => !ids.includes(roleId))))
          || plan.userClaims.some((claim) => !turn.context.question.text.includes(claim))) throw new Failure("INVALID_ROUTE");
        if (explicit.length) plan.targets.sort((a, b) => explicit.indexOf(a.roleId) - explicit.indexOf(b.roleId));
        if (!await this.change(id, token, (stored, state) => {
          transition("attempt", stored.discussion.attempts.find((a) => a.id === attemptId)!, "SUCCEEDED");
          stored.discussion.plan = plan; stored.discussion.status = "RETRIEVING";
          stored.context.participants = plan.targets.map((target) => copy(catalog.find((role) => role.id === target.roleId)!));
          stored.roleRuns = stored.context.participants.map((participant) => ({
            id: this.deps.ids.next(), status: "PENDING", textSoFar: "", revision: 0, evidence: [], answer: null, attempts: [], errorCode: null,
            context: { question: copy(stored.context.question), settings: copy(stored.context.settings), participant: copy(participant), history: copy(stored.context.history), executionPolicy: copy(stored.discussion.planningInput.executionPolicy) },
          }));
          emit(state, this.deps.clock, { type: "TurnStarted", conversationId: stored.conversationId, questionId: stored.questionId, turnId: stored.id });
        })) return;
      }
      turn = await this.current(id, token);
      for (const role of turn.roleRuns) {
        const prior = turn.discussion.attempts.filter((a) => a.kind === "RAG" && a.roleId === role.context.participant.id).at(-1);
        if (prior?.status === "SUCCEEDED") continue;
        if (!await this.change(id, token, (stored, state) => {
          const current = stored.roleRuns.find((r) => r.id === role.id)!;
          transition("role", current, "RETRIEVING");
          emit(state, this.deps.clock, { type: "RoleStarted", conversationId: stored.conversationId, questionId: stored.questionId, turnId: id, roleRunId: role.id });
        })) return;
        const target = turn.discussion.plan!.targets.find((target) => target.roleId === role.context.participant.id)!;
        const { attemptId, result } = await this.call(id, token, "RAG", target.roleId, null, (attemptId) => this.deps.rag.retrieve({
          attemptId, roleRunId: role.id, connectionId: role.context.settings.ragConnectionId, query: target.searchQuery,
          corpusId: role.context.participant.corpusId, corpusRevision: role.context.participant.corpusRevision, retrievalConfigRevision: role.context.participant.retrievalConfigRevision,
        }, token));
        const parsed = RetrievalResultSchema.safeParse(result);
        if (!parsed.success) throw new Failure("INVALID_PROVIDER_RESULT");
        if (!parsed.data.ok) throw new Failure(parsed.data.code);
        const evidence = parsed.data.evidence;
        if (!validEvidence(role.context.participant, evidence)) throw new Failure("INVALID_PROVIDER_RESULT");
        if (!await this.change(id, token, (stored, state) => {
          transition("attempt", stored.discussion.attempts.find((a) => a.id === attemptId)!, "SUCCEEDED");
          const current = stored.roleRuns.find((r) => r.id === role.id)!;
          current.evidence = evidence;
          transition("role", current, "GENERATING");
          emit(state, this.deps.clock, { type: "EvidenceCaptured", conversationId: stored.conversationId, questionId: stored.questionId, turnId: id, roleRunId: role.id });
        })) return;
      }
      turn = await this.current(id, token);
      const input: DiscussionInput = { question: turn.context.question, settings: turn.context.settings, plan: turn.discussion.plan!, history: copy(turn.context.history),
        participants: turn.roleRuns.map((role) => ({ participant: role.context.participant, evidence: role.evidence })), executionPolicy: turn.discussion.planningInput.executionPolicy };
      const budget = input.executionPolicy.windowTokens - input.executionPolicy.outputReserveTokens;
      const countInput = () => {
        const count = model.countInput ? model.countInput(copy(input)) : JSON.stringify(input).length * 3 + 4096;
        if (!Number.isSafeInteger(count) || count < 0) throw new Failure("CONTEXT_BUDGET_EXCEEDED");
        return count;
      };
      while (input.history.length && countInput() > budget) input.history.shift();
      if (countInput() > budget) throw new Failure("CONTEXT_BUDGET_EXCEEDED");
      if (!await this.change(id, token, (stored) => {
        stored.discussion.status = "GENERATING";
        for (const role of stored.roleRuns) if (role.status === "PENDING") transition("role", role, "GENERATING");
      })) return;
      let answer;
      let finalAttemptId: string | null = null;
      if (input.participants.every((p) => p.evidence.length === 0)) {
        answer = { answers: input.participants.map((p) => ({ roleId: p.participant.id, answer: insufficientEvidenceAnswer() })), commentary: { text: "", claimIndexes: [] }, summary: { text: "", roleIds: [] } };
      } else {
        const lengths = new Map<string, number>();
        const returned = await this.call(id, token, "DISCUSSION", null, input, (attemptId) => model.discuss({ attemptId, input: copy(input), onDraft: async (draft) => {
          if (typeof draft.text !== "string" || draft.text.length > 500_000 || !input.participants.some((p) => p.participant.id === draft.roleId)) throw new Failure("INVALID_PROVIDER_RESULT");
          if (token.cancelled) throw new Failure("CANCELLED");
          const roleRunId = turn.roleRuns.find((role) => role.context.participant.id === draft.roleId)!.id;
          draftedRoles.add(roleRunId);
          this.drafts.set(roleRunId, { attemptId, text: draft.text });
          if (draft.text.length - (lengths.get(draft.roleId) ?? 0) < this.deps.draftCheckpointChars) return;
          if (!await this.change(id, token, (stored, state) => {
            this.checkpoint(state, stored);
          })) throw new Failure("CANCELLED");
          lengths.set(draft.roleId, draft.text.length);
        } }, token));
        if (!returned.result.ok) throw new Failure(returned.result.code);
        const parsed = DiscussionAnswerSchema.safeParse(returned.result.answer);
        if (!parsed.success) throw new Failure("INVALID_PROVIDER_RESULT");
        answer = parsed.data; finalAttemptId = returned.attemptId;
      }
      const unsupported = new Set<string>();
      for (const item of answer.answers) {
        const outsideMode = (item.answer.kind === "INFERENCE" && input.settings.knowledgeMode === "PRIMARY")
          || (item.answer.kind === "FICTION" && input.settings.knowledgeMode !== "FICTION");
        if (item.answer.kind === "INSUFFICIENT_EVIDENCE" || outsideMode) {
          unsupported.add(item.roleId);
          item.answer = insufficientEvidenceAnswer();
        }
      }
      // A lack of support is a valid user-visible result, not a network failure.
      // Shared prose has no verifiable per-claim role provenance. Once any view
      // is discarded, neither roleIds nor claimIndexes can prove it was excluded.
      if (unsupported.size > 0) {
        answer.summary = { text: "", roleIds: [] };
        answer.commentary = { text: "", claimIndexes: [] };
      }
      if (answer.answers.length !== input.participants.length || new Set(answer.answers.map((a) => a.roleId)).size !== answer.answers.length
        || answer.answers.some((item) => {
          const participant = input.participants.find((p) => p.participant.id === item.roleId);
          return !participant || !validAnswer(input.settings.knowledgeMode, participant.evidence, item.answer) || (participant.evidence.length === 0 && item.answer.kind !== "INSUFFICIENT_EVIDENCE");
        }) || answer.commentary.claimIndexes.some((i) => i >= input.plan.userClaims.length)
        || (answer.commentary.text.length > 0 && answer.commentary.claimIndexes.length === 0)
        || answer.summary.roleIds.some((roleId) => !answer.answers.some((a) => a.roleId === roleId && a.answer.kind !== "INSUFFICIENT_EVIDENCE"))
        || (answer.summary.text.length > 0 && answer.summary.roleIds.length === 0)) throw new Failure("INVALID_PROVIDER_RESULT");
      await this.change(id, token, (stored, state) => {
        if (finalAttemptId) transition("attempt", stored.discussion.attempts.find((a) => a.id === finalAttemptId)!, "SUCCEEDED");
        for (const role of stored.roleRuns) {
          role.answer = answer.answers.find((a) => a.roleId === role.context.participant.id)!.answer;
          role.textSoFar = role.answer.text; role.revision++;
          transition("role", role, "COMPLETED");
          emit(state, this.deps.clock, { type: "RoleCompleted", conversationId: stored.conversationId, questionId: stored.questionId, turnId: id, roleRunId: role.id });
        }
        stored.discussion.status = "COMPLETED"; stored.discussion.commentary = answer.commentary; stored.discussion.summary = answer.summary;
        captureComparison(stored);
        transition("turn", stored, "COMPLETED");
        const conversation = state.conversations.find((c) => c.id === stored.conversationId)!;
        transition("question", conversation.questions.find((q) => q.id === stored.questionId)!, "COMPLETED");
        conversation.activeTurnId = null;
        emit(state, this.deps.clock, { type: "TurnCompleted", conversationId: stored.conversationId, questionId: stored.questionId, turnId: id });
      });
    } catch (error) {
      await this.change(id, token, (turn, state) => {
        this.checkpoint(state, turn);
        const code = error instanceof Failure ? error.code : "OUTCOME_UNKNOWN";
        const waiting = code === "OUTCOME_UNKNOWN";
        for (const attempt of turn.discussion.attempts) {
          if (attempt.status === "PREPARED") transition("attempt", attempt, "CANCELLED");
          else if (attempt.status === "IN_FLIGHT") transition("attempt", attempt, waiting ? "OUTCOME_UNKNOWN" : "FAILED");
        }
        turn.discussion.status = waiting ? "WAITING_USER" : "FAILED"; turn.discussion.errorCode = code;
        for (const role of turn.roleRuns) {
          if (role.status === "PENDING" && !waiting) transition("role", role, "RETRIEVING");
          transition("role", role, waiting ? "WAITING_USER" : "FAILED"); role.errorCode = code;
        }
        transition("turn", turn, waiting ? "WAITING_USER" : "FAILED");
        const conversation = state.conversations.find((c) => c.id === turn.conversationId)!;
        transition("question", conversation.questions.find((q) => q.id === turn.questionId)!, waiting ? "WAITING_USER" : "FAILED");
        if (!waiting) conversation.activeTurnId = null;
        pauseQueue(state, turn, this.deps.clock);
        emit(state, this.deps.clock, { type: waiting ? "TurnWaiting" : "TurnFailed", conversationId: turn.conversationId, questionId: turn.questionId, turnId: id });
      });
    } finally { for (const roleId of draftedRoles) this.drafts.delete(roleId); }
  }
}
