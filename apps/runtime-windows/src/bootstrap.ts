import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { createHarness, type HarnessDependencies } from "@pchat/harness";
import { openSqliteStore } from "@pchat/storage-sqlite";

export type RuntimePorts = Omit<HarnessDependencies, "store" | "clock" | "ids">;

/** The Windows composition root owns storage and platform clock/identity. */
export async function openWindowsRuntime(options: { stateDirectory: string; dependencies: RuntimePorts }) {
  if (!isAbsolute(options.stateDirectory)) throw new Error("Runtime state directory must be absolute.");
  const store = await openSqliteStore({ path: join(options.stateDirectory, "pchat.sqlite"), backupDirectory: join(options.stateDirectory, "backups") });
  try {
    const harness = await createHarness({ ...options.dependencies, store, clock: { now: () => Date.now() }, ids: { next: () => randomUUID() } });
    let closing: Promise<void> | undefined;
    return {
      harness,
      close(): Promise<void> {
        closing ??= (async () => {
          try {
            if (!(await store.read((state) => state.suspended))) {
              const receipt = await harness.dispatch({ type: "SuspendRuntime", commandId: randomUUID() });
              if (!receipt.ok) throw new Error("Runtime suspension failed.");
            }
          } finally { store.close(); }
        })();
        return closing;
      },
    };
  } catch (error) { store.close(); throw error; }
}
