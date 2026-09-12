import { ModelChunkSchema, RetrievalResultSchema } from "@pchat/contracts";
import type { ExternalAttempt, HarnessDependencies, RoleRunRecord, RuntimeState, TurnRecord } from "./ports";
import { copy } from "./data";
import { emit } from "./journal";
import { transition } from "./transitions";
import { CancellationToken } from "./cancellation";

class ExecutionFailure extends Error {
  constructor(readonly outcome: "REJECTED" | "OUTCOME_UNKNOWN" | "INVALID_PROVIDER_RESULT") { super(outcome) }
}

export class TurnCoordinator {
  private scheduled = false;
  private dirty = false;
  private readonly running = new Map<string, CancellationToken>();
  constructor(private readonly deps: HarnessDependencies, private readonly epoch: number) {}

  wake(): void {
    this.dirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          let turn: TurnRecord | null;
          while ((turn = await this.claim())) {
            const claimed = turn;
            const token = new CancellationToken();
            this.running.set(claimed.id, token);
            void this.execute(claimed, token).finally(() => { this.running.delete(claimed.id); this.wake() });
          }
        }
      } finally { this.scheduled = false }
    }).catch(() => { this.scheduled = false });
  }

  cancel(turnId: string): void { this.running.get(turnId)?.cancel() }
  cancelAll(): void { for (const token of this.running.values()) token.cancel() }

  private claim(): Promise<TurnRecord | null> {
    return this.deps.store.transaction((state) => {
      if (state.epoch !== this.epoch || state.suspended) return null;
      const existing = state.turns.find((turn) => turn.status === "RUNNING" && !this.running.has(turn.id));
      if (existing) return existing;
      if (state.turns.filter((turn) => turn.status === "RUNNING").length >= this.deps.limits.maxActiveTurns) return null;
      if (state.turns.flatMap((turn) => turn.roleRuns).filter((role) => role.status === "RETRIEVING" || role.status === "GENERATING").length >= this.deps.limits.maxRoleRuns) return null;
      const conversation = state.conversations.find((item) => item.queueStatus === "RUNNING" && item.activeTurnId === null && item.questions.some((question) => question.status === "QUEUED"));
      const question = conversation?.questions.find((item) => item.status === "QUEUED");
      if (!conversation || !question) return null;
      const turnId = this.deps.ids.next();
      const roleId = this.deps.ids.next();
      const turn: TurnRecord = {
        id: turnId, conversationId: conversation.id, questionId: question.id, status: "RUNNING",
        context: {
          question: { id: question.id, text: question.text }, settings: question.settings, participant: question.participant,
          history: state.turns.filter((prior) => prior.conversationId === conversation.id && prior.status === "COMPLETED")
            .map((prior) => ({ turnId: prior.id, question: prior.context.question.text, answer: prior.roleRuns[0]?.answer?.text ?? "" })),
        },
        roleRuns: [{ id: roleId, status: "RETRIEVING", textSoFar: "", revision: 0, evidence: [], answer: null, attempts: [], errorCode: null }],
      };
      transition("question", question, "RUNNING");
      question.turnId = turnId;
      conversation.activeTurnId = turnId;
      conversation.turnIds.push(turnId);
      state.turns.push(turn);
      const ids = this.eventIds(turn, turn.roleRuns[0]!);
      emit(state, this.deps.clock, { type: "TurnStarted", conversationId: conversation.id, questionId: question.id, turnId });
      emit(state, this.deps.clock, { type: "RoleStarted", ...ids });
      return turn;
    });
  }

  private eventIds(turn: TurnRecord, role: RoleRunRecord) {
    return { conversationId: turn.conversationId, questionId: turn.questionId, turnId: turn.id, roleRunId: role.id };
  }

  private active(state: RuntimeState, turnId: string, roleId: string) {
    if (state.epoch !== this.epoch || state.suspended) return null;
    const turn = state.turns.find((item) => item.id === turnId && item.status === "RUNNING");
    const role = turn?.roleRuns.find((item) => item.id === roleId && (item.status === "RETRIEVING" || item.status === "GENERATING"));
    return turn && role ? { turn, role } : null;
  }

  private async prepare(turnId: string, roleId: string, kind: ExternalAttempt["kind"]): Promise<ExternalAttempt | null> {
    const attempt = await this.deps.store.transaction((state) => {
      const current = this.active(state, turnId, roleId);
      if (!current) return null;
      const previous = current.role.attempts.filter((item) => item.kind === kind).at(-1);
      const attempt: ExternalAttempt = { id: this.deps.ids.next(), kind, status: "PREPARED", previousAttemptId: previous?.id ?? null, reservedCostUnits: this.deps.attemptCostUnits[kind], draft: "" };
      current.role.attempts.push(attempt);
      return attempt;
    });
    if (!attempt) return null;
    const started = await this.deps.store.transaction((state) => {
      const current = this.active(state, turnId, roleId);
      const stored = current?.role.attempts.find((item) => item.id === attempt.id && item.status === "PREPARED");
      if (!stored) return false;
      transition("attempt", stored, "IN_FLIGHT");
      return true;
    });
    return started ? attempt : null;
  }

  private update(turnId: string, roleId: string, attemptId: string, change: (state: RuntimeState, turn: TurnRecord, role: RoleRunRecord, attempt: ExternalAttempt) => void): Promise<boolean> {
    return this.deps.store.transaction((state) => {
      const current = this.active(state, turnId, roleId);
      const attempt = current?.role.attempts.at(-1);
      if (!current || !attempt || attempt.id !== attemptId || attempt.status !== "IN_FLIGHT") return false;
      change(state, current.turn, current.role, attempt);
      return true;
    });
  }

  private async execute(turn: TurnRecord, token: CancellationToken): Promise<void> {
    const role = turn.roleRuns[0]!;
    try {
      let evidence = role.evidence;
      if (role.status === "RETRIEVING") {
        const attempt = await this.prepare(turn.id, role.id, "RAG");
        if (!attempt) return;
        const participant = turn.context.participant;
        const result = RetrievalResultSchema.safeParse(await this.deps.rag.retrieve({
          attemptId: attempt.id, roleRunId: role.id, connectionId: turn.context.settings.ragConnectionId,
          query: turn.context.question.text, corpusId: participant.corpusId, corpusRevision: participant.corpusRevision, retrievalConfigRevision: participant.retrievalConfigRevision,
        }, token));
        if (!result.success) throw new ExecutionFailure("INVALID_PROVIDER_RESULT");
        if (!result.data.ok) throw new ExecutionFailure(result.data.code);
        evidence = result.data.evidence;
        if (!await this.update(turn.id, role.id, attempt.id, (state, storedTurn, storedRole, storedAttempt) => {
          transition("attempt", storedAttempt, "SUCCEEDED");
          transition("role", storedRole, "GENERATING");
          storedRole.evidence = evidence;
          emit(state, this.deps.clock, { type: "EvidenceCaptured", ...this.eventIds(storedTurn, storedRole) });
        })) return;
      }
      const attempt = await this.prepare(turn.id, role.id, "MODEL");
      if (!attempt) return;
      let draft = "";
      let checkpointLength = 0;
      for await (const raw of this.deps.model.generate(copy({ attemptId: attempt.id, roleRunId: role.id, context: turn.context, evidence }), token)) {
        const parsed = ModelChunkSchema.safeParse(raw);
        if (!parsed.success) throw new ExecutionFailure("INVALID_PROVIDER_RESULT");
        const chunk = parsed.data;
        if (chunk.type === "failure") throw new ExecutionFailure(chunk.code);
        if (chunk.type === "delta") {
          draft += chunk.text;
          if (draft.length - checkpointLength >= this.deps.draftCheckpointChars) {
            if (!await this.update(turn.id, role.id, attempt.id, (state, storedTurn, storedRole, storedAttempt) => {
              storedRole.textSoFar = draft; storedRole.revision++; storedAttempt.draft = draft;
              emit(state, this.deps.clock, { type: "RoleCheckpoint", ...this.eventIds(storedTurn, storedRole) });
            })) return;
            checkpointLength = draft.length;
          }
          continue;
        }
        await this.update(turn.id, role.id, attempt.id, (state, storedTurn, storedRole, storedAttempt) => {
          transition("attempt", storedAttempt, "SUCCEEDED"); transition("role", storedRole, "COMPLETED");
          storedRole.answer = chunk.answer; storedRole.textSoFar = chunk.answer.text; storedRole.revision++; storedAttempt.draft = chunk.answer.text;
          emit(state, this.deps.clock, { type: "RoleCompleted", ...this.eventIds(storedTurn, storedRole) });
          transition("turn", storedTurn, "COMPLETED");
          const conversation = state.conversations.find((item) => item.id === turn.conversationId)!;
          transition("question", conversation.questions.find((item) => item.id === turn.questionId)!, "COMPLETED");
          conversation.activeTurnId = null;
          emit(state, this.deps.clock, { type: "TurnCompleted", conversationId: conversation.id, questionId: turn.questionId, turnId: turn.id });
        });
        return;
      }
      throw new ExecutionFailure("OUTCOME_UNKNOWN");
    } catch (error) {
      await this.deps.store.transaction((state) => {
        const current = this.active(state, turn.id, role.id);
        if (!current) return;
        const outcome = error instanceof ExecutionFailure ? error.outcome : "OUTCOME_UNKNOWN";
        const attempt = current.role.attempts.at(-1);
        if (attempt?.status === "IN_FLIGHT") transition("attempt", attempt, outcome === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "FAILED");
        const waiting = outcome === "OUTCOME_UNKNOWN";
        transition("role", current.role, waiting ? "WAITING_USER" : "FAILED");
        transition("turn", current.turn, waiting ? "WAITING_USER" : "FAILED");
        current.role.errorCode = outcome === "INVALID_PROVIDER_RESULT" ? outcome : "PROVIDER_FAILED";
        const conversation = state.conversations.find((item) => item.id === turn.conversationId)!;
        transition("question", conversation.questions.find((item) => item.id === turn.questionId)!, waiting ? "WAITING_USER" : "FAILED");
        conversation.queueStatus = "PAUSED";
        if (!waiting) conversation.activeTurnId = null;
        emit(state, this.deps.clock, { type: waiting ? "RoleWaiting" : "RoleFailed", ...this.eventIds(current.turn, current.role) });
        emit(state, this.deps.clock, { type: waiting ? "TurnWaiting" : "TurnFailed", conversationId: conversation.id, questionId: turn.questionId, turnId: turn.id });
        emit(state, this.deps.clock, { type: "QueuePaused", conversationId: conversation.id });
      });
    }
  }
}
