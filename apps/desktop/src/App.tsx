import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@pchat/client";
import { createWindowsTransport } from "./platform/windows-transport";
import { Workspace, type ModelOption, type RagOption } from "./ui/Workspace";
import { SettingsDialog } from "./SettingsDialog";

export function App() {
  const [revision, setRevision] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [options, setOptions] = useState<{ models: ModelOption[]; retrieval: RagOption[] }>({ models: [], retrieval: [] });
  const client = useMemo(() => createClient({ ids: { next: () => crypto.randomUUID() }, transport: createWindowsTransport({
    request: (request) => invoke("pchat_runtime_request", { request }),
    listen: (handler) => listen("pchat://runtime-event", ({ payload }) => handler(payload)),
  }, { next: () => crypto.randomUUID() }) }), [revision]);
  const refresh = useCallback(() => {
    void invoke<{ models: ModelOption[]; retrieval: RagOption[] }>("pchat_connection_options").then(setOptions).catch(() => setOptions({ models: [], retrieval: [] }));
  }, []);
  useEffect(refresh, [refresh, revision]);
  return <><Workspace client={client} modelOptions={options.models} ragOptions={options.retrieval} onConfigureConnections={() => setSettingsOpen(true)} />
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={() => setRevision((value) => value + 1)} />}</>;
}
