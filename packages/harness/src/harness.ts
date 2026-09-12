import { HarnessCommandSchema, HarnessQuerySchema, type HarnessCommand, type CommandReceipt, type ConversationProjection, type QueryMap, type QueryResult, type HarnessEvent } from "@pchat/contracts";
import type { ConversationRecord, HarnessDependencies } from "./ports";
import { copy, failure } from "./data";
import { eventStream } from "./events";
import { TurnCoordinator } from "./coordinator";
import { emit } from "./journal";

export interface PchatHarness {
  dispatch(command: HarnessCommand): Promise<CommandReceipt>;
  query<K extends keyof QueryMap>(query: QueryMap[K]["request"] & { type: K }): Promise<QueryResult<QueryMap[K]["response"]>>;
  events(after?: number): AsyncIterable<HarnessEvent>;
}

function projectConversation(conversation: ConversationRecord): ConversationProjection {
  return {
    id: conversation.id, title: conversation.title, queueStatus: conversation.queueStatus,
    activeTurnId: conversation.activeTurnId, turnIds: conversation.turnIds,
    questions: conversation.questions.map(({ id, text, status, turnId, submittedAt }) => ({ id, text, status, turnId, submittedAt })),
  };
}

export async function createHarness(dependencies: HarnessDependencies): Promise<PchatHarness> {
  const { store, ids, clock } = dependencies;
  const roles = copy(dependencies.roles);
  const epoch = await store.transaction((state) => ++state.epoch);
  const coordinator = new TurnCoordinator(dependencies, epoch);
  coordinator.wake();
  return {
    async dispatch(input) {
      const parsed = HarnessCommandSchema.safeParse(input);
      const result = await store.transaction((state): CommandReceipt => {
        if (!parsed.success) return { ok: false, commandId: "", lastEventSeq: state.lastEventSeq, error: failure("INVALID_INPUT") };
        const command = parsed.data;
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
        } else receipt = { ok: false, commandId: command.commandId, lastEventSeq: state.lastEventSeq, error: failure("INVALID_TRANSITION") };
        state.commands.push({ fingerprint, receipt });
        return receipt;
      });
      coordinator.wake();
      return result;
    },
    async query<K extends keyof QueryMap>(input: QueryMap[K]["request"] & { type: K }): Promise<QueryResult<QueryMap[K]["response"]>> {
      const parsed = HarnessQuerySchema.safeParse(input);
      return store.read((state) => {
        if (!parsed.success) return { ok: false, error: failure("INVALID_INPUT"), lastEventSeq: state.lastEventSeq };
        const request = parsed.data;
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
