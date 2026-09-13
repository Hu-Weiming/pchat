import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommitNotice, RuntimeState, RuntimeStore } from "@pchat/harness";
import { readState, writeState } from "./records";
import { initializeDatabase } from "./migrations";
import { acquireOwner, releaseOwner } from "./owner";

export interface SqliteStoreOptions { path: string; backupDirectory: string }

function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

export class SqliteRuntimeStore implements RuntimeStore {
  private readonly listeners = new Set<(notice: CommitNotice) => void>();
  private closed = false;
  private lastNotice: CommitNotice;
  constructor(private readonly database: DatabaseSync, private readonly owner: DatabaseSync) { this.lastNotice = this.noticeFor(this.snapshot()); }

  private assertOpen(): void { if (this.closed) throw new Error("SQLite store is closed"); }

  private snapshot(): RuntimeState {
    this.assertOpen();
    return readState(this.database);
  }
  async read<T>(reader: (state: Readonly<RuntimeState>) => T): Promise<T> { return clone(reader(this.snapshot())); }
  async transaction<T>(writer: (state: RuntimeState) => T): Promise<T> {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      const previous = this.snapshot();
      const state = clone(previous);
      const outcome = writer(state);
      if (outcome && typeof outcome === "object" && "then" in outcome && typeof outcome.then === "function") {
        void Promise.resolve(outcome).catch(() => {});
        throw new Error("RuntimeStore transaction callbacks must be synchronous.");
      }
      result = clone(outcome);
      writeState(this.database, previous, state);
      const notice = this.noticeFor(state);
      this.database.exec("COMMIT");
      this.lastNotice = notice;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
    this.publish();
    return result;
  }
  private noticeFor(state: RuntimeState): CommitNotice {
    return { epoch: state.epoch, suspended: state.suspended, runnableTurnIds: state.turns.filter((turn) => turn.status === "RUNNING").map((turn) => turn.id) };
  }
  private publish(): void {
    for (const listener of [...this.listeners]) {
      try { listener(clone(this.lastNotice)); } catch { /* A subscriber cannot roll back a committed write. */ }
    }
  }
  subscribe(listener: (notice: CommitNotice) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    try { listener(clone(this.lastNotice)); } catch { /* Initial notices follow the same isolation. */ }
    return () => { this.listeners.delete(listener); };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lastNotice = { ...this.lastNotice, suspended: true, runnableTurnIds: [] };
    this.publish();
    this.listeners.clear();
    try { this.database.close(); } finally { releaseOwner(this.owner); }
  }
}

export async function openSqliteStore(options: SqliteStoreOptions): Promise<SqliteRuntimeStore> {
  if (!isAbsolute(options.path) || !isAbsolute(options.backupDirectory)) throw new Error("SQLite database and backup paths must be absolute");
  mkdirSync(dirname(options.path), { recursive: true });
  const path = existsSync(options.path) ? realpathSync(options.path) : join(realpathSync(dirname(options.path)), basename(options.path));
  const owner = acquireOwner(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    await initializeDatabase(database, options.backupDirectory);
    return new SqliteRuntimeStore(database, owner);
  } catch (error) {
    try { database?.close(); } finally { releaseOwner(owner); }
    throw error;
  }
}
