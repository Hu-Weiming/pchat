import type { PchatClient } from "@pchat/client";
import type { ModelBinding } from "@pchat/contracts";

export interface ModelOption { label: string; binding: ModelBinding; ready: boolean }
export interface RagOption { label: string; connectionId: string; readyCorpusIds: readonly string[] }
export interface WorkspaceProps {
  client: PchatClient;
  modelOptions: readonly ModelOption[];
  ragOptions: readonly RagOption[];
  onConfigureConnections(): void;
}
