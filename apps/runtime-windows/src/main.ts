import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import {
  HostResponseMessageSchema,
  PCHAT_PROTOCOL_VERSION,
  RuntimeRequestSchema,
  type HostResponseMessage,
  type RuntimeWireMessage,
} from "@pchat/contracts";

const RUNTIME_VERSION = "0.0.0-p0";
let nextHostRequestId = 1;
const pendingHostRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

function emit(message: RuntimeWireMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sqliteProbe(dataDirectory: string): Record<string, unknown> {
  mkdirSync(dataDirectory, { recursive: true });
  const runId = `${Date.now()}-${process.pid}`;
  const databasePath = join(dataDirectory, `p0-storage-${runId}.db`);
  const backupPath = `${databasePath}.backup-before-v2`;
  const recoveryPath = join(dataDirectory, `p0-recovery-${runId}.db`);
  const recoveryBackupPath = `${recoveryPath}.backup-before-v2`;

  const versionOne = new DatabaseSync(databasePath);
  try {
    versionOne.exec("PRAGMA foreign_keys = ON");
    versionOne.exec("PRAGMA journal_mode = WAL");
    versionOne.exec("PRAGMA busy_timeout = 5000");
    versionOne.exec(
      "CREATE TABLE p0_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1",
    );
    versionOne.prepare("INSERT INTO p0_probe (value) VALUES (?)").run("before-migration");
    versionOne.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    versionOne.close();
  }

  copyFileSync(databasePath, backupPath);

  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (2, datetime('now')); PRAGMA user_version = 2",
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const row = database
      .prepare("SELECT id, value FROM p0_probe LIMIT 1")
      .get() as { id: number; value: string };

    const backup = new DatabaseSync(backupPath, { readOnly: true });
    const backupVersion = backup.prepare("PRAGMA user_version").get();
    backup.close();

    const recoveryV1 = new DatabaseSync(recoveryPath);
    recoveryV1.exec(
      "CREATE TABLE recovery_marker (value TEXT NOT NULL); INSERT INTO recovery_marker VALUES ('safe-v1'); PRAGMA user_version = 1",
    );
    recoveryV1.close();
    copyFileSync(recoveryPath, recoveryBackupPath);

    let simulatedFailureDetected = false;
    const failingMigration = new DatabaseSync(recoveryPath);
    try {
      failingMigration.exec("BEGIN IMMEDIATE");
      failingMigration.exec("CREATE TABLE should_be_rolled_back (id INTEGER)");
      throw new Error("P0 simulated migration failure");
    } catch {
      failingMigration.exec("ROLLBACK");
      simulatedFailureDetected = true;
    } finally {
      failingMigration.close();
    }
    copyFileSync(recoveryBackupPath, recoveryPath);
    const restored = new DatabaseSync(recoveryPath, { readOnly: true });
    const restoredVersion = restored.prepare("PRAGMA user_version").get();
    const restoredMarker = restored
      .prepare("SELECT value FROM recovery_marker")
      .get();
    const rolledBackTable = restored
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'should_be_rolled_back'",
      )
      .get();
    restored.close();

    return {
      driver: "node:sqlite",
      databasePath,
      backupPath,
      foreignKeys: database.prepare("PRAGMA foreign_keys").get(),
      journalMode: database.prepare("PRAGMA journal_mode").get(),
      busyTimeout: database.prepare("PRAGMA busy_timeout").get(),
      schemaVersion: database.prepare("PRAGMA user_version").get(),
      backupSchemaVersion: backupVersion,
      recovery: {
        simulatedFailureDetected,
        restoredVersion,
        restoredMarker,
        rolledBackTable,
      },
      row,
    };
  } finally {
    database.close();
  }
}

function requestHost(method: "provider.send", params: Record<string, unknown>): Promise<unknown> {
  const requestId = `runtime-${nextHostRequestId++}`;
  emit({
    kind: "host.request",
    protocolVersion: PCHAT_PROTOCOL_VERSION,
    requestId,
    method,
    params,
  });
  return new Promise((resolve, reject) => {
    pendingHostRequests.set(requestId, { resolve, reject });
  });
}

function handleHostResponse(response: HostResponseMessage): void {
  const pending = pendingHostRequests.get(response.requestId);
  if (!pending) return;
  pendingHostRequests.delete(response.requestId);
  if (response.ok) pending.resolve(response.result);
  else pending.reject(new Error(response.error ?? "Host capability request failed"));
}

async function handleLine(line: string): Promise<void> {
  let requestId = "unknown";

  try {
    const parsed = JSON.parse(line) as unknown;
    const hostResponse = HostResponseMessageSchema.safeParse(parsed);
    if (hostResponse.success) {
      handleHostResponse(hostResponse.data);
      return;
    }

    const request = RuntimeRequestSchema.parse(parsed);
    requestId = request.requestId;

    let result: unknown;
    switch (request.method) {
      case "ping":
        result = {
          message: "pong",
          pid: process.pid,
          runtimeVersion: RUNTIME_VERSION,
        };
        break;
      case "sqliteProbe":
        result = sqliteProbe(String(request.params?.dataDirectory ?? ""));
        break;
      case "streamProbe":
        for (let index = 1; index <= 3; index += 1) {
          emit({
            kind: "runtime.event",
            protocolVersion: PCHAT_PROTOCOL_VERSION,
            event: "p0.stream-token",
            payload: { index, text: `片段 ${index}` },
          });
        }
        result = { emitted: 3 };
        break;
      case "providerPolicyProbe": {
        const approved = await requestHost("provider.send", {
          connectionId: "deepseek:personal-default",
          operation: "chat.completions",
        });
        let rejected: string;
        try {
          await requestHost("provider.send", {
            connectionId: "unapproved:credential",
            operation: "chat.completions",
          });
          rejected = "ERROR: unapproved connection was accepted";
        } catch (error) {
          rejected = error instanceof Error ? error.message : String(error);
        }
        result = { approved, rejected };
        break;
      }
      case "shutdown":
        result = { accepted: true };
        break;
    }

    emit({
      kind: "runtime.response",
      protocolVersion: PCHAT_PROTOCOL_VERSION,
      requestId,
      ok: true,
      result,
    });

    if (request.method === "shutdown") {
      input.close();
      process.stdin.pause();
      setImmediate(() => process.exit(0));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({
      kind: "runtime.response",
      protocolVersion: PCHAT_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: message,
    });
  }
}

const input = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

input.on("line", (line) => {
  void handleLine(line);
});

input.on("close", () => {
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`uncaughtException: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`unhandledRejection: ${String(reason)}\n`);
  process.exitCode = 1;
});

emit({
  kind: "runtime.ready",
  protocolVersion: PCHAT_PROTOCOL_VERSION,
  pid: process.pid,
  runtimeVersion: RUNTIME_VERSION,
});
