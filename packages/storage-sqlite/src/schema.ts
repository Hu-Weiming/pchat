export const SCHEMA_SQL = `
CREATE TABLE runtime_meta (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  suspended INTEGER NOT NULL CHECK(suspended IN (0, 1)),
  last_event_seq INTEGER NOT NULL CHECK(last_event_seq >= 0)
) STRICT;
INSERT INTO runtime_meta VALUES (1, 0, 0, 0);
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
`;
