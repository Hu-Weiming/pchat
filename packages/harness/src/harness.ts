import { HarnessCommandSchema, HarnessQuerySchema, type HarnessCommand, type CommandReceipt, type ConversationProjection, type QueryMap, type QueryResult, type HarnessEvent } from "@pchat/contracts";
import type { ConversationRecord, HarnessDependencies } from "./ports";
import { copy, failure } from "./data";
import { eventStream } from "./events";
import { TurnCoordinator } from "./coordinator";
import { emit } from "./journal";
import { interruptActiveTurns, stopTurn } from "./control";
import { transition } from "./transitions";
import { validateConfiguration } from "./configuration";

export interface PchatHarness {
  dispatch(command: HarnessCommand): Promise<CommandReceipt>;
  query<K extends keyof QueryMap>(query: QueryMap[K]["request"] & { type: K }): Promise<QueryResult<QueryMap[K]["response"]>>;
  events(after?: number): AsyncIterable<HarnessEvent>;
}

function projectConversation(conversation: ConversationRecord): ConversationProjection {
  return {
    id: conversation.id, title: conversation.title, queueStatus: conversation.queueStatus,
    settings: conversation.settings,
    activeTurnId: conversation.activeTurnId, turnIds: conversation.turnIds,
    questions: conversation.questions.map(({ id, text, status, turnId, submittedAt }) => ({ id, text, status, turnId, submittedAt })),
  };
}

export async function createHarness(dependencies: HarnessDependencies): Promise<PchatHarness> {
  dependencies = validateConfiguration(dependencies);
  const { store, ids, clock } = dependencies;
  const roles = copy(dependencies.roles);
  const epoch = await store.transaction((state) => {
    interruptActiveTurns(state, clock);
    state.suspended = false;
    return ++state.epoch;
  });
  const coordinator = new TurnCoordinator(dependencies, epoch);
  coordinator.wake();
  return {
    async dispatch(input) {
      const parsed = HarnessCommandSchema.safeParse(input);
      let applied = false;
      const result = await store.transaction((state): CommandReceipt => {
        if (!parsed.success) return { ok: false, commandId: "", lastEventSeq: state.lastEventSeq, error: failure("INVALID_INPUT") };
        const command = parsed.data;
        if (coordinator.faulted) return { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("RUNTIME_UNAVAILABLE") };
        if (epoch !== state.epoch) return { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("RUNTIME_REPLACED") };
        const fingerprint = JSON.stringify(command);
        const prior = state.commands.find((item) => item.receipt.commandId === command.commandId);
        if (prior) return prior.fingerprint === fingerprint ? prior.receipt : { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("COMMAND_CONFLICT") };
        let receipt: CommandReceipt;
        if (command.type === "CreateConversation") {
          const participant = roles.find((role) => role.id === command.settings.participantId && role.status === "CONFIRMED");
          if (!participant) receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("NOT_FOUND") };
          else {
            const conversationId = ids.next();
            state.conversations.push({ id: conversationId, title: command.title, settings: command.settings, queueStatus: "RUNNING", activeTurnId: null, questions: [], turnIds: [] });
            state.events.push({ type: "ConversationCreated", conversationId, seq: ++state.lastEventSeq, at: clock.now() });
            receipt = { ok: true, commandId: command.commandId, conversationId, lastEventSeq: state.lastEventSeq };
          }
        } else if (command.type === "SubmitQuestion") {
          const conversation = state.conversations.find((item) => item.id === command.conversationId);
          const participant = roles.find((role) => role.id === conversation?.settings.participantId && role.status === "CONFIRMED");
          if (!conversation || !participant) receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("NOT_FOUND") };
          else {
            const questionId = ids.next();
            conversation.questions.push({ id: questionId, text: command.text, status: "QUEUED", turnId: null, submittedAt: clock.now(), settings: copy(conversation.settings), participant: copy(participant) });
            emit(state, clock, { type: "QuestionAccepted", conversationId: conversation.id, questionId });
            receipt = { ok: true, commandId: command.commandId, conversationId: conversation.id, questionId, lastEventSeq: state.lastEventSeq };
          }
        } else if (command.type === "ChangeParticipants") {
          const conversation = state.conversations.find((item) => item.id === command.conversationId);
          const participant = roles.find((role) => role.id === command.participantId && role.status === "CONFIRMED");
          if (!conversation || !participant) receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("NOT_FOUND") };
          else {
            conversation.settings.participantId = participant.id;
            emit(state, clock, { type: "ConversationChanged", conversationId: conversation.id });
            receipt = { ok: true, commandId: command.commandId, conversationId: conversation.id, lastEventSeq: state.lastEventSeq };
          }
        } else if (command.type === "StopTurn") {
          const turn = state.turns.find((item) => item.id === command.turnId);
          if (!turn || (turn.status !== "RUNNING" && turn.status !== "WAITING_USER")) receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure(turn ? "INVALID_TRANSITION" : "NOT_FOUND") };
          else {
            coordinator.checkpoint(state, turn);
            stopTurn(state, turn, clock);
            receipt = { ok: true, commandId: command.commandId, turnId: turn.id, lastEventSeq: state.lastEventSeq };
          }
        } else if (command.type === "ResumeQueue") {
          const conversation = state.conversations.find((item) => item.id === command.conversationId);
          const waiting = state.turns.some((turn) => turn.id === conversation?.activeTurnId && turn.status === "WAITING_USER");
          if (!conversation || waiting || conversation.queueStatus !== "PAUSED") receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure(!conversation ? "NOT_FOUND" : waiting ? "QUEUE_BLOCKED" : "INVALID_TRANSITION") };
          else {
            conversation.queueStatus = "RUNNING";
            emit(state, clock, { type: "QueueResumed", conversationId: conversation.id });
            receipt = { ok: true, commandId: command.commandId, conversationId: conversation.id, lastEventSeq: state.lastEventSeq };
          }
        } else if (command.type === "RegenerateRole") {
          const turn = state.turns.find((item) => item.roleRuns.some((role) => role.id === command.roleRunId));
          const role = turn?.roleRuns.find((item) => item.id === command.roleRunId);
          if (!turn || !role || turn.status !== "WAITING_USER" || role.status !== "WAITING_USER") receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure(!turn || !role ? "NOT_FOUND" : "INVALID_TRANSITION") };
          else if (state.turns.filter((item) => item.status === "RUNNING").length >= dependencies.limits.maxActiveTurns || state.turns.flatMap((item) => item.roleRuns).filter((item) => item.status === "RETRIEVING" || item.status === "GENERATING").length >= dependencies.limits.maxRoleRuns) receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("CAPACITY_EXCEEDED") };
          else {
            const previous = role.attempts.at(-1);
            const stage = previous?.kind === "MODEL" || (previous?.kind === "RAG" && previous.status === "SUCCEEDED") ? "GENERATING" : "RETRIEVING";
            transition("role", role, stage);
            transition("turn", turn, "RUNNING");
            const conversation = state.conversations.find((item) => item.id === turn.conversationId)!;
            transition("question", conversation.questions.find((item) => item.id === turn.questionId)!, "RUNNING");
            role.textSoFar = ""; role.revision++; role.errorCode = null;
            emit(state, clock, { type: "RoleStarted", conversationId: turn.conversationId, questionId: turn.questionId, turnId: turn.id, roleRunId: role.id });
            receipt = { ok: true, commandId: command.commandId, turnId: turn.id, roleRunId: role.id, lastEventSeq: state.lastEventSeq };
          }
        } else if (command.type === "WithdrawQuestion") {
          const conversation = state.conversations.find((item) => item.questions.some((question) => question.id === command.questionId));
          const question = conversation?.questions.find((item) => item.id === command.questionId);
          if (!conversation || !question || question.status !== "QUEUED") receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure(!question ? "NOT_FOUND" : "INVALID_TRANSITION") };
          else {
            transition("question", question, "WITHDRAWN");
            emit(state, clock, { type: "QuestionWithdrawn", conversationId: conversation.id, questionId: question.id });
            receipt = { ok: true, commandId: command.commandId, questionId: question.id, lastEventSeq: state.lastEventSeq };
          }
        } else if (command.type === "SuspendRuntime") {
          if (state.suspended) receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("INVALID_TRANSITION") };
          else {
            for (const turn of state.turns) coordinator.checkpoint(state, turn);
            interruptActiveTurns(state, clock);
            state.suspended = true;
            for (const conversation of state.conversations) if (conversation.queueStatus !== "PAUSED") {
              conversation.queueStatus = "PAUSED";
              emit(state, clock, { type: "QueuePaused", conversationId: conversation.id });
            }
            emit(state, clock, { type: "RuntimeSuspended" });
            receipt = { ok: true, commandId: command.commandId, lastEventSeq: state.lastEventSeq };
          }
        } else {
          const exhaustive: never = command;
          throw new Error(`Unsupported command: ${String(exhaustive)}`);
        }
        state.commands.push({ fingerprint, receipt });
        applied = receipt.ok;
        return receipt;
      });
      if (applied && parsed.success && parsed.data.type === "StopTurn") coordinator.cancel(parsed.data.turnId);
      if (applied && parsed.success && parsed.data.type === "SuspendRuntime") coordinator.cancelAll();
      coordinator.wake();
      return result;
    },
    async query<K extends keyof QueryMap>(input: QueryMap[K]["request"] & { type: K }): Promise<QueryResult<QueryMap[K]["response"]>> {
      const parsed = HarnessQuerySchema.safeParse(input);
      return store.read((state) => {
        if (coordinator.faulted) return { ok: false, error: failure("RUNTIME_UNAVAILABLE"), lastEventSeq: state.lastEventSeq };
        if (!parsed.success) return { ok: false, error: failure("INVALID_INPUT"), lastEventSeq: state.lastEventSeq };
        const request = parsed.data;
        if (request.type === "ListRoles") return { ok: true, data: roles, lastEventSeq: state.lastEventSeq };
        if (request.type === "ListConversations") return { ok: true, data: state.conversations.map(projectConversation), lastEventSeq: state.lastEventSeq };
        if (request.type === "GetTurn") {
          const turn = state.turns.find((item) => item.id === request.turnId);
          return turn ? { ok: true, data: turn, lastEventSeq: state.lastEventSeq } : { ok: false, error: failure("NOT_FOUND"), lastEventSeq: state.lastEventSeq };
        }
        const conversation = state.conversations.find((item) => item.id === request.conversationId);
        if (!conversation) return { ok: false, error: failure("NOT_FOUND"), lastEventSeq: state.lastEventSeq };
        return { ok: true, data: projectConversation(conversation), lastEventSeq: state.lastEventSeq };
      }) as Promise<QueryResult<QueryMap[K]["response"]>>;
    },
    events(after) { return eventStream(store, after) },
  };
}
