import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTerminalSocket } from "./terminal-ws.ts";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  closeCalled = false;
  sentMessages: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.closeCalled = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", {});
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  /** テスト補助: 実ブラウザの WebSocket と同様に open で readyState を更新してから通知する。 */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  /**
   * テスト補助: サーバ側／ネットワーク起因の切断（クライアントの close() 呼び出し
   * を経ない）を模す。実ブラウザ・実 WebSocket も readyState は close イベント
   * 発火前に CLOSED へ遷移するため、それに合わせて readyState を更新してから
   * dispatch する（readyState を更新しないと、切断後に呼ばれた send() が
   * 「まだ OPEN」と誤判定してキューされずに直接送信されてしまう）。
   */
  simulateServerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", {});
  }
}

function sentJson(socket: FakeWebSocket, index = 0): unknown {
  const raw = socket.sentMessages[index];
  return raw === undefined ? undefined : JSON.parse(raw);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connectTerminalSocket", () => {
  it("WebSocketImpl でソケットを開く", () => {
    connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(
      "ws://localhost:1234/ws/terminal?agent=medical",
    );
  });

  it("テキストフレームを受信したら JSON パースせずそのまま onData に渡す", () => {
    const onData = vi.fn();

    connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.simulateOpen();
    socket?.dispatch("message", { data: "hello\r\n$ " });

    expect(onData).toHaveBeenCalledWith("hello\r\n$ ");
  });

  it("接続確立後の sendInput は input メッセージとして即座に送信される", () => {
    const socketApi = connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.simulateOpen();
    socketApi.sendInput("ls\n");

    expect(sentJson(socket as FakeWebSocket)).toEqual({
      type: "input",
      data: "ls\n",
    });
  });

  it("接続確立後の resize は resize メッセージとして送信される", () => {
    const socketApi = connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.simulateOpen();
    socketApi.resize(80, 24);

    expect(sentJson(socket as FakeWebSocket)).toEqual({
      type: "resize",
      cols: 80,
      rows: 24,
    });
  });

  it("接続確立後の prefill は prefill メッセージとして送信される", () => {
    const socketApi = connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.simulateOpen();
    socketApi.prefill("echo hi");

    expect(sentJson(socket as FakeWebSocket)).toEqual({
      type: "prefill",
      command: "echo hi",
    });
  });

  it("接続確立前の呼び出しはキューに積まれ、open 時にまとめて順番通り送信される", () => {
    const socketApi = connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0] as FakeWebSocket;
    socketApi.prefill("echo hi");
    socketApi.resize(80, 24);

    expect(socket.sentMessages).toHaveLength(0);

    socket.simulateOpen();

    expect(socket.sentMessages).toHaveLength(2);
    expect(sentJson(socket, 0)).toEqual({
      type: "prefill",
      command: "echo hi",
    });
    expect(sentJson(socket, 1)).toEqual({ type: "resize", cols: 80, rows: 24 });
  });

  it("close イベント発生時、reconnectDelayMs 後に再接続する", () => {
    vi.useFakeTimers();

    connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      reconnectDelayMs: 500,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0]?.dispatch("close", {});

    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("再接続のたびに待機時間が倍加する（指数バックオフ）", () => {
    vi.useFakeTimers();

    connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      reconnectDelayMs: 100,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    // 1 回目の切断 → 100ms 後に再接続
    FakeWebSocket.instances[0]?.dispatch("close", {});
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // open せずすぐ切断 → 2 回目は 200ms 後（倍加）
    FakeWebSocket.instances[1]?.dispatch("close", {});
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2); // まだ早い
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("再接続の待機時間は上限 30000ms でキャップされる", () => {
    vi.useFakeTimers();

    connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      reconnectDelayMs: 20000,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    // 1 回目: 20000ms 後（そのまま）
    FakeWebSocket.instances[0]?.dispatch("close", {});
    vi.advanceTimersByTime(20000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // 2 回目: 20000*2=40000 は 30000 にキャップされる
    FakeWebSocket.instances[1]?.dispatch("close", {});
    vi.advanceTimersByTime(30000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("再接続に成功（open）したらバックオフ時間がリセットされる", () => {
    vi.useFakeTimers();

    connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      reconnectDelayMs: 100,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    // 1 回目の切断・再接続 → 200ms に倍加された状態
    FakeWebSocket.instances[0]?.dispatch("close", {});
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // 再接続に成功（open）させるとバックオフはリセットされる
    FakeWebSocket.instances[1]?.simulateOpen();

    // 2回目の切断 → リセットされていれば再び 100ms で再接続するはず
    FakeWebSocket.instances[1]?.dispatch("close", {});
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("close() を呼んだ後は close イベントが起きても再接続しない", () => {
    vi.useFakeTimers();

    const socketApi = connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      reconnectDelayMs: 500,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const firstSocket = FakeWebSocket.instances[0];
    socketApi.close();

    expect(firstSocket?.closeCalled).toBe(true);
    vi.advanceTimersByTime(5000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("再接続時、切断中にキューされた古い resize より、再接続直後に onStatusChange('open') 内で送る最新の resize が後に送信される（PTY サイズの巻き戻り防止）", () => {
    vi.useFakeTimers();

    const socketApi: ReturnType<typeof connectTerminalSocket> =
      connectTerminalSocket({
        url: "ws://localhost:1234/ws/terminal?agent=medical",
        onData: vi.fn(),
        reconnectDelayMs: 100,
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onStatusChange: (status) => {
          if (status === "open") {
            // TerminalPane の再 fit と同様、再接続直後に「現在の最新サイズ」を
            // 送り直す。
            socketApi.resize(120, 40);
          }
        },
      });

    const firstSocket = FakeWebSocket.instances[0] as FakeWebSocket;
    firstSocket.simulateOpen();

    // 切断（サーバ／ネットワーク起因。readyState は CLOSED へ遷移する）。
    firstSocket.simulateServerClose();

    // 切断中（次の接続がまだ open していない間）に古い resize がキューされる。
    socketApi.resize(80, 24);

    // 再接続。
    vi.advanceTimersByTime(100);
    const secondSocket = FakeWebSocket.instances[1] as FakeWebSocket;
    secondSocket.simulateOpen();

    const resizeMessages = secondSocket.sentMessages
      .map((raw) => JSON.parse(raw))
      .filter(
        (message): message is { type: "resize"; cols: number; rows: number } =>
          (message as { type?: string }).type === "resize",
      );

    // 最終的にサーバへ反映されるサイズ（＝最後に送られた resize）が、
    // 巻き戻った古い値（80x24）ではなく最新値（120x40）であること。
    expect(resizeMessages.at(-1)).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    });
  });

  it("onStatusChange に connecting → open → closed → connecting の順で通知する", () => {
    vi.useFakeTimers();
    const onStatusChange = vi.fn();

    connectTerminalSocket({
      url: "ws://localhost:1234/ws/terminal?agent=medical",
      onData: vi.fn(),
      onStatusChange,
      reconnectDelayMs: 100,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(onStatusChange).toHaveBeenNthCalledWith(1, "connecting");

    FakeWebSocket.instances[0]?.simulateOpen();
    expect(onStatusChange).toHaveBeenNthCalledWith(2, "open");

    FakeWebSocket.instances[0]?.dispatch("close", {});
    expect(onStatusChange).toHaveBeenNthCalledWith(3, "closed");

    vi.advanceTimersByTime(100);
    expect(onStatusChange).toHaveBeenNthCalledWith(4, "connecting");
  });
});
