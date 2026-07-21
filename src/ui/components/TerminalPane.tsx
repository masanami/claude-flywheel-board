import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerTerminalController,
  unregisterTerminalController,
} from "../terminal-control.ts";
import type { TerminalController } from "../terminal-control.ts";
import { connectTerminalSocket } from "../terminal-ws.ts";
import type { TerminalSocket } from "../terminal-ws.ts";
import { createAttachInputGate } from "./attach-input-gate.ts";
import type { AttachInputGate } from "./attach-input-gate.ts";
import { createXtermInstance } from "./xterm-adapter.ts";
import type { CreateXtermInstance, XtermInstance } from "./xterm-adapter.ts";

// 画面下部を占有する常設ターミナル領域（FR-09〜FR-11・FR-13・FR-20）。
// board は状態ファイルへ一切書き込まない（NFR-01）。本コンポーネントは
// タブ初回アクティブ時の pty WS 接続と xterm.js の描画に徹し、
// コマンドの自動実行（Enter 送信）はしない（prefill は未実行の文字列を
// 流し込むだけ）。
//
// #57（ターミナルペインの縦分割）: 各エージェントタブは「左=エージェント
// （kind=agent）／右=手動シェル（kind=shell）」の常時2分割で表示する。
// 別々の WS 接続（＝別々の tmux セッション）を張るため、prefill は
// エージェント側の接続にのみ配線し、shell 側の接続オブジェクトへは
// 本コンポーネントから一切 prefill を呼び出さない（サーバ側でも構造的に
// 弾かれる。src/server/pty/bridge.ts の allowPrefill 参照）。

const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 800;
const DEFAULT_HEIGHT_PX = 320;

// エージェント（左）ペインの幅（px）。シェル（右）ペインは残り幅を flex で埋める。
// 高さの調整ハンドル（上端バー）と同じ「固定 px を人間が直接動かす」設計にし、
// 分割比率を pixel 単位で扱うことでコンテナ幅の実測（getBoundingClientRect）に
// 依存しない、テスト容易でシンプルな実装にする（KISS）。
const MIN_AGENT_PANE_WIDTH_PX = 200;
const MAX_AGENT_PANE_WIDTH_PX = 1200;
const DEFAULT_AGENT_PANE_WIDTH_PX = 480;
const SPLIT_STEP_PX = 32;

type PaneKind = "agent" | "shell";
const PANE_KINDS: readonly PaneKind[] = ["agent", "shell"];

function buildTerminalWebSocketUrl(agent: string, kind: PaneKind): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/terminal?agent=${encodeURIComponent(agent)}&kind=${kind}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** agent + kind の複合キー。ペインごとの接続・xterm・container ref を一意に識別する。 */
function connectionKey(agent: string, kind: PaneKind): string {
  return `${agent}::${kind}`;
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
  gate: AttachInputGate;
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
  const [agentPaneWidth, setAgentPaneWidth] = useState(
    DEFAULT_AGENT_PANE_WIDTH_PX,
  );

  const connectionsRef = useRef<Map<string, AgentConnection>>(new Map());
  const containerRefCallbacksRef = useRef<
    Map<string, (el: HTMLDivElement | null) => void>
  >(new Map());
  // agent（左＝エージェント接続）がまだ opened になっていないうちに呼ばれた
  // prefill を、接続確立（container mount）まで一時的に保持する。
  // 単一の値ではなく配列キューにしているのは、接続確立前に連続して prefill が
  // 呼ばれた場合に後勝ちで上書きせず、全件を届いた順番のまま流し込むため。
  // shell 側は prefill の対象にならないため、このキューはエージェント接続専用。
  const pendingPrefillsRef = useRef<Map<string, string[]>>(new Map());
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
    kind: PaneKind,
    container: HTMLDivElement,
  ): AgentConnection => {
    const key = connectionKey(agent, kind);
    const existing = connectionsRef.current.get(key);
    if (existing) {
      return existing;
    }

    const xterm = createXterm(container);
    // tmux は attach のたびに既存ペインの内容（シェル起動時の端末問い合わせ
    // シーケンスを含み得る）を再生し、xterm.js がそれへ自動応答（DA1/DA2/DSR
    // 等）してしまうことがある。xterm の onData は自動応答とユーザーの実操作を
    // 区別できないため、実操作（keydown/paste/IME変換開始）を観測するまで
    // input 送信を抑止するゲートを挟む（#27 フォローアップ）。エージェント・
    // シェルの各ペインは独立した container を持つため、ゲートも独立に働く。
    const gate = createAttachInputGate(container);
    // 初回の open（接続確立直後）は下の同期呼び出しで既に fit/resize 済みのため
    // 再送しない。2回目以降の open（切断→再接続）でのみ再 fit+resize する。
    // pty は再接続のたびに新規 spawn され既定サイズ（80x24）に戻るため
    // （src/server/pty/pty-process.ts）、現在の表示サイズを送り直す必要がある。
    let hasOpenedOnce = false;
    const socket = connect({
      url: buildTerminalWebSocketUrl(agent, kind),
      onData: (data) => {
        xterm.write(data);
      },
      onStatusChange: (status) => {
        if (status !== "open") {
          return;
        }
        // 再接続（＝再 attach）のたびに tmux の再生ノイズが起き得るため、
        // 初回・再接続を問わず毎回ゲートを閉じ直す。
        gate.reset();
        if (hasOpenedOnce) {
          const { cols, rows } = xterm.fit();
          socket.resize(cols, rows);
        }
        hasOpenedOnce = true;
      },
    });
    xterm.onData((data) => {
      if (!gate.isOpen()) {
        return;
      }
      socket.sendInput(data);
    });

    const connection: AgentConnection = { socket, xterm, gate };
    connectionsRef.current.set(key, connection);

    const { cols, rows } = xterm.fit();
    socket.resize(cols, rows);

    // prefill の宛先は常にエージェント（kind: "agent"）接続のみ。shell 接続
    // （kind: "shell"）は pendingPrefillsRef を一切参照しない（#57 クリティカル
    // 設計決定: shell ペインは prefill レジストリに登録しない）。
    if (kind === "agent") {
      const pendingCommands = pendingPrefillsRef.current.get(agent);
      if (pendingCommands !== undefined) {
        for (const command of pendingCommands) {
          socket.prefill(command);
        }
        pendingPrefillsRef.current.delete(agent);
      }
    }

    return connection;
  };

  const getContainerRefCallback = (agent: string, kind: PaneKind) => {
    const key = connectionKey(agent, kind);
    let callback = containerRefCallbacksRef.current.get(key);
    if (!callback) {
      callback = (el) => {
        if (!el) {
          return;
        }
        ensureConnection(agent, kind, el);
      };
      containerRefCallbacksRef.current.set(key, callback);
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
        // 折りたたみ中は対象ペインが不可視のため、流し込む前に必ず展開する
        // （D&D・差し込みの指示文が不可視ペインへ流れて「無反応に見える」問題の回避）。
        setCollapsed(false);
        setActiveAgent(agent);
        openAgent(agent);
        // prefill は常にエージェント（左）側接続のみを対象にする。shell（右）
        // 接続は connectionsRef 上に存在しても、ここから参照すること自体が無い
        // （#57 クリティカル設計決定）。
        const key = connectionKey(agent, "agent");
        const existing = connectionsRef.current.get(key);
        if (existing) {
          existing.socket.prefill(command);
        } else {
          const pending = pendingPrefillsRef.current.get(agent) ?? [];
          pending.push(command);
          pendingPrefillsRef.current.set(agent, pending);
        }
      },
    };
    registerTerminalController(controller);
    return () => {
      unregisterTerminalController(controller);
    };
  }, [openAgent]);

  // 表示中（非 collapsed）の xterm（agent・shell 両ペイン）を re-fit して resize を
  // 伝搬する共通処理。パネルの高さ変更・分割比率変更・折りたたみ解除・タブ切替・
  // window リサイズの5つの契機から呼ばれる（非表示中のペインは正しいサイズを
  // 計算できないため対象外）。
  const refitActiveConnection = useCallback(() => {
    if (collapsed || activeAgent === undefined) {
      return;
    }
    for (const kind of PANE_KINDS) {
      const connection = connectionsRef.current.get(
        connectionKey(activeAgent, kind),
      );
      if (!connection) {
        continue;
      }
      const { cols, rows } = connection.xterm.fit();
      connection.socket.resize(cols, rows);
    }
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
        connection.gate.dispose();
      }
      connectionsRef.current.clear();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: height は本体で読まないが高さドラッグのたびに再 fit を発火させる意図的なトリガー依存
  useEffect(() => {
    refitActiveConnection();
  }, [height, refitActiveConnection]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: agentPaneWidth は本体で読まないが分割比率変更のたびに再 fit を発火させる意図的なトリガー依存
  useEffect(() => {
    refitActiveConnection();
  }, [agentPaneWidth, refitActiveConnection]);

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

  const handleSplitMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = agentPaneWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      setAgentPaneWidth(
        clamp(
          startWidth + delta,
          MIN_AGENT_PANE_WIDTH_PX,
          MAX_AGENT_PANE_WIDTH_PX,
        ),
      );
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleSplitKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // マウスドラッグの代替経路（既存の高さリサイズ・#25/#39 のキーボード操作の
    // パターンに合わせる）。ArrowLeft/Right で32pxずつ増減し、既存の clamp で
    // 範囲内に収める。
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setAgentPaneWidth((prev) =>
        clamp(
          prev - SPLIT_STEP_PX,
          MIN_AGENT_PANE_WIDTH_PX,
          MAX_AGENT_PANE_WIDTH_PX,
        ),
      );
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setAgentPaneWidth((prev) =>
        clamp(
          prev + SPLIT_STEP_PX,
          MIN_AGENT_PANE_WIDTH_PX,
          MAX_AGENT_PANE_WIDTH_PX,
        ),
      );
    }
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
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={height}
        aria-valuemin={MIN_HEIGHT_PX}
        aria-valuemax={MAX_HEIGHT_PX}
        aria-label="ターミナルパネルの高さ"
        tabIndex={0}
        onMouseDown={handleResizeMouseDown}
        onKeyDown={(event) => {
          // マウスドラッグの代替経路（#25）。ArrowUp/Down で32pxずつ増減し、
          // 既存の clamp で範囲内に収める。setHeight を呼べば再fit用
          // useEffect（[height, refitActiveConnection] 依存）が自動的に走る。
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setHeight((prev) => clamp(prev + 32, MIN_HEIGHT_PX, MAX_HEIGHT_PX));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setHeight((prev) => clamp(prev - 32, MIN_HEIGHT_PX, MAX_HEIGHT_PX));
          }
        }}
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
              {agent}
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
        {/* #57: 各タブは常時「左=エージェント／右=手動シェル」の2分割。
            トグルは無い（設計決定どおり常時表示）。 */}
        {[...openedAgents].map((agent) => (
          <div
            key={agent}
            className="terminal-pane-split"
            data-testid={`terminal-panel-${agent}`}
            style={{ display: agent === activeAgent ? "flex" : "none" }}
          >
            <div
              className="terminal-pane-panel terminal-pane-panel-agent"
              data-testid={`terminal-panel-${agent}-agent`}
              style={{ width: `${agentPaneWidth}px` }}
              ref={getContainerRefCallback(agent, "agent")}
            />
            <div
              className="terminal-pane-splitter"
              // パネル側（terminal-panel-${agent}-agent/-shell）と同様に agent で
              // 一意化する。openedAgents は非アクティブなタブも display:none で
              // DOM に残したまま維持するため、agent 名を含めないと複数タブを
              // 開いた際に同一 data-testid の要素が DOM 上に複数存在してしまう
              // （セルフレビュー指摘: #57）。
              data-testid={`terminal-split-handle-${agent}`}
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={agentPaneWidth}
              aria-valuemin={MIN_AGENT_PANE_WIDTH_PX}
              aria-valuemax={MAX_AGENT_PANE_WIDTH_PX}
              aria-label={`ターミナル分割比率（エージェント/シェル） - ${agent}`}
              tabIndex={0}
              onMouseDown={handleSplitMouseDown}
              onKeyDown={handleSplitKeyDown}
            />
            <div
              className="terminal-pane-panel terminal-pane-panel-shell"
              data-testid={`terminal-panel-${agent}-shell`}
              ref={getContainerRefCallback(agent, "shell")}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
