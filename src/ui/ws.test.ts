import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBoard, BoardSnapshot } from "./board-types.ts";
import { connectBoardSocket } from "./ws.ts";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  closeCalled = false;
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

  close(): void {
    this.closeCalled = true;
    this.dispatch("close", {});
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function boardSnapshot(): BoardSnapshot {
  return {
    agents: [
      {
        name: "medical",
        path: "/agents/medical",
        challenges: [],
        parseErrors: [],
      },
    ],
  };
}

function agentBoard(): AgentBoard {
  return {
    name: "medical",
    path: "/agents/medical",
    challenges: [],
    parseErrors: [],
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connectBoardSocket", () => {
  it("WebSocketImpl でソケットを開く", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe("ws://localhost:1234/ws");
  });

  it("type: snapshot のメッセージを受信したら onSnapshot を呼ぶ", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();
    const snapshot = boardSnapshot();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.dispatch("message", {
      data: JSON.stringify({ type: "snapshot", board: snapshot }),
    });

    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(onAgentUpdate).not.toHaveBeenCalled();
  });

  it("type: agent_update のメッセージを受信したら onAgentUpdate を呼ぶ", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();
    const agent = agentBoard();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.dispatch("message", {
      data: JSON.stringify({ type: "agent_update", agent }),
    });

    expect(onAgentUpdate).toHaveBeenCalledWith(agent);
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("不正な JSON のメッセージは無視する（例外を投げない）", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    expect(() => {
      socket?.dispatch("message", { data: "not json" });
    }).not.toThrow();

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onAgentUpdate).not.toHaveBeenCalled();
  });

  it("snapshot メッセージで board.agents が配列でない場合は無視する", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.dispatch("message", {
      data: JSON.stringify({
        type: "snapshot",
        board: { agents: "not-array" },
      }),
    });

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onAgentUpdate).not.toHaveBeenCalled();
  });

  it("agent_update メッセージで agent.name が文字列でない場合は無視する", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.dispatch("message", {
      data: JSON.stringify({
        type: "agent_update",
        agent: { name: 42, path: "/x", challenges: [], parseErrors: [] },
      }),
    });

    expect(onAgentUpdate).not.toHaveBeenCalled();
  });

  it("agent_update メッセージで challenges が配列でない場合は無視する", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.dispatch("message", {
      data: JSON.stringify({
        type: "agent_update",
        agent: {
          name: "medical",
          path: "/x",
          challenges: "not-array",
          parseErrors: [],
        },
      }),
    });

    expect(onAgentUpdate).not.toHaveBeenCalled();
  });

  it("agent_update メッセージで parseErrors が配列でない場合は無視する", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.dispatch("message", {
      data: JSON.stringify({
        type: "agent_update",
        agent: {
          name: "medical",
          path: "/x",
          challenges: [],
          parseErrors: "not-array",
        },
      }),
    });

    expect(onAgentUpdate).not.toHaveBeenCalled();
  });

  it("未知の type のメッセージは無視する", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const socket = FakeWebSocket.instances[0];
    socket?.dispatch("message", {
      data: JSON.stringify({ type: "unknown", foo: "bar" }),
    });

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onAgentUpdate).not.toHaveBeenCalled();
  });

  it("close イベント発生時、reconnectDelayMs 後に再接続する", () => {
    vi.useFakeTimers();
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      reconnectDelayMs: 500,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0]?.dispatch("close", {});

    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("close() を呼んだ後は close イベントが起きても再接続しない", () => {
    vi.useFakeTimers();
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();

    const boardSocket = connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      reconnectDelayMs: 500,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    const firstSocket = FakeWebSocket.instances[0];
    boardSocket.close();

    expect(firstSocket?.closeCalled).toBe(true);
    vi.advanceTimersByTime(5000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("onStatusChange に connecting → open の順で通知する", () => {
    const onSnapshot = vi.fn();
    const onAgentUpdate = vi.fn();
    const onStatusChange = vi.fn();

    connectBoardSocket({
      url: "ws://localhost:1234/ws",
      onSnapshot,
      onAgentUpdate,
      onStatusChange,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    expect(onStatusChange).toHaveBeenNthCalledWith(1, "connecting");

    FakeWebSocket.instances[0]?.dispatch("open", {});
    expect(onStatusChange).toHaveBeenNthCalledWith(2, "open");
  });
});
