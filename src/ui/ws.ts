import type {
  AgentBoard,
  BoardSnapshot,
  MdFileChangedMessage,
  MdSubscribeErrorMessage,
} from "./board-types.ts";

// React に依存しない純粋な WS 購読モジュール。Board.tsx から呼び出される。
// board は状態ファイルへ一切書き込まない（NFR-01）。
//
// Issue #70: プレビュー（PreviewPanel）のライブ更新結線のため、既存の受信専用
// （snapshot/agent_update）モジュールへ md_subscribe/md_unsubscribe の送信と
// md_file_changed/md_subscribe_error の受信を追加する。新しい WS 接続は
// 追加で開かない（既存の唯一の /ws 接続にメッセージ種別を足すだけ）。

export type ConnectionStatus = "connecting" | "open" | "closed";

export type BoardSocketOptions = {
  url: string;
  onSnapshot: (board: BoardSnapshot) => void;
  onAgentUpdate: (agent: AgentBoard) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  // Issue #70: プレビュー対象ファイルの変更通知・購読エラー通知（省略可。
  // Board.tsx 以外の既存呼び出し元・テストに影響を与えないため optional にする）。
  onMdFileChanged?: (message: MdFileChangedMessage) => void;
  onMdSubscribeError?: (message: MdSubscribeErrorMessage) => void;
  WebSocketImpl?: typeof WebSocket;
  reconnectDelayMs?: number;
};

export type BoardSocket = {
  close(): void;
  /** プレビュー対象ファイルの購読を要求する（md_subscribe を送信する）。 */
  subscribeMd(repo: string, path: string): void;
  /** プレビュー対象ファイルの購読解除を要求する（md_unsubscribe を送信する）。 */
  unsubscribeMd(repo: string, path: string): void;
};

const DEFAULT_RECONNECT_DELAY_MS = 1000;

type IncomingMessage =
  | { type: "snapshot"; board: BoardSnapshot }
  | { type: "agent_update"; agent: AgentBoard }
  | MdFileChangedMessage
  | MdSubscribeErrorMessage;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// type 判別だけでなくペイロードの形も検証し、不正なメッセージは破棄する
// （型アサーションだけに頼らず実行時に確認する）。
function isValidBoardSnapshot(value: unknown): value is BoardSnapshot {
  return isPlainObject(value) && Array.isArray(value.agents);
}

function isValidAgentBoard(value: unknown): value is AgentBoard {
  return (
    isPlainObject(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.challenges) &&
    Array.isArray(value.parseErrors)
  );
}

// md_file_changed / md_subscribe_error は共に { repo: string; path: string }
// のペイロードを持つ（サーバ側の型定義 src/server/md/watch.ts を参照）。
function hasValidRepoPath(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { repo: string; path: string } {
  return typeof value.repo === "string" && typeof value.path === "string";
}

function parseMessage(data: unknown): IncomingMessage | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isPlainObject(parsed)) {
      return undefined;
    }
    if (parsed.type === "snapshot" && isValidBoardSnapshot(parsed.board)) {
      return { type: "snapshot", board: parsed.board };
    }
    if (parsed.type === "agent_update" && isValidAgentBoard(parsed.agent)) {
      return { type: "agent_update", agent: parsed.agent };
    }
    if (parsed.type === "md_file_changed" && hasValidRepoPath(parsed)) {
      return {
        type: "md_file_changed",
        repo: parsed.repo,
        path: parsed.path,
      };
    }
    if (parsed.type === "md_subscribe_error" && hasValidRepoPath(parsed)) {
      return {
        type: "md_subscribe_error",
        repo: parsed.repo,
        path: parsed.path,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function connectBoardSocket(options: BoardSocketOptions): BoardSocket {
  const WebSocketCtor = options.WebSocketImpl ?? WebSocket;
  const reconnectDelayMs =
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let closedByClient = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | undefined;

  const setStatus = (status: ConnectionStatus) => {
    options.onStatusChange?.(status);
  };

  const open = () => {
    setStatus("connecting");
    const ws = new WebSocketCtor(options.url);
    socket = ws;

    ws.addEventListener("open", () => {
      setStatus("open");
    });

    ws.addEventListener("message", (event: unknown) => {
      const data = (event as MessageEvent).data;
      const message = parseMessage(data);
      if (!message) {
        return;
      }
      switch (message.type) {
        case "snapshot":
          options.onSnapshot(message.board);
          break;
        case "agent_update":
          options.onAgentUpdate(message.agent);
          break;
        case "md_file_changed":
          options.onMdFileChanged?.(message);
          break;
        case "md_subscribe_error":
          options.onMdSubscribeError?.(message);
          break;
      }
    });

    ws.addEventListener("close", () => {
      setStatus("closed");
      if (closedByClient) {
        return;
      }
      reconnectTimer = setTimeout(open, reconnectDelayMs);
    });
  };

  // ソケットが open していない間の送信は行わない（再接続中・切断済みに
  // 送っても届かない。呼び出し元（PreviewPanel）はファイル選択・パネル
  // クローズ操作のたびに送るだけで、接続状態は意識しない設計にするため、
  // ここで黙って無視する。例外は投げない）。
  const send = (message: Record<string, unknown>): void => {
    if (socket?.readyState !== WebSocketCtor.OPEN) {
      return;
    }
    socket.send(JSON.stringify(message));
  };

  open();

  return {
    close() {
      closedByClient = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      socket?.close();
    },
    subscribeMd(repo: string, path: string) {
      send({ type: "md_subscribe", repo, path });
    },
    unsubscribeMd(repo: string, path: string) {
      send({ type: "md_unsubscribe", repo, path });
    },
  };
}
