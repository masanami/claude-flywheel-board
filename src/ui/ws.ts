import type { AgentBoard, BoardSnapshot } from "./board-types.ts";

// React に依存しない純粋な WS 購読モジュール。Board.tsx から呼び出される。
// board は状態ファイルへ一切書き込まない（NFR-01）。本モジュールも受信専用（購読）に
// 徹し、サーバへメッセージを送信する処理は持たない。

export type ConnectionStatus = "connecting" | "open" | "closed";

export type BoardSocketOptions = {
  url: string;
  onSnapshot: (board: BoardSnapshot) => void;
  onAgentUpdate: (agent: AgentBoard) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
  WebSocketImpl?: typeof WebSocket;
  reconnectDelayMs?: number;
};

export type BoardSocket = {
  close(): void;
};

const DEFAULT_RECONNECT_DELAY_MS = 1000;

type IncomingMessage =
  | { type: "snapshot"; board: BoardSnapshot }
  | { type: "agent_update"; agent: AgentBoard };

function parseMessage(data: unknown): IncomingMessage | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.type === "snapshot" || parsed.type === "agent_update")
    ) {
      return parsed as IncomingMessage;
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
      if (message.type === "snapshot") {
        options.onSnapshot(message.board);
      } else {
        options.onAgentUpdate(message.agent);
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
  };
}
