import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type { RuntimeStatus } from "@pchat/contracts";

interface ProbeResult {
  message?: string;
  driver?: string;
  [key: string]: unknown;
}

const initialStatus: RuntimeStatus = {
  state: "starting",
  generation: 0,
  protocolVersion: 1,
};

export function App() {
  const [status, setStatus] = useState<RuntimeStatus>(initialStatus);
  const [result, setResult] = useState<string>("等待检测");
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    const next = await invoke<RuntimeStatus>("p0_runtime_status");
    setStatus(next);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const unlisten = listen<{ event: string; payload: unknown }>(
      "pchat://runtime-event",
      ({ payload }) => {
        setEvents((current) => [...current, JSON.stringify(payload)].slice(-8));
      },
    );
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [refreshStatus]);

  async function run(label: string, command: string) {
    setBusy(true);
    try {
      const value = await invoke<ProbeResult>(command);
      setResult(`${label}成功\n${JSON.stringify(value, null, 2)}`);
    } catch (error) {
      setResult(`${label}失败\n${String(error)}`);
    } finally {
      await refreshStatus();
      setBusy(false);
    }
  }

  return (
    <main>
      <header>
        <p className="eyebrow">P0 技术验证</p>
        <h1>Pchat 运行环境诊断</h1>
        <p>这个临时界面只验证桌面外壳、后台进程、私有通信和 SQLite。</p>
      </header>

      <section className="status-card">
        <span className={`indicator ${status.state}`} />
        <div>
          <strong>后台状态：{status.state}</strong>
          <p>
            进程：{status.pid ?? "—"} · 第 {status.generation} 次启动 · 协议 {status.protocolVersion}
          </p>
        </div>
      </section>

      <section className="actions" aria-label="P0 检测操作">
        <button disabled={busy} onClick={() => void run("通信检测", "p0_runtime_ping")}>检测后台通信</button>
        <button disabled={busy} onClick={() => void run("SQLite 检测", "p0_sqlite_probe")}>检测 SQLite</button>
        <button disabled={busy} onClick={() => void run("流式事件检测", "p0_stream_probe")}>检测流式消息</button>
        <button disabled={busy} onClick={() => void run("受限 API 通道检测", "p0_provider_policy_probe")}>检测密钥边界</button>
        <button disabled={busy} onClick={() => void run("启动", "p0_runtime_start")}>启动后台</button>
        <button disabled={busy} onClick={() => void run("停止", "p0_runtime_stop")}>停止后台</button>
      </section>

      <pre aria-live="polite">{result}</pre>
      {events.length > 0 && (
        <section>
          <h2>最近收到的流式消息</h2>
          <pre>{events.join("\n")}</pre>
        </section>
      )}

      <footer>
        <button className="quiet" onClick={() => void invoke("p0_explicit_exit")}>保存并退出 Pchat</button>
      </footer>
    </main>
  );
}
