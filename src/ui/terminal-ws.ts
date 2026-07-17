// React に依存しない純粋な WS 接続モジュール。TerminalPane.tsx から呼び出される。
//
// クリティカル設計決定（親 Issue #2 / #14）: 送信できるメッセージは
// input（キー入力の転送）/ resize（ペインサイズ変更）/ prefill（改行なしの
// literal 文字列流し込み）の 3 つのみ。「送信して実行する」ような 4 つ目の
// 種別を安易に追加しないこと（Enter を送る口・自動実行の口を作らない）。
//
// 既存の src/ui/ws.ts（受信専用・/ws）とは別モジュールとして分離している。
// board 監視用の観測 WS に送信口を足さない設計上の判断のため、統合しない。

export type TerminalStatus = "connecting" | "open" | "closed";

export type TerminalSocketOptions = {
  url: string;
  onData: (data: string) => void;
  onStatusChange?: (status: TerminalStatus) => void;
  WebSocketImpl?: typeof WebSocket;
  /** 再接続の基準遅延（ms）。再接続の都度倍加し、上限でキャップする（簡易指数バックオフ）。 */
  reconnectDelayMs?: number;
};

export type TerminalSocket = {
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  prefill(command: string): void;
  close(): void;
};

const DEFAULT_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

type OutgoingMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "prefill"; command: string };

export function connectTerminalSocket(
  options: TerminalSocketOptions,
): TerminalSocket {
  const WebSocketCtor = options.WebSocketImpl ?? WebSocket;
  const initialReconnectDelayMs =
    options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

  let nextReconnectDelayMs = initialReconnectDelayMs;
  let closedByClient = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | undefined;
  // 接続確立前に呼ばれた送信は、open イベントまでここに積んで順にフラッシュする。
  let pendingMessages: OutgoingMessage[] = [];

  const setStatus = (status: TerminalStatus) => {
    options.onStatusChange?.(status);
  };

  const send = (message: OutgoingMessage) => {
    if (socket && socket.readyState === WebSocketCtor.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }
    pendingMessages.push(message);
  };

  const flushPendingMessages = () => {
    const messages = pendingMessages;
    pendingMessages = [];
    for (const message of messages) {
      socket?.send(JSON.stringify(message));
    }
  };

  const open = () => {
    setStatus("connecting");
    const ws = new WebSocketCtor(options.url);
    socket = ws;

    ws.addEventListener("open", () => {
      // 再接続に成功した合図として、バックオフ時間を初期値へ戻す。
      nextReconnectDelayMs = initialReconnectDelayMs;
      setStatus("open");
      flushPendingMessages();
    });

    ws.addEventListener("message", (event: unknown) => {
      const data = (event as MessageEvent).data;
      // S→C はテキストフレーム＝pty 出力そのもの。JSON パースはしない。
      if (typeof data === "string") {
        options.onData(data);
      }
    });

    ws.addEventListener("close", () => {
      setStatus("closed");
      if (closedByClient) {
        return;
      }
      const delay = nextReconnectDelayMs;
      nextReconnectDelayMs = Math.min(
        nextReconnectDelayMs * 2,
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectTimer = setTimeout(open, delay);
    });
  };

  open();

  return {
    sendInput(data: string) {
      send({ type: "input", data });
    },
    resize(cols: number, rows: number) {
      send({ type: "resize", cols, rows });
    },
    prefill(command: string) {
      send({ type: "prefill", command });
    },
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
