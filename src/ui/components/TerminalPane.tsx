import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerTerminalController,
  unregisterTerminalController,
} from "../terminal-control.ts";
import type { TerminalController } from "../terminal-control.ts";
import { connectTerminalSocket } from "../terminal-ws.ts";
import type { TerminalSocket } from "../terminal-ws.ts";
import { createXtermInstance } from "./xterm-adapter.ts";
import type { CreateXtermInstance, XtermInstance } from "./xterm-adapter.ts";

// 画面下部を占有する常設ターミナル領域（FR-09〜FR-11・FR-13・FR-20）。
// board は状態ファイルへ一切書き込まない（NFR-01）。本コンポーネントは
// タブ初回アクティブ時の pty WS 接続と xterm.js の描画に徹し、
// コマンドの自動実行（Enter 送信）はしない（prefill は未実行の文字列を
// 流し込むだけ）。

const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 800;
const DEFAULT_HEIGHT_PX = 320;

/** tmux セッション名の規約: `flywheel-<agent-name>`（src/server/pty/session.ts の terminalSessionName と同一規約）。 */
function terminalSessionName(agentName: string): string {
  return `flywheel-${agentName}`;
}

function buildTerminalWebSocketUrl(agent: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/terminal?agent=${encodeURIComponent(agent)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type BoardAgentsResponse = {
  agents?: { name: string }[];
};

async function defaultFetchAgents(): Promise<string[]> {
  try {
    const response = await fetch("/api/board");
    if (!response.ok) {
      return [];
    }
    const board = (await response.json()) as BoardAgentsResponse;
    return (board.agents ?? []).map((agent) => agent.name);
  } catch {
    // 取得失敗時はタブなし（空領域）で構わない。board 自体は落とさない。
    return [];
  }
}

export type TerminalPaneProps = {
  createXterm?: CreateXtermInstance;
  connect?: typeof connectTerminalSocket;
  fetchAgents?: () => Promise<string[]>;
};

type AgentConnection = {
  socket: TerminalSocket;
  xterm: XtermInstance;
};

export function TerminalPane({
  createXterm = createXtermInstance,
  connect = connectTerminalSocket,
  fetchAgents = defaultFetchAgents,
}: TerminalPaneProps) {
  const [agents, setAgents] = useState<string[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | undefined>(undefined);
  const [openedAgents, setOpenedAgents] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT_PX);

  const connectionsRef = useRef<Map<string, AgentConnection>>(new Map());
  const containerRefCallbacksRef = useRef<
    Map<string, (el: HTMLDivElement | null) => void>
  >(new Map());
  // agent がまだ opened になっていないうちに呼ばれた prefill を、
  // 接続確立（container mount）まで一時的に保持する。
  const pendingPrefillsRef = useRef<Map<string, string>>(new Map());
  // terminal-control 経由の prefill が、タブ一覧に無い agent 名を受け取った場合に
  // 弾くためのガード（サーバ側 resolveAgentEntry も未登録名を拒否するが、
  // クライアント側で無用な再接続ループを作らないよう二重に防御する）。
  const agentsRef = useRef<string[]>([]);

  const openAgent = useCallback((agent: string) => {
    setOpenedAgents((prev) => {
      if (prev.has(agent)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(agent);
      return next;
    });
  }, []);

  const ensureConnection = (
    agent: string,
    container: HTMLDivElement,
  ): AgentConnection => {
    const existing = connectionsRef.current.get(agent);
    if (existing) {
      return existing;
    }

    const xterm = createXterm(container);
    // 初回の open（接続確立直後）は下の同期呼び出しで既に fit/resize 済みのため
    // 再送しない。2回目以降の open（切断→再接続）でのみ再 fit+resize する。
    // pty は再接続のたびに新規 spawn され既定サイズ（80x24）に戻るため
    // （src/server/pty/pty-process.ts）、現在の表示サイズを送り直す必要がある。
    let hasOpenedOnce = false;
    const socket = connect({
      url: buildTerminalWebSocketUrl(agent),
      onData: (data) => {
        xterm.write(data);
      },
      onStatusChange: (status) => {
        if (status !== "open") {
          return;
        }
        if (hasOpenedOnce) {
          const { cols, rows } = xterm.fit();
          socket.resize(cols, rows);
        }
        hasOpenedOnce = true;
      },
    });
    xterm.onData((data) => {
      socket.sendInput(data);
    });

    const connection: AgentConnection = { socket, xterm };
    connectionsRef.current.set(agent, connection);

    const { cols, rows } = xterm.fit();
    socket.resize(cols, rows);

    const pendingCommand = pendingPrefillsRef.current.get(agent);
    if (pendingCommand !== undefined) {
      socket.prefill(pendingCommand);
      pendingPrefillsRef.current.delete(agent);
    }

    return connection;
  };

  const getContainerRefCallback = (agent: string) => {
    let callback = containerRefCallbacksRef.current.get(agent);
    if (!callback) {
      callback = (el) => {
        if (!el) {
          return;
        }
        ensureConnection(agent, el);
      };
      containerRefCallbacksRef.current.set(agent, callback);
    }
    return callback;
  };

  // mount 時に1回だけ /api/board を読み、タブ一覧を確定する（Board.tsx の WS
  // 購読とは独立。二重の WS 接続を避けるため意図的に REST の1回読みに留める）。
  useEffect(() => {
    let cancelled = false;
    fetchAgents()
      .then((names) => {
        if (!cancelled) {
          setAgents(names);
        }
      })
      .catch(() => {
        // 取得失敗時はタブなし（空領域）で構わない。board 自体は落とさない。
        if (!cancelled) {
          setAgents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAgents]);

  // 初回、agents 取得後まだ activeAgent が未設定なら先頭のエージェントを
  // 初回アクティブにする（＝最初のタブのみ接続。他は開かれるまで未接続）。
  useEffect(() => {
    if (activeAgent === undefined && agents.length > 0) {
      const first = agents[0];
      if (first !== undefined) {
        setActiveAgent(first);
        openAgent(first);
      }
    }
  }, [agents, activeAgent, openAgent]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // #16 の D&D／＋差し込み動線から呼ばれる prefill 公開 API に自身を登録する。
  useEffect(() => {
    const controller: TerminalController = {
      prefill(agent, command) {
        if (!agentsRef.current.includes(agent)) {
          // タブ一覧に無い agent 名は無視する（不明な接続を作らない）。
          return;
        }
        setActiveAgent(agent);
        openAgent(agent);
        const existing = connectionsRef.current.get(agent);
        if (existing) {
          existing.socket.prefill(command);
        } else {
          pendingPrefillsRef.current.set(agent, command);
        }
      },
    };
    registerTerminalController(controller);
    return () => {
      unregisterTerminalController(controller);
    };
  }, [openAgent]);

  // 表示中（非 collapsed）の xterm を re-fit して resize を伝搬する共通処理。
  // パネルの高さ変更・折りたたみ解除・タブ切替・window リサイズの4つの契機から
  // 呼ばれる（非表示中のペインは正しいサイズを計算できないため対象外）。
  const refitActiveConnection = useCallback(() => {
    if (collapsed || activeAgent === undefined) {
      return;
    }
    const connection = connectionsRef.current.get(activeAgent);
    if (!connection) {
      return;
    }
    const { cols, rows } = connection.xterm.fit();
    connection.socket.resize(cols, rows);
  }, [collapsed, activeAgent]);

  // window のリサイズに追従する。
  useEffect(() => {
    window.addEventListener("resize", refitActiveConnection);
    return () => {
      window.removeEventListener("resize", refitActiveConnection);
    };
  }, [refitActiveConnection]);

  // unmount 時に全ての接続を後始末する（非表示中のタブは display:none で
  // 維持する設計だが、コンポーネント自体が unmount される際はリークさせない）。
  useEffect(() => {
    return () => {
      for (const connection of connectionsRef.current.values()) {
        connection.socket.close();
        connection.xterm.dispose();
      }
      connectionsRef.current.clear();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: height は本体で読まないが高さドラッグのたびに再 fit を発火させる意図的なトリガー依存
  useEffect(() => {
    refitActiveConnection();
  }, [height, refitActiveConnection]);

  const handleTabClick = (agent: string) => {
    setActiveAgent(agent);
    openAgent(agent);
  };

  const handleResizeMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const startHeight = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY;
      setHeight(clamp(startHeight + delta, MIN_HEIGHT_PX, MAX_HEIGHT_PX));
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div
      className="terminal-pane"
      data-testid="terminal-pane"
      style={{ height: collapsed ? undefined : `${height}px` }}
    >
      <div
        className="terminal-pane-resize-handle"
        data-testid="terminal-resize-handle"
        onMouseDown={handleResizeMouseDown}
      />
      <div className="terminal-pane-header">
        <div className="terminal-tabs" role="tablist">
          {agents.map((agent) => (
            <button
              key={agent}
              type="button"
              role="tab"
              className="terminal-tab"
              aria-selected={agent === activeAgent}
              onClick={() => handleTabClick(agent)}
            >
              {terminalSessionName(agent)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="terminal-collapse-button"
          aria-label={collapsed ? "展開" : "折りたたむ"}
          onClick={() => setCollapsed((prev) => !prev)}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>
      {/* collapsed 時も DOM からアンマウントしない（常に mount したまま display:none
          で隠す）。条件付きレンダリングで unmount すると、xterm.js が
          terminal.open() 時にアタッチした内部 DOM がコンテナごと破棄され、
          再展開時に空表示へ戻ってしまう（xterm インスタンス自体は
          connectionsRef に生き残るが、描画先の DOM を失うため）。 */}
      <div
        className="terminal-pane-body"
        data-testid="terminal-pane-body"
        style={{ display: collapsed ? "none" : "block" }}
      >
        {[...openedAgents].map((agent) => (
          <div
            key={agent}
            className="terminal-pane-panel"
            style={{ display: agent === activeAgent ? "block" : "none" }}
            ref={getContainerRefCallback(agent)}
          />
        ))}
      </div>
    </div>
  );
}
