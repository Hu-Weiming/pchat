import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openSqliteStore } from "./index";

const devRoot = process.env.PCHAT_DEV_ROOT;
if (!devRoot || !isAbsolute(devRoot)) throw new Error("PCHAT_DEV_ROOT must be absolute");
const tempRoot = resolve(devRoot, "temp", "pchat");
mkdirSync(tempRoot, { recursive: true });
const directories: string[] = [];
function options() {
  const directory = mkdtempSync(join(tempRoot, "sqlite-migration-"));
  directories.push(directory);
  return { path: join(directory, "runtime.db"), backupDirectory: join(directory, "backups") };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error("Refusing cleanup outside test temporary directory");
    rmSync(target, { recursive: true, force: true });
  }
});

it("refuses a newer schema before writing application state", async () => {
  const configuration = options();
  const future = new DatabaseSync(configuration.path);
  future.exec("CREATE TABLE future_marker(value TEXT); INSERT INTO future_marker VALUES ('preserve me'); PRAGMA user_version = 99");
  future.close();
  let accidental: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await expect(openSqliteStore(configuration).then((store) => { accidental = store; return "opened"; })).rejects.toThrow("newer");
  } finally { accidental?.close(); }
  const unchanged = new DatabaseSync(configuration.path, { readOnly: true });
  try {
    expect(unchanged.prepare("SELECT value FROM future_marker").get()?.value).toBe("preserve me");
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(99);
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_meta'").get()).toBeUndefined();
  } finally { unchanged.close(); }
});

it("backs up committed WAL content before upgrading an older database", async () => {
  const configuration = options();
  const old = new DatabaseSync(configuration.path);
  old.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
  old.exec(readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8"));
  old.exec("UPDATE runtime_meta SET epoch = 17");
  let upgraded: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    upgraded = await openSqliteStore(configuration);
    expect(await upgraded.read((state) => state.epoch)).toBe(17);
    const backups = readdirSync(configuration.backupDirectory).filter((name) => name.endsWith(".sqlite"));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(configuration.backupDirectory, backups[0]!), { readOnly: true });
    try {
      expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(backup.prepare("SELECT epoch FROM runtime_meta").get()?.epoch).toBe(17);
      expect(backup.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
    } finally { backup.close(); }
    expect(old.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(old.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version)).toEqual([1, 2, 3]);
  } finally { upgraded?.close(); old.close(); }
});

it("a failed backup stops migration and releases ownership without altering the old state", async () => {
  const configuration = options();
  const old = new DatabaseSync(configuration.path);
  old.exec(readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8"));
  old.exec("UPDATE runtime_meta SET epoch = 23");
  old.close();
  writeFileSync(configuration.backupDirectory, "A file cannot be a backup directory");
  await expect(openSqliteStore(configuration)).rejects.toThrow();
  const unchanged = new DatabaseSync(configuration.path, { readOnly: true });
  try {
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(unchanged.prepare("SELECT epoch FROM runtime_meta").get()?.epoch).toBe(23);
  } finally { unchanged.close(); }
  const recovered = await openSqliteStore({ ...configuration, backupDirectory: `${configuration.backupDirectory}-usable` });
  try { expect(await recovered.read((state) => state.epoch)).toBe(23); }
  finally { recovered.close(); }
});

it("rolls back a failed migration and keeps its consistent backup", async () => {
  const configuration = options();
  const old = new DatabaseSync(configuration.path);
  old.exec(readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8"));
  old.exec("UPDATE runtime_meta SET epoch = 31; CREATE TABLE idx_turns_status(value TEXT)");
  old.close();
  await expect(openSqliteStore(configuration)).rejects.toThrow();
  const unchanged = new DatabaseSync(configuration.path);
  try {
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(unchanged.prepare("SELECT epoch FROM runtime_meta").get()?.epoch).toBe(31);
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_questions_queue'").get()).toBeUndefined();
    expect(unchanged.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)).toEqual([1]);
    expect(readdirSync(configuration.backupDirectory).filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
    unchanged.exec("DROP TABLE idx_turns_status");
  } finally { unchanged.close(); }
  const recovered = await openSqliteStore(configuration);
  try { expect(await recovered.read((state) => state.epoch)).toBe(31); }
  finally { recovered.close(); }
});

it("refuses an unversioned foreign database without creating runtime tables", async () => {
  const configuration = options();
  const foreign = new DatabaseSync(configuration.path);
  foreign.exec("CREATE TABLE another_app(value TEXT)");
  foreign.close();
  await expect(openSqliteStore(configuration)).rejects.toThrow("Unrecognized");
  const unchanged = new DatabaseSync(configuration.path, { readOnly: true });
  try {
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)).toEqual(["another_app"]);
  } finally { unchanged.close(); }
});
