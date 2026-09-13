import { DatabaseSync } from "node:sqlite";

/** The file is permanent. Ownership is the OS-backed SQLite lock, never its
 * existence or a PID timestamp. Keeping this connection open covers migrations. */
export function acquireOwner(databasePath: string): DatabaseSync {
  const owner = new DatabaseSync(`${databasePath}.owner.sqlite`, { timeout: 0 });
  try {
    const mode = owner.prepare("PRAGMA journal_mode = DELETE").get();
    if (mode?.journal_mode !== "delete") throw new Error("Runtime owner requires a rollback journal");
    owner.exec("BEGIN EXCLUSIVE");
    return owner;
  } catch (error) {
    owner.close();
    if (error && typeof error === "object" && "errcode" in error && (error.errcode === 5 || error.errcode === 6)) {
      throw new Error("SQLite database is already owned by another Runtime");
    }
    throw error;
  }
}

export function releaseOwner(owner: DatabaseSync): void {
  try { if (owner.isTransaction) owner.exec("ROLLBACK"); }
  finally { if (owner.isOpen) owner.close(); }
}
