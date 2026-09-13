-- Generated from cc48b20 using the real v2 Harness and SQLite adapter.
BEGIN;
PRAGMA defer_foreign_keys = ON;
CREATE TABLE runtime_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  suspended INTEGER NOT NULL CHECK(suspended IN (0, 1)),
  last_event_seq INTEGER NOT NULL CHECK(last_event_seq >= 0)
) STRICT;
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, title TEXT NOT NULL,
  settings_json TEXT NOT NULL, queue_status TEXT NOT NULL,
  active_turn_id TEXT REFERENCES turns(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE questions (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  ordinal INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
  turn_id TEXT REFERENCES turns(id) DEFERRABLE INITIALLY DEFERRED,
  submitted_at REAL NOT NULL, settings_json TEXT NOT NULL, participant_json TEXT NOT NULL,
  UNIQUE(conversation_id, ordinal)
) STRICT;
CREATE TABLE turns (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  question_id TEXT NOT NULL UNIQUE REFERENCES questions(id), ordinal INTEGER NOT NULL UNIQUE,
  conversation_ordinal INTEGER NOT NULL, status TEXT NOT NULL, context_json TEXT NOT NULL,
  UNIQUE(conversation_id, conversation_ordinal)
) STRICT;
CREATE TABLE role_runs (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id), ordinal INTEGER NOT NULL,
  status TEXT NOT NULL, text_so_far TEXT NOT NULL, revision INTEGER NOT NULL,
  answer_json TEXT, error_code TEXT, UNIQUE(turn_id, ordinal)
) STRICT;
CREATE TABLE external_attempts (
  id TEXT PRIMARY KEY, role_run_id TEXT NOT NULL REFERENCES role_runs(id), ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL,
  previous_attempt_id TEXT REFERENCES external_attempts(id) DEFERRABLE INITIALLY DEFERRED,
  reserved_cost_units REAL NOT NULL CHECK(reserved_cost_units >= 0), draft TEXT NOT NULL,
  UNIQUE(role_run_id, ordinal)
) STRICT;
CREATE TABLE evidence_snapshots (
  role_run_id TEXT NOT NULL REFERENCES role_runs(id), id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL, PRIMARY KEY(role_run_id, id), UNIQUE(role_run_id, ordinal)
) STRICT;
CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL
) STRICT;
CREATE TABLE event_journal (seq INTEGER PRIMARY KEY, event_json TEXT NOT NULL) STRICT;
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
CREATE INDEX idx_questions_queue ON questions(conversation_id, status, ordinal);
CREATE INDEX idx_turns_status ON turns(status);
CREATE INDEX idx_attempts_status ON external_attempts(status);
INSERT INTO runtime_meta VALUES (1, 1, 0, 22);
INSERT INTO conversations VALUES ('fake-1-1', 0, 'Legacy single-role discussion', '{"participantId":"test-role","knowledgeMode":"PRIMARY","model":{"connectionId":"model-test","modelId":"fake-model","configRevision":"model-v1"},"ragConnectionId":"rag-test"}', 'PAUSED', 'fake-1-8');
INSERT INTO questions VALUES ('fake-1-2', 'fake-1-1', 0, 'A completed historical question', 'COMPLETED', 'fake-1-3', 1000, '{"participantId":"test-role","knowledgeMode":"PRIMARY","model":{"connectionId":"model-test","modelId":"fake-model","configRevision":"model-v1"},"ragConnectionId":"rag-test"}', '{"id":"test-role","revision":"role-v1","label":"Test thought stage","status":"CONFIRMED","corpusId":"test-corpus","corpusRevision":"corpus-v1","retrievalConfigRevision":"retrieval-v1","promptPolicyRevision":"prompt-v1"}');
INSERT INTO questions VALUES ('fake-1-7', 'fake-1-1', 1, 'An uncertain historical question', 'WAITING_USER', 'fake-1-8', 1000, '{"participantId":"test-role","knowledgeMode":"PRIMARY","model":{"connectionId":"model-test","modelId":"fake-model","configRevision":"model-v1"},"ragConnectionId":"rag-test"}', '{"id":"test-role","revision":"role-v1","label":"Test thought stage","status":"CONFIRMED","corpusId":"test-corpus","corpusRevision":"corpus-v1","retrievalConfigRevision":"retrieval-v1","promptPolicyRevision":"prompt-v1"}');
INSERT INTO questions VALUES ('fake-1-12', 'fake-1-1', 2, 'A question still in the queue', 'QUEUED', NULL, 1000, '{"participantId":"test-role","knowledgeMode":"PRIMARY","model":{"connectionId":"model-test","modelId":"fake-model","configRevision":"model-v1"},"ragConnectionId":"rag-test"}', '{"id":"test-role","revision":"role-v1","label":"Test thought stage","status":"CONFIRMED","corpusId":"test-corpus","corpusRevision":"corpus-v1","retrievalConfigRevision":"retrieval-v1","promptPolicyRevision":"prompt-v1"}');
INSERT INTO turns VALUES ('fake-1-3', 'fake-1-1', 'fake-1-2', 0, 0, 'COMPLETED', '{"question":{"id":"fake-1-2","text":"A completed historical question"},"settings":{"participantId":"test-role","knowledgeMode":"PRIMARY","model":{"connectionId":"model-test","modelId":"fake-model","configRevision":"model-v1"},"ragConnectionId":"rag-test"},"participant":{"id":"test-role","revision":"role-v1","label":"Test thought stage","status":"CONFIRMED","corpusId":"test-corpus","corpusRevision":"corpus-v1","retrievalConfigRevision":"retrieval-v1","promptPolicyRevision":"prompt-v1"},"history":[]}');
INSERT INTO turns VALUES ('fake-1-8', 'fake-1-1', 'fake-1-7', 1, 1, 'WAITING_USER', '{"question":{"id":"fake-1-7","text":"An uncertain historical question"},"settings":{"participantId":"test-role","knowledgeMode":"PRIMARY","model":{"connectionId":"model-test","modelId":"fake-model","configRevision":"model-v1"},"ragConnectionId":"rag-test"},"participant":{"id":"test-role","revision":"role-v1","label":"Test thought stage","status":"CONFIRMED","corpusId":"test-corpus","corpusRevision":"corpus-v1","retrievalConfigRevision":"retrieval-v1","promptPolicyRevision":"prompt-v1"},"history":[{"turnId":"fake-1-3","question":"A completed historical question","answer":"A test paraphrase about: A completed historical question"}]}');
INSERT INTO role_runs VALUES ('fake-1-4', 'fake-1-3', 0, 'COMPLETED', 'A test paraphrase about: A completed historical question', 1, '{"text":"A test paraphrase about: A completed historical question","kind":"PARAPHRASE","evidenceIds":["test-evidence"]}', NULL);
INSERT INTO role_runs VALUES ('fake-1-9', 'fake-1-8', 0, 'WAITING_USER', 'Second historical draft', 3, NULL, 'PROVIDER_FAILED');
INSERT INTO external_attempts VALUES ('fake-1-5', 'fake-1-4', 0, 'RAG', 'SUCCEEDED', NULL, 1, '');
INSERT INTO external_attempts VALUES ('fake-1-6', 'fake-1-4', 1, 'MODEL', 'SUCCEEDED', NULL, 1, 'A test paraphrase about: A completed historical question');
INSERT INTO external_attempts VALUES ('fake-1-10', 'fake-1-9', 0, 'RAG', 'SUCCEEDED', NULL, 1, '');
INSERT INTO external_attempts VALUES ('fake-1-11', 'fake-1-9', 1, 'MODEL', 'OUTCOME_UNKNOWN', NULL, 1, 'Historical draft before an unknown outcome');
INSERT INTO external_attempts VALUES ('fake-1-13', 'fake-1-9', 2, 'MODEL', 'OUTCOME_UNKNOWN', 'fake-1-11', 1, 'Second historical draft');
INSERT INTO evidence_snapshots VALUES ('fake-1-4', 'test-evidence', 0, '{"id":"test-evidence","corpusId":"test-corpus","corpusRevision":"corpus-v1","sourceId":"test-source","sourceRevision":"source-v1","text":"A test passage about freedom.","contentHash":"test-content-hash","locator":"section 1","workTitle":"Test work","edition":"Test edition","translator":null,"kind":"PRIMARY"}');
INSERT INTO evidence_snapshots VALUES ('fake-1-9', 'test-evidence', 0, '{"id":"test-evidence","corpusId":"test-corpus","corpusRevision":"corpus-v1","sourceId":"test-source","sourceRevision":"source-v1","text":"A test passage about freedom.","contentHash":"test-content-hash","locator":"section 1","workTitle":"Test work","edition":"Test edition","translator":null,"kind":"PRIMARY"}');
INSERT INTO command_receipts VALUES ('legacy-create', 0, '{"type":"CreateConversation","commandId":"legacy-create","title":"Legacy single-role discussion","settings":{"participantId":"test-role","knowledgeMode":"PRIMARY","model":{"connectionId":"model-test","modelId":"fake-model","configRevision":"model-v1"},"ragConnectionId":"rag-test"}}', '{"ok":true,"commandId":"legacy-create","conversationId":"fake-1-1","lastEventSeq":1}');
INSERT INTO command_receipts VALUES ('legacy-first', 1, '{"type":"SubmitQuestion","commandId":"legacy-first","conversationId":"fake-1-1","text":"A completed historical question"}', '{"ok":true,"commandId":"legacy-first","conversationId":"fake-1-1","questionId":"fake-1-2","lastEventSeq":2}');
INSERT INTO command_receipts VALUES ('legacy-change', 2, '{"type":"ChangeParticipants","commandId":"legacy-change","conversationId":"fake-1-1","participantId":"test-role"}', '{"ok":true,"commandId":"legacy-change","conversationId":"fake-1-1","lastEventSeq":8}');
INSERT INTO command_receipts VALUES ('legacy-second', 3, '{"type":"SubmitQuestion","commandId":"legacy-second","conversationId":"fake-1-1","text":"An uncertain historical question"}', '{"ok":true,"commandId":"legacy-second","conversationId":"fake-1-1","questionId":"fake-1-7","lastEventSeq":9}');
INSERT INTO command_receipts VALUES ('legacy-queued', 4, '{"type":"SubmitQuestion","commandId":"legacy-queued","conversationId":"fake-1-1","text":"A question still in the queue"}', '{"ok":true,"commandId":"legacy-queued","conversationId":"fake-1-1","questionId":"fake-1-12","lastEventSeq":13}');
INSERT INTO command_receipts VALUES ('legacy-regenerate', 5, '{"type":"RegenerateRole","commandId":"legacy-regenerate","roleRunId":"fake-1-9"}', '{"ok":true,"commandId":"legacy-regenerate","turnId":"fake-1-8","roleRunId":"fake-1-9","lastEventSeq":18}');
INSERT INTO command_receipts VALUES ('legacy-rejected', 6, '{"type":"SubmitQuestion","commandId":"legacy-rejected","conversationId":"missing","text":"Rejected historical question"}', '{"ok":false,"commandId":"legacy-rejected","lastEventSeq":22,"error":{"code":"NOT_FOUND","message":"The requested item was not found."}}');
INSERT INTO event_journal VALUES (1, '{"type":"ConversationCreated","conversationId":"fake-1-1","seq":1,"at":1000}');
INSERT INTO event_journal VALUES (2, '{"type":"QuestionAccepted","conversationId":"fake-1-1","questionId":"fake-1-2","seq":2,"at":1000}');
INSERT INTO event_journal VALUES (3, '{"type":"TurnStarted","conversationId":"fake-1-1","questionId":"fake-1-2","turnId":"fake-1-3","seq":3,"at":1000}');
INSERT INTO event_journal VALUES (4, '{"type":"RoleStarted","conversationId":"fake-1-1","questionId":"fake-1-2","turnId":"fake-1-3","roleRunId":"fake-1-4","seq":4,"at":1000}');
INSERT INTO event_journal VALUES (5, '{"type":"EvidenceCaptured","conversationId":"fake-1-1","questionId":"fake-1-2","turnId":"fake-1-3","roleRunId":"fake-1-4","seq":5,"at":1000}');
INSERT INTO event_journal VALUES (6, '{"type":"RoleCompleted","conversationId":"fake-1-1","questionId":"fake-1-2","turnId":"fake-1-3","roleRunId":"fake-1-4","seq":6,"at":1000}');
INSERT INTO event_journal VALUES (7, '{"type":"TurnCompleted","conversationId":"fake-1-1","questionId":"fake-1-2","turnId":"fake-1-3","seq":7,"at":1000}');
INSERT INTO event_journal VALUES (8, '{"type":"ConversationChanged","conversationId":"fake-1-1","seq":8,"at":1000}');
INSERT INTO event_journal VALUES (9, '{"type":"QuestionAccepted","conversationId":"fake-1-1","questionId":"fake-1-7","seq":9,"at":1000}');
INSERT INTO event_journal VALUES (10, '{"type":"TurnStarted","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","seq":10,"at":1000}');
INSERT INTO event_journal VALUES (11, '{"type":"RoleStarted","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","roleRunId":"fake-1-9","seq":11,"at":1000}');
INSERT INTO event_journal VALUES (12, '{"type":"EvidenceCaptured","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","roleRunId":"fake-1-9","seq":12,"at":1000}');
INSERT INTO event_journal VALUES (13, '{"type":"QuestionAccepted","conversationId":"fake-1-1","questionId":"fake-1-12","seq":13,"at":1000}');
INSERT INTO event_journal VALUES (14, '{"type":"RoleCheckpoint","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","roleRunId":"fake-1-9","seq":14,"at":1000}');
INSERT INTO event_journal VALUES (15, '{"type":"RoleWaiting","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","roleRunId":"fake-1-9","seq":15,"at":1000}');
INSERT INTO event_journal VALUES (16, '{"type":"TurnWaiting","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","seq":16,"at":1000}');
INSERT INTO event_journal VALUES (17, '{"type":"QueuePaused","conversationId":"fake-1-1","seq":17,"at":1000}');
INSERT INTO event_journal VALUES (18, '{"type":"RoleStarted","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","roleRunId":"fake-1-9","seq":18,"at":1000}');
INSERT INTO event_journal VALUES (19, '{"type":"RoleCheckpoint","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","roleRunId":"fake-1-9","seq":19,"at":1000}');
INSERT INTO event_journal VALUES (20, '{"type":"RoleWaiting","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","roleRunId":"fake-1-9","seq":20,"at":1000}');
INSERT INTO event_journal VALUES (21, '{"type":"TurnWaiting","conversationId":"fake-1-1","questionId":"fake-1-7","turnId":"fake-1-8","seq":21,"at":1000}');
INSERT INTO event_journal VALUES (22, '{"type":"QueuePaused","conversationId":"fake-1-1","seq":22,"at":1000}');
INSERT INTO schema_migrations VALUES (1, '2026-09-13T17:05:43.467Z');
INSERT INTO schema_migrations VALUES (2, '2026-09-13T17:05:43.468Z');
PRAGMA application_id = 1346586708;
PRAGMA user_version = 2;
COMMIT;
