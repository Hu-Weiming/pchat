import type { PchatClient } from "@pchat/client";
import type { CommandReceipt, ConversationProjection, HarnessCommand, HarnessEvent, ThoughtStagePackage, TurnProjection } from "@pchat/contracts";
type WithoutIdentity<T> = T extends HarnessCommand ? Omit<T, "commandId"> : never;
export type WorkspaceCommand = WithoutIdentity<HarnessCommand>;

export interface WorkspaceSnapshot {
  status: "loading" | "ready" | "offline";
  conversations: ConversationProjection[];
  roles: ThoughtStagePackage[];
  selectedConversationId: string | null;
  turns: TurnProjection[];
  error: string | null;
  busy: boolean;
  pendingCommand: HarnessCommand | null;
}

const errors: Record<string, string> = {
  NOT_FOUND: "所选对话或已确认资料包不可用，请刷新后重新选择。",
  INVALID_INPUT: "请检查输入内容与人物选择。",
  INVALID_TRANSITION: "这项操作不适用于当前状态，页面已刷新。",
  QUEUE_BLOCKED: "请先处理本轮等待确认的回答，再恢复队列。",
  CAPACITY_EXCEEDED: "当前正在处理的回答已达上限，请稍后再试。",
  BUDGET_EXCEEDED: "本次运行已达到费用上限，请检查连接与预算设置。",
  COMMAND_CONFLICT: "这次操作与已保存的请求不一致，请重新连接后检查历史。",
};
export function createWorkspaceController(client: PchatClient, nextId: () => string) {
  let state: WorkspaceSnapshot = { status: "loading", conversations: [], roles: [], selectedConversationId: null, turns: [], error: null, busy: false, pendingCommand: null };
  const listeners = new Set<() => void>();
  let epoch = 0;
  let active = false;
  let selectionMade = false;
  let selectionVersion = 0;
  let streamFailed = false;
  let iterator: AsyncIterator<HarnessEvent> | undefined;
  let dirty = false;
  let refreshing: Promise<number | undefined> | undefined;
  const update = (change: Partial<WorkspaceSnapshot>) => {
    state = { ...state, ...change };
    for (const listener of listeners) { try { listener(); } catch { /* A view cannot stop other observers. */ } }
  };
  const current = (session: number) => active && epoch === session;
  async function load(session: number): Promise<number | undefined> {
    const selection = selectionVersion;
    const [conversations, roles] = await Promise.all([client.query({ type: "ListConversations" }), client.query({ type: "ListRoles" })]);
    if (!current(session)) return;
    if (!conversations.ok || !roles.ok) throw new Error("Workspace query failed");
    const selectedConversationId = selectionMade ? state.selectedConversationId : conversations.data[0]?.id ?? null;
    const selected = conversations.data.find((conversation) => conversation.id === selectedConversationId);
    const turns = await Promise.all((selected?.turnIds ?? []).map((turnId) => client.query({ type: "GetTurn", turnId })));
    if (!current(session)) return;
    if (turns.some((turn) => !turn.ok)) throw new Error("A saved answer could not be read");
    if (selection !== selectionVersion) { dirty = true; return Math.min(conversations.lastEventSeq, roles.lastEventSeq); }
    selectionMade = true;
    update({ status: streamFailed ? "offline" : "ready", conversations: conversations.data, roles: roles.data,
      selectedConversationId: selected?.id ?? null, turns: turns.flatMap((turn) => turn.ok ? [turn.data] : []) });
    return Math.min(conversations.lastEventSeq, roles.lastEventSeq);
  }
  function refresh(): Promise<number | undefined> {
    dirty = true;
    if (refreshing) return refreshing;
    const session = epoch;
    const work = (async () => {
      let bookmark: number | undefined;
      try {
        do { dirty = false; bookmark = await load(session); } while (dirty && current(session));
      } catch {
        if (current(session)) update({ status: "offline", error: "暂时无法读取对话。请重新连接，历史内容会从保存的记录恢复。" });
      }
      return bookmark;
    })();
    refreshing = work;
    void work.finally(() => { if (refreshing === work) refreshing = undefined; });
    return work;
  }
  async function observe(events: AsyncIterator<HarnessEvent>, session: number) {
    try {
      while (current(session)) {
        const event = await events.next();
        if (!current(session)) return;
        if (event.done) throw new Error("Event stream ended");
        void refresh();
      }
    } catch {
      if (current(session)) {
        streamFailed = true;
        update({ status: "offline", error: "连接已中断。重新连接后将恢复最新进度。" });
      }
    }
  }
  function stop() {
    active = false;
    epoch++;
    const closing = iterator;
    iterator = undefined;
    refreshing = undefined;
    if (closing?.return) void Promise.resolve(closing.return()).catch(() => {});
  }
  async function send(command: HarnessCommand): Promise<CommandReceipt | undefined> {
    if (state.busy) return;
    update({ busy: true, pendingCommand: command, error: null });
    try {
      const receipt = await client.dispatch(command);
      if (receipt.ok && command.type === "CreateConversation" && receipt.conversationId) {
        selectionMade = true;
        selectionVersion++;
        update({ selectedConversationId: receipt.conversationId, turns: [] });
      }
      update({ busy: false, pendingCommand: null, error: receipt.ok ? null : errors[receipt.error.code] ?? "操作未完成，请重新连接并检查当前状态。" });
      if (active) await refresh();
      return receipt;
    } catch {
      update({ busy: false, error: "操作回执尚未确认。请重查这次操作的结果，系统会沿用原请求，避免重复提交。" });
      return;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    selectConversation(conversationId: string | null) {
      selectionMade = true;
      selectionVersion++;
      update({ selectedConversationId: conversationId, turns: [] });
      if (active) void refresh();
    },
    async execute(command: WorkspaceCommand) {
      if (state.busy || state.pendingCommand) return;
      return send({ ...command, commandId: nextId() });
    },
    async retryPending() { if (state.pendingCommand && !state.busy) return send(state.pendingCommand); },
    async start() {
      stop();
      active = true;
      streamFailed = false;
      const session = epoch;
      update({ status: "loading", error: null });
      const bookmark = await refresh();
      if (!current(session) || bookmark === undefined) return;
      try { iterator = client.events(bookmark)[Symbol.asyncIterator](); void observe(iterator, session); }
      catch { streamFailed = true; update({ status: "offline", error: "暂时无法订阅对话进度，请重新连接。" }); }
    },
    stop,
  };
}
