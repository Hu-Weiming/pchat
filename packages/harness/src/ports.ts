import type {
  Answer, CommandReceipt, ContextSnapshot, ConversationSettings, Evidence, ExternalAttempt,
  HarnessEvent, KnowledgeMode, QuestionStatus, RoleRunProjection, ThoughtStagePackage, TurnProjection,
} from "@pchat/contracts";

export type { Answer, ContextSnapshot, Evidence, ExternalAttempt, ThoughtStagePackage };
export interface Cancellation {
  readonly cancelled: boolean;
  subscribe(listener: () => void): () => void;
}
export interface RetrievalRequest {
  attemptId: string;
  roleRunId: string;
  connectionId: string;
  query: string;
  corpusId: string;
  corpusRevision: string;
  retrievalConfigRevision: string;
}
export type ProviderFailure = { ok: false; code: "REJECTED" | "OUTCOME_UNKNOWN" };
export type RetrievalResult = { ok: true; evidence: Evidence[] } | ProviderFailure;
export interface RAGPort { retrieve(request: RetrievalRequest, cancellation: Cancellation): Promise<RetrievalResult> }
export interface GenerationRequest {
  attemptId: string;
  roleRunId: string;
  context: ContextSnapshot;
  evidence: Evidence[];
}
export type ModelChunk = { type: "delta"; text: string } | { type: "complete"; answer: Answer } | { type: "failure"; code: "REJECTED" | "OUTCOME_UNKNOWN" };
export interface ModelPort { generate(request: GenerationRequest, cancellation: Cancellation): AsyncIterable<ModelChunk> }
export interface Clock { now(): number }
export interface IdGenerator { next(): string }

export type RoleRunRecord = RoleRunProjection;
export type TurnRecord = TurnProjection;
export interface QuestionRecord {
  id: string;
  text: string;
  status: QuestionStatus;
  turnId: string | null;
  submittedAt: number;
  settings: ConversationSettings;
  participant: ThoughtStagePackage;
}
export interface ConversationRecord {
  id: string;
  title: string;
  settings: ConversationSettings;
  queueStatus: "RUNNING" | "PAUSED";
  activeTurnId: string | null;
  questions: QuestionRecord[];
  turnIds: string[];
}
export interface RuntimeState {
  epoch: number;
  suspended: boolean;
  lastEventSeq: number;
  conversations: ConversationRecord[];
  turns: TurnRecord[];
  commands: { fingerprint: string; receipt: CommandReceipt }[];
  events: HarnessEvent[];
}

/** Callbacks are synchronous; no adapter I/O is allowed inside a transaction.
 * Adapters isolate both input and output references, serialize writers, roll back
 * exceptions, and notify only after commit. A notification is only a wake-up. */
export interface RuntimeStore {
  read<T>(reader: (snapshot: Readonly<RuntimeState>) => T): Promise<T>;
  transaction<T>(writer: (draft: RuntimeState) => T): Promise<T>;
  subscribe(listener: () => void): () => void;
}
export interface HarnessDependencies {
  store: RuntimeStore;
  model: ModelPort;
  rag: RAGPort;
  clock: Clock;
  ids: IdGenerator;
  roles: readonly ThoughtStagePackage[];
  limits: { maxActiveTurns: number; maxRoleRuns: number; maxExternalCalls: number; maxCostUnits: number };
  attemptCostUnits: { RAG: number; MODEL: number };
  draftCheckpointChars: number;
}

export type { KnowledgeMode };
