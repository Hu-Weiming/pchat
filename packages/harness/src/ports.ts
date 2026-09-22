import type {
  Answer, CommandReceipt, ContextSnapshot, ConversationSettings, Evidence, ExternalAttempt,
  HarnessEvent, KnowledgeMode, QuestionStatus, RoleRunProjection, ThoughtStagePackage, TurnProjection,
  ModelExecutionPolicy, ModelInputContent, ModelInputSnapshot,
  PlanningInput, DiscussionInput, DiscussionPlan, DiscussionAnswer,
} from "@pchat/contracts";

export type { Answer, ContextSnapshot, Evidence, ExternalAttempt, ThoughtStagePackage, ModelExecutionPolicy, ModelInputContent, ModelInputSnapshot };
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
  input?: ModelInputSnapshot;
}
/** Counts the provider's actual rendered input, including its system rules and
 * message framing. The version and accuracy mode belong to the frozen policy. */
export interface TokenCounter { readonly version: string; count(input: ModelInputContent, policy: ModelExecutionPolicy): number }
export type ModelChunk = { type: "delta"; text: string } | { type: "complete"; answer: Answer } | { type: "failure"; code: "REJECTED" | "OUTCOME_UNKNOWN" };
export interface ModelPort { generate(request: GenerationRequest, cancellation: Cancellation): AsyncIterable<ModelChunk> }
export interface DiscussionModelPort {
  /** Upper bound for the provider's rendered final request, including prompts.
   * Audit-only source metadata must not consume the model's context budget. */
  countInput?(input: DiscussionInput): number;
  plan(request: { attemptId: string; input: PlanningInput }, cancellation: Cancellation): Promise<{ ok: true; plan: DiscussionPlan } | ProviderFailure>;
  discuss(request: { attemptId: string; input: DiscussionInput; onDraft?: (draft: { roleId: string; text: string }) => Promise<void> }, cancellation: Cancellation): Promise<{ ok: true; answer: DiscussionAnswer } | ProviderFailure>;
}
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
  participants: ThoughtStagePackage[];
  executionPolicy?: ModelExecutionPolicy | null;
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
export interface CommitNotice {
  epoch: number;
  suspended: boolean;
  runnableTurnIds: readonly string[];
}
export interface RuntimeStore {
  read<T>(reader: (snapshot: Readonly<RuntimeState>) => T): Promise<T>;
  transaction<T>(writer: (draft: RuntimeState) => T): Promise<T>;
  /** Synchronously send the current notice on subscribe, then after every
   * committed write and before its Promise resolves. This revokes execution
   * permission independently of delayed transaction acknowledgements. */
  subscribe(listener: (notice: CommitNotice) => void): () => void;
}
export interface HarnessDependencies {
  store: RuntimeStore;
  model: ModelPort;
  discussionModel?: DiscussionModelPort;
  rag: RAGPort;
  clock: Clock;
  ids: IdGenerator;
  roles: readonly ThoughtStagePackage[];
  limits: { maxActiveTurns: number; maxRoleRuns: number; maxExternalCalls: number; maxCostUnits: number };
  attemptCostUnits: { RAG: number; MODEL: number };
  draftCheckpointChars: number;
  modelExecution: { policies: readonly ModelExecutionPolicy[]; counter: TokenCounter };
}

export type { KnowledgeMode };
