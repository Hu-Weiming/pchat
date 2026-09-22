import { ModelChunkSchema, RetrievalResultSchema } from "@pchat/contracts";
import type { Answer, ExternalAttempt, HarnessDependencies, ModelInputSnapshot, RoleRunRecord, RuntimeState, TurnRecord } from "./ports";
import { copy } from "./data";
import { emit } from "./journal";
import { transition } from "./transitions";
import { CancellationToken } from "./cancellation";
import { insufficientEvidenceAnswer, validAnswer, validEvidence } from "./evidence-policy";
import { pauseQueue, settleTurn } from "./settlement";
import { assembleContext, ContextFailure } from "./context";
import { DiscussionExecutor } from "./discussion";

class ExecutionFailure extends Error {
  constructor(readonly outcome: "REJECTED" | "OUTCOME_UNKNOWN" | "INVALID_PROVIDER_RESULT" | "BUDGET_EXCEEDED") { super(outcome) }
}

export class TurnCoordinator {
  private scheduled = false;
  private dirty = false;
  private readonly running = new Map<string, { turnId: string; token: CancellationToken; slots: number }>();
  private externalCalls = 0;
  private readonly externalWaiters: { token: CancellationToken; resolve: (granted: boolean) => void; unsubscribe: () => void }[] = [];
  private readonly drafts = new Map<string, { attemptId: string; text: string }>();
  private retired = false;
  faulted = false;
  private unsubscribe = () => {};
  constructor(private readonly deps: HarnessDependencies, private readonly epoch: number) {
    const unsubscribe = deps.store.subscribe((notice) => {
      if (notice.epoch !== epoch) { this.retired = true; this.cancelAll(); this.unsubscribe(); return }
      for (const { turnId, token } of this.running.values()) if (notice.suspended || !notice.runnableTurnIds.includes(turnId)) token.cancel();
    });
    this.unsubscribe = unsubscribe;
    if (this.retired) unsubscribe();
  }

  wake(): void {
    if (this.retired || this.faulted) return;
    this.dirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          let claimed: { turn: TurnRecord; role: RoleRunRecord | null } | null;
          while ((claimed = await this.claim())) {
            const { turn, role } = claimed;
            const token = new CancellationToken();
            const executionId = role?.id ?? turn.id;
            this.running.set(executionId, { turnId: turn.id, token, slots: this.slots(turn) });
            const execution = role ? this.execute(turn, role, token) : new DiscussionExecutor(this.deps, this.epoch, (operation) => this.external(token, operation), this.drafts, (state, current) => this.checkpoint(state, current)).execute(turn.id, token);
            void execution.catch(() => { this.faulted = true; this.cancelAll() }).finally(() => {
              this.running.delete(executionId);
              this.drafts.delete(executionId);
              if (!role) for (const item of turn.roleRuns) this.drafts.delete(item.id);
              this.wake();
            });
          }
        }
      } finally { this.scheduled = false }
    }).catch(() => { this.scheduled = false; this.faulted = true; this.cancelAll() });
  }

  cancel(turnId: string): void { for (const running of this.running.values()) if (running.turnId === turnId) running.token.cancel() }
  cancelAll(): void { for (const { token } of this.running.values()) token.cancel() }

  private acquireExternal(token: CancellationToken): Promise<boolean> {
    if (token.cancelled || this.retired || this.faulted) return Promise.resolve(false);
    if (this.externalCalls < this.deps.limits.maxExternalCalls) { this.externalCalls++; return Promise.resolve(true) }
    return new Promise((resolve) => {
      const waiter = { token, resolve, unsubscribe: () => {} };
      this.externalWaiters.push(waiter);
      waiter.unsubscribe = token.subscribe(() => {
        const index = this.externalWaiters.indexOf(waiter);
        if (index >= 0) this.externalWaiters.splice(index, 1);
        resolve(false);
      });
    });
  }

  private releaseExternal(): void {
    this.externalCalls--;
    while (this.externalWaiters.length && this.externalCalls < this.deps.limits.maxExternalCalls) {
      const waiter = this.externalWaiters.shift()!;
      waiter.unsubscribe();
      if (waiter.token.cancelled || this.retired || this.faulted) waiter.resolve(false);
      else { this.externalCalls++; waiter.resolve(true) }
    }
  }

  private async external<T>(token: CancellationToken, operation: () => Promise<T>): Promise<T | undefined> {
    if (!await this.acquireExternal(token)) return undefined;
    try {
      if (token.cancelled || this.retired || this.faulted) return undefined;
      return await operation();
    } finally { this.releaseExternal() }
  }

  checkpoint(state: RuntimeState, turn: TurnRecord): void {
    for (const role of turn.roleRuns) {
      const draft = this.drafts.get(role.id);
      const attempt = turn.discussion?.attempts.at(-1) ?? role.attempts.at(-1);
      if (!draft || !attempt || attempt.id !== draft.attemptId || attempt.status !== "IN_FLIGHT" || role.textSoFar === draft.text) continue;
      role.textSoFar = draft.text; role.revision++;
      if (turn.discussion) {
        const shared = turn.discussion.attempts.at(-1)!;
        shared.drafts ??= [];
        const prior = shared.drafts.find((item) => item.roleId === role.context.participant.id);
        if (prior) prior.text = draft.text; else shared.drafts.push({ roleId: role.context.participant.id, text: draft.text });
      } else role.attempts.at(-1)!.draft = draft.text;
      emit(state, this.deps.clock, { type: "RoleCheckpoint", ...this.eventIds(turn, role) });
    }
  }

  private slots(turn: TurnRecord): number {
    return turn.discussion ? turn.context.settings.participantIds.length || Math.min(turn.discussion.planningInput.maxParticipants ?? 3, turn.discussion.planningInput.catalog.length) : 1;
  }

  private claim(): Promise<{ turn: TurnRecord; role: RoleRunRecord | null } | null> {
    return this.deps.store.transaction((state) => {
      if (this.faulted || this.retired || state.epoch !== this.epoch || state.suspended) return null;
      // Role execution and external requests have independent global limits.
      // Keep a running role's slot until cancellation has actually drained.
      const available = this.deps.limits.maxRoleRuns - [...this.running.values()].reduce((sum, item) => sum + item.slots, 0);
      if (available <= 0) return null;
      const claimRole = (turn: TurnRecord) => {
        if (turn.discussion) return this.running.has(turn.id) || this.slots(turn) > available ? null : { turn, role: null };
        const role = turn.roleRuns.find((item) => item.status === "PENDING" && !this.running.has(item.id));
        if (!role) return null;
        // Legacy snapshots have no historical budget audit. An explicit new
        // execution may attach a policy without inventing past model inputs.
        if (!role.context.executionPolicy) role.context.executionPolicy = copy(this.deps.modelExecution.policies.find((policy) => JSON.stringify(policy.binding) === JSON.stringify(role.context.settings.model)) ?? null);
        const previous = role.attempts.at(-1);
        transition("role", role, previous?.kind === "MODEL" || (previous?.kind === "RAG" && previous.status === "SUCCEEDED") ? "GENERATING" : "RETRIEVING");
        emit(state, this.deps.clock, { type: "RoleStarted", ...this.eventIds(turn, role) });
        return { turn, role };
      };
      for (const turn of state.turns) if (turn.status === "RUNNING") {
        const claimed = claimRole(turn);
        if (claimed) return claimed;
      }
      if (state.turns.filter((turn) => turn.status === "RUNNING").length >= this.deps.limits.maxActiveTurns) return null;
      const conversation = state.conversations.find((item) => item.queueStatus === "RUNNING" && item.activeTurnId === null && item.questions.some((question) => question.status === "QUEUED"));
      const question = conversation?.questions.find((item) => item.status === "QUEUED");
      if (!conversation || !question) return null;
      const turnId = this.deps.ids.next();
      const history = state.turns.filter((prior) => prior.conversationId === conversation.id && prior.status !== "RUNNING" && prior.status !== "WAITING_USER")
        .flatMap((prior) => {
          const answers = prior.roleRuns.filter((role) => role.status === "COMPLETED" && role.answer);
          if (!answers.length) return [];
          return [{ turnId: prior.id, question: prior.context.question.text, answer: answers.map((role) => prior.roleRuns.length === 1 ? role.answer!.text : `${role.context.participant.label}:\n${role.answer!.text}`).join("\n\n") }];
        });
      const turn: TurnRecord = {
        id: turnId, conversationId: conversation.id, questionId: question.id, status: "RUNNING",
        context: {
          question: { id: question.id, text: question.text }, settings: copy(question.settings), participants: copy(question.participants), history,
        },
        roleRuns: question.participants.map((participant) => ({
          id: this.deps.ids.next(), status: "PENDING", textSoFar: "", revision: 0, evidence: [], answer: null, attempts: [], errorCode: null,
          context: { question: { id: question.id, text: question.text }, settings: copy(question.settings), participant: copy(participant), history: copy(history),
            executionPolicy: copy(question.executionPolicy ?? this.deps.modelExecution.policies.find((policy) => JSON.stringify(policy.binding) === JSON.stringify(question.settings.model)) ?? null) },
        })),
        comparison: null,
      };
      if (this.deps.discussionModel && question.executionPolicy) {
        turn.context.participants = question.settings.participantIds.length ? copy(question.participants) : [];
        turn.roleRuns = [];
        turn.discussion = { status: "PLANNING", planningInput: {
          question: copy(turn.context.question), settings: copy(question.settings), catalog: copy(question.participants), executionPolicy: copy(question.executionPolicy),
          maxParticipants: Math.min(3, this.deps.limits.maxRoleRuns),
        }, plan: null, attempts: [], commentary: null, summary: null, errorCode: null };
      }
      transition("question", question, "RUNNING");
      question.turnId = turnId;
      conversation.activeTurnId = turnId;
      conversation.turnIds.push(turnId);
      state.turns.push(turn);
      emit(state, this.deps.clock, { type: "TurnStarted", conversationId: conversation.id, questionId: question.id, turnId });
      return claimRole(turn);
    });
  }

  private eventIds(turn: TurnRecord, role: RoleRunRecord) {
    return { conversationId: turn.conversationId, questionId: turn.questionId, turnId: turn.id, roleRunId: role.id };
  }

  private active(state: RuntimeState, turnId: string, roleId: string) {
    if (this.faulted || this.retired || state.epoch !== this.epoch || state.suspended) return null;
    const turn = state.turns.find((item) => item.id === turnId && item.status === "RUNNING");
    const role = turn?.roleRuns.find((item) => item.id === roleId && (item.status === "RETRIEVING" || item.status === "GENERATING"));
    return turn && role ? { turn, role } : null;
  }

  private async prepare(turnId: string, roleId: string, kind: ExternalAttempt["kind"], input?: ModelInputSnapshot): Promise<ExternalAttempt | null> {
    const attempt = await this.deps.store.transaction((state) => {
      const current = this.active(state, turnId, roleId);
      if (!current) return null;
      const reserved = state.turns.flatMap((turn) => [...turn.roleRuns.flatMap((role) => role.attempts), ...(turn.discussion?.attempts ?? [])])
        .filter((attempt) => attempt.status !== "CANCELLED")
        .reduce((sum, attempt) => sum + attempt.reservedCostUnits, 0);
      if (reserved > this.deps.limits.maxCostUnits - this.deps.attemptCostUnits[kind]) throw new ExecutionFailure("BUDGET_EXCEEDED");
      const previous = current.role.attempts.filter((item) => item.kind === kind).at(-1);
      const attempt: ExternalAttempt = { id: this.deps.ids.next(), kind, status: "PREPARED", previousAttemptId: previous?.id ?? null, reservedCostUnits: this.deps.attemptCostUnits[kind], draft: "" };
      if (input) attempt.input = copy(input);
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

  private completeRole(state: RuntimeState, turn: TurnRecord, role: RoleRunRecord, answer: Answer, attempt?: ExternalAttempt): void {
    if (attempt) {
      transition("attempt", attempt, "SUCCEEDED");
      attempt.draft = answer.text;
    }
    transition("role", role, "COMPLETED");
    role.answer = answer; role.textSoFar = answer.text; role.revision++; role.errorCode = null;
    emit(state, this.deps.clock, { type: "RoleCompleted", ...this.eventIds(turn, role) });
    settleTurn(state, turn, this.deps.clock);
  }

  private async execute(turn: TurnRecord, role: RoleRunRecord, token: CancellationToken): Promise<void> {
    try {
      if (!role.context.executionPolicy) throw new ContextFailure("CONTEXT_UNAVAILABLE");
      let evidence = role.evidence;
      if (role.status === "RETRIEVING") {
        const participant = role.context.participant;
        const retrieved = await this.external(token, async () => {
          const attempt = await this.prepare(turn.id, role.id, "RAG");
          if (!attempt || token.cancelled || this.retired || this.faulted) return null;
          return { attempt, raw: await this.deps.rag.retrieve({
            attemptId: attempt.id, roleRunId: role.id, connectionId: role.context.settings.ragConnectionId,
            query: role.context.question.text, corpusId: participant.corpusId, corpusRevision: participant.corpusRevision, retrievalConfigRevision: participant.retrievalConfigRevision,
          }, token) };
        });
        if (!retrieved) return;
        const { attempt } = retrieved;
        const result = RetrievalResultSchema.safeParse(retrieved.raw);
        if (!result.success) throw new ExecutionFailure("INVALID_PROVIDER_RESULT");
        if (!result.data.ok) throw new ExecutionFailure(result.data.code);
        evidence = result.data.evidence;
        if (!validEvidence(participant, evidence)) throw new ExecutionFailure("INVALID_PROVIDER_RESULT");
        if (!await this.update(turn.id, role.id, attempt.id, (state, storedTurn, storedRole, storedAttempt) => {
          transition("attempt", storedAttempt, "SUCCEEDED");
          transition("role", storedRole, "GENERATING");
          storedRole.evidence = evidence;
          emit(state, this.deps.clock, { type: "EvidenceCaptured", ...this.eventIds(storedTurn, storedRole) });
        })) return;
      }
      if (evidence.length === 0 && role.context.settings.knowledgeMode !== "FICTION") {
        await this.deps.store.transaction((state) => {
          const current = this.active(state, turn.id, role.id);
          if (current) this.completeRole(state, current.turn, current.role, insufficientEvidenceAnswer());
        });
        return;
      }
      await this.external(token, async () => {
        const input = await this.deps.store.read((state) => assembleContext(role.context, evidence, this.deps.modelExecution.counter, state));
        const attempt = await this.prepare(turn.id, role.id, "MODEL", input);
        if (!attempt || token.cancelled || this.retired || this.faulted) return;
        let draft = "";
        let checkpointLength = 0;
        for await (const raw of this.deps.model.generate(copy({ attemptId: attempt.id, roleRunId: role.id, context: input.context, evidence: input.evidence, input }), token)) {
          const parsed = ModelChunkSchema.safeParse(raw);
          if (!parsed.success) throw new ExecutionFailure("INVALID_PROVIDER_RESULT");
          const chunk = parsed.data;
          if (chunk.type === "failure") throw new ExecutionFailure(chunk.code);
          if (chunk.type === "delta") {
            draft += chunk.text;
            this.drafts.set(role.id, { attemptId: attempt.id, text: draft });
            if (draft.length - checkpointLength >= this.deps.draftCheckpointChars) {
              if (!await this.update(turn.id, role.id, attempt.id, (state, storedTurn, storedRole, storedAttempt) => {
                storedRole.textSoFar = draft; storedRole.revision++; storedAttempt.draft = draft;
                emit(state, this.deps.clock, { type: "RoleCheckpoint", ...this.eventIds(storedTurn, storedRole) });
              })) return;
              checkpointLength = draft.length;
            }
            continue;
          }
          if (!validAnswer(role.context.settings.knowledgeMode, evidence, chunk.answer)) throw new ExecutionFailure("INVALID_PROVIDER_RESULT");
          await this.update(turn.id, role.id, attempt.id, (state, storedTurn, storedRole, storedAttempt) => {
            this.completeRole(state, storedTurn, storedRole, chunk.answer, storedAttempt);
          });
          return;
          }
        throw new ExecutionFailure("OUTCOME_UNKNOWN");
      });
    } catch (error) {
      await this.deps.store.transaction((state) => {
        const current = this.active(state, turn.id, role.id);
        if (!current) return;
        this.checkpoint(state, current.turn);
        const outcome = error instanceof ExecutionFailure || error instanceof ContextFailure ? error.outcome : "OUTCOME_UNKNOWN";
        const attempt = current.role.attempts.at(-1);
        if (attempt?.status === "PREPARED") transition("attempt", attempt, "CANCELLED");
        else if (attempt?.status === "IN_FLIGHT") transition("attempt", attempt, outcome === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : "FAILED");
        const waiting = outcome === "OUTCOME_UNKNOWN";
        transition("role", current.role, waiting ? "WAITING_USER" : "FAILED");
        current.role.errorCode = outcome === "INVALID_PROVIDER_RESULT" || outcome === "BUDGET_EXCEEDED" || outcome === "CONTEXT_BUDGET_EXCEEDED" || outcome === "CONTEXT_UNAVAILABLE" ? outcome : "PROVIDER_FAILED";
        emit(state, this.deps.clock, { type: waiting ? "RoleWaiting" : "RoleFailed", ...this.eventIds(current.turn, current.role) });
        pauseQueue(state, current.turn, this.deps.clock);
        settleTurn(state, current.turn, this.deps.clock);
      });
    }
  }
}
