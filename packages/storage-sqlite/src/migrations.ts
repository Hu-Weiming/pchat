import { mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { MODEL_INPUTS_SQL, SCHEMA_SQL } from "./schema";
import { migrateToVersionThree } from "./migrate-v3";
import { readState } from "./records";

const APPLICATION_ID = 0x50434854;
const SCHEMA_VERSION = 4;
const INDEXES_SQL = `CREATE INDEX idx_questions_queue ON questions(conversation_id, status, ordinal);
  CREATE INDEX idx_turns_status ON turns(status);
  CREATE INDEX idx_attempts_status ON external_attempts(status);`;

function verifyDatabase(database: DatabaseSync): void {
  if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("SQLite integrity check failed");
  }
  readState(database);
}

async function backupBeforeMigration(database: DatabaseSync, directory: string, version: number): Promise<void> {
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `before-v${version + 1}-${randomUUID()}.sqlite`);
  const incomplete = `${destination}.incomplete`;
  await backup(database, incomplete);
  const verified = new DatabaseSync(incomplete, { readOnly: true });
  try {
    if (verified.prepare("PRAGMA quick_check").get()?.quick_check !== "ok"
      || verified.prepare("PRAGMA user_version").get()?.user_version !== version
      || verified.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID
      || verified.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("Migration backup verification failed");
    }
  } finally { verified.close(); }
  renameSync(incomplete, destination);
}

export async function initializeDatabase(database: DatabaseSync, backupDirectory: string): Promise<void> {
  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  if (typeof version !== "number") throw new Error("Invalid database schema version");
  if (version > SCHEMA_VERSION) throw new Error("Database schema is newer than this application");
  if (version === 0 && database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) {
    throw new Error("Unrecognized database schema; refusing to migrate");
  }
  if (version !== 0 && database.prepare("PRAGMA application_id").get()?.application_id !== APPLICATION_ID) {
    throw new Error("Database belongs to an unknown application");
  }
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 2000");
  if (database.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1
    || database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal"
    || database.prepare("PRAGMA synchronous").get()?.synchronous !== 2
    || database.prepare("PRAGMA busy_timeout").get()?.timeout !== 2000) {
    throw new Error("Required SQLite durability settings are unavailable");
  }
  if (version === SCHEMA_VERSION) { verifyDatabase(database); return; }
  if (version > 0) await backupBeforeMigration(database, backupDirectory, version);
  database.exec("BEGIN IMMEDIATE");
  try {
    if (version === 0) {
      database.exec(SCHEMA_SQL);
      database.exec(INDEXES_SQL);
      database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    } else {
      if (version === 1) {
        database.exec(INDEXES_SQL);
        database.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(2, new Date().toISOString());
      }
      if (version < 3) {
        migrateToVersionThree(database);
        database.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(3, new Date().toISOString());
      }
      database.exec(MODEL_INPUTS_SQL);
      database.exec("ALTER TABLE questions ADD COLUMN execution_policy_json TEXT");
    }
    database.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(SCHEMA_VERSION, new Date().toISOString());
    database.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
    verifyDatabase(database);
    database.exec("COMMIT");
  } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
}
