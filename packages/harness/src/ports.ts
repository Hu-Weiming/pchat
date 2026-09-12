import type { CommandReceipt, ConversationSettings, HarnessEvent, QuestionStatus, TurnStatus, RoleStatus, AttemptStatus, KnowledgeMode } from "@pchat/contracts";

export interface ThoughtStagePackage {
  id: string;
  revision: string;
  label: string;
  status: "CONFIRMED" | "DRAFT";
  corpusId: string;
  corpusRevision: string;
  retrievalConfigRevision: string;
  promptPolicyRevision: string;
}

export interface Evidence {
  id: string;
  corpusId: string;
  corpusRevision: string;
  sourceId: string;
  sourceRevision: string;
  text: string;
  contentHash: string;
  locator: string | null;
  workTitle: string | null;
  edition: string | null;
  translator: string | null;
  kind: "PRIMARY" | "RESEARCH";
}

export interface Answer {
  text: string;
  kind: "PARAPHRASE" | "QUOTE" | "INFERENCE" | "FICTION" | "INSUFFICIENT_EVIDENCE";
  evidenceIds: string[];
}
export interface ContextSnapshot {
  question: { id: string; text: string };
  settings: ConversationSettings;
  participant: ThoughtStagePackage;
  history: { turnId: string; question: string; answer: string }[];
}
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

export interface ExternalAttempt {
  id: string;
  kind: "RAG" | "MODEL";
  status: AttemptStatus;
  previousAttemptId: string | null;
  reservedCostUnits: number;
  draft: string;
}
export interface RoleRunRecord {
  id: string;
  status: RoleStatus;
  textSoFar: string;
  revision: number;
  evidence: Evidence[];
  answer: Answer | null;
  attempts: ExternalAttempt[];
  errorCode: string | null;
}
export interface TurnRecord {
  id: string;
  conversationId: string;
  questionId: string;
  status: TurnStatus;
  context: ContextSnapshot;
  roleRuns: RoleRunRecord[];
}
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
