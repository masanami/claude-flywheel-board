import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { prefill } from "../terminal-control.ts";
import type { TerminalSocketOptions } from "../terminal-ws.ts";
import { TerminalPane } from "./TerminalPane.tsx";
import type { CreateXtermInstance } from "./xterm-adapter.ts";

type FakeSocket = {
  sendInput: Mock<(data: string) => void>;
  resize: Mock<(cols: number, rows: number) => void>;
  prefill: Mock<(command: string) => void>;
  close: Mock<() => void>;
};

type FakeXterm = {
  write: Mock<(data: string) => void>;
  onData: Mock<(callback: (data: string) => void) => void>;
  fit: Mock<() => { cols: number; rows: number }>;
  dispose: Mock<() => void>;
};

function createFakeSocket(): FakeSocket {
  return {
    sendInput: vi.fn(),
    resize: vi.fn(),
    prefill: vi.fn(),
    close: vi.fn(),
  };
}

function createFakeXterm(): FakeXterm {
  return {
    write: vi.fn(),
    onData: vi.fn(),
    fit: vi.fn(() => ({ cols: 80, rows: 24 })),
    dispose: vi.fn(),
  };
}

type Harness = {
  connect: Mock<(options: TerminalSocketOptions) => FakeSocket>;
  createXterm: CreateXtermInstance;
  fetchAgents: Mock<() => Promise<string[]>>;
  socketFor(agent: string): FakeSocket;
  xtermFor(agent: string): FakeXterm;
  optionsFor(agent: string): TerminalSocketOptions;
};

function buildHarness(agents: string[]): Harness {
  const sockets = new Map<string, FakeSocket>();
  const xterms = new Map<string, FakeXterm>();
  const optionsByAgent = new Map<string, TerminalSocketOptions>();

  const connect = vi.fn((options: TerminalSocketOptions) => {
    const url = new URL(options.url, "http://localhost");
    const agent = url.searchParams.get("agent") ?? "";
    const socket = createFakeSocket();
    sockets.set(agent, socket);
    optionsByAgent.set(agent, options);
    return socket;
  });

  const createXterm = vi.fn((_container: HTMLElement) => {
    // createXterm 呼び出し順は connect 呼び出しと対になっているとは限らないため、
    // 直近未割当のエージェント名を推測できないので、呼び出し側テストは
    // xtermFor をタブクリック直後にのみ利用する（agents 配列の順で解決する）。
    const assigned = [...xterms.keys()];
    const nextAgent = agents.find((a) => !assigned.includes(a));
    const xterm = createFakeXterm();
    if (nextAgent) {
      xterms.set(nextAgent, xterm);
    }
    return xterm;
  });

  const fetchAgents = vi.fn(() => Promise.resolve(agents));

  return {
    connect,
    createXterm,
    fetchAgents,
    socketFor(agent: string) {
      const socket = sockets.get(agent);
      if (!socket) {
        throw new Error(`socket for ${agent} not created`);
      }
      return socket;
    },
    xtermFor(agent: string) {
      const xterm = xterms.get(agent);
      if (!xterm) {
        throw new Error(`xterm for ${agent} not created`);
      }
      return xterm;
    },
    optionsFor(agent: string) {
      const options = optionsByAgent.get(agent);
      if (!options) {
        throw new Error(`options for ${agent} not created`);
      }
      return options;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TerminalPane", () => {
  it("agent 一覧を agent 名そのままのタブとして表示する（内部命名規約は露出しない）", async () => {
    const harness = buildHarness(["medical", "bi"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    expect(await screen.findByText("medical")).toBeInTheDocument();
    expect(screen.getByText("bi")).toBeInTheDocument();
  });

  it("初回は先頭タブのみ接続され、他のタブは未接続である", async () => {
    const harness = buildHarness(["medical", "bi"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");

    await waitFor(() => {
      expect(harness.connect).toHaveBeenCalledTimes(1);
    });
    expect(harness.optionsFor("medical")).toBeDefined();
    expect(() => harness.socketFor("bi")).toThrow();
  });

  it("別タブをクリックすると新規接続が張られ、元の接続は close されない", async () => {
    const harness = buildHarness(["medical", "bi"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));
    const medicalSocket = harness.socketFor("medical");

    act(() => {
      fireEvent.click(screen.getByText("bi"));
    });

    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));
    expect(harness.socketFor("bi")).toBeDefined();
    expect(medicalSocket.close).not.toHaveBeenCalled();
  });

  it("折りたたみボタンでヘッダ以外が非表示になるが、接続は維持される", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));
    const socket = harness.socketFor("medical");
    const xterm = harness.xtermFor("medical");

    const collapseButton = screen.getByRole("button", { name: /折りたたむ/ });
    act(() => {
      fireEvent.click(collapseButton);
    });

    // DOM からは外さない（display:none で隠すのみ）。unmount してしまうと
    // xterm.js が open() 時にアタッチした内部 DOM がコンテナごと失われ、
    // 再展開時に空表示に戻ってしまう回帰を防ぐ。
    const body = screen.getByTestId("terminal-pane-body");
    expect(body).toBeInTheDocument();
    expect(body.style.display).toBe("none");
    expect(screen.getByText("medical")).toBeInTheDocument();
    expect(socket.close).not.toHaveBeenCalled();
    expect(xterm.dispose).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /展開/ }));
    });

    expect(screen.getByTestId("terminal-pane-body").style.display).toBe(
      "block",
    );
    // 再展開時に xterm インスタンス・接続を作り直していないこと
    // （collapse/expand を跨いで同一インスタンスが維持されること）。
    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(harness.createXterm).toHaveBeenCalledTimes(1);
  });

  it("上端バーのドラッグでパネルの高さが変わる", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");

    const pane = screen.getByTestId("terminal-pane");
    const handle = screen.getByTestId("terminal-resize-handle");
    const heightBefore = pane.style.height;

    act(() => {
      fireEvent.mouseDown(handle, { clientY: 500 });
      fireEvent.mouseMove(window, { clientY: 300 });
      fireEvent.mouseUp(window);
    });

    expect(pane.style.height).not.toBe(heightBefore);
  });

  it("fetchAgents が失敗した場合はタブなしで表示する", async () => {
    const fetchAgents = vi.fn(() => Promise.reject(new Error("network error")));

    render(
      <TerminalPane
        connect={vi.fn()}
        createXterm={vi.fn()}
        fetchAgents={fetchAgents}
      />,
    );

    await waitFor(() => expect(fetchAgents).toHaveBeenCalled());
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("terminal-control の prefill(agent, command) を呼ぶと対象タブがアクティブになり、対応する接続の prefill が呼ばれる", async () => {
    const harness = buildHarness(["medical", "bi"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    act(() => {
      prefill("bi", "echo hi");
    });

    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));
    expect(harness.socketFor("bi").prefill).toHaveBeenCalledWith("echo hi");
    expect(screen.getByText("bi").getAttribute("aria-selected")).toBe("true");
  });

  it("折りたたみ中に prefill を呼ぶとペインが展開される（不可視のペインへ流し込まない）", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    const collapseButton = screen.getByRole("button", { name: /折りたたむ/ });
    act(() => {
      fireEvent.click(collapseButton);
    });
    expect(screen.getByTestId("terminal-pane-body").style.display).toBe("none");

    act(() => {
      prefill("medical", "echo hi");
    });

    expect(screen.getByTestId("terminal-pane-body").style.display).toBe(
      "block",
    );
    expect(harness.socketFor("medical").prefill).toHaveBeenCalledWith(
      "echo hi",
    );
  });

  it("未接続の agent に対して連続で prefill を呼んだ場合、接続確立後に全件が呼んだ順番通り送られる（後勝ち上書きしない）", async () => {
    const harness = buildHarness(["medical", "bi"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    // "bi" はまだ未接続（タブを開いていない）。この状態で連続して prefill を
    // 呼ぶと、どちらも接続確立前のキューに積まれる。
    act(() => {
      prefill("bi", "echo 1");
      prefill("bi", "echo 2");
    });

    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const biSocket = harness.socketFor("bi");
    expect(biSocket.prefill).toHaveBeenNthCalledWith(1, "echo 1");
    expect(biSocket.prefill).toHaveBeenNthCalledWith(2, "echo 2");
    expect(biSocket.prefill).toHaveBeenCalledTimes(2);
  });

  it("agents 一覧に無い agent への prefill は無視する（不明な接続を作らない）", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    act(() => {
      prefill("unknown-agent", "echo hi");
    });

    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("unknown-agent")).not.toBeInTheDocument();
  });

  it("アンマウント時に開いている全ての接続を close/dispose する", async () => {
    const harness = buildHarness(["medical", "bi"]);

    const { unmount } = render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    act(() => {
      fireEvent.click(screen.getByText("bi"));
    });
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const medicalSocket = harness.socketFor("medical");
    const biSocket = harness.socketFor("bi");
    const medicalXterm = harness.xtermFor("medical");
    const biXterm = harness.xtermFor("bi");

    unmount();

    expect(medicalSocket.close).toHaveBeenCalled();
    expect(biSocket.close).toHaveBeenCalled();
    expect(medicalXterm.dispose).toHaveBeenCalled();
    expect(biXterm.dispose).toHaveBeenCalled();
  });

  it("再接続成功時（2回目以降の open）に再 fit して resize を送り直す", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    const xterm = harness.xtermFor("medical");
    const socket = harness.socketFor("medical");
    const options = harness.optionsFor("medical");

    const fitCallsAfterConnect = xterm.fit.mock.calls.length;
    const resizeCallsAfterConnect = socket.resize.mock.calls.length;

    // 初回の open（実際の WS 接続成立）: 接続直後に既に fit/resize 済みのため再送しない。
    act(() => {
      options.onStatusChange?.("open");
    });
    expect(xterm.fit.mock.calls.length).toBe(fitCallsAfterConnect);
    expect(socket.resize.mock.calls.length).toBe(resizeCallsAfterConnect);

    // 切断 → 再接続（2回目の open）: pty はデフォルトサイズで再生成されるため再送する。
    act(() => {
      options.onStatusChange?.("closed");
      options.onStatusChange?.("open");
    });
    expect(xterm.fit.mock.calls.length).toBeGreaterThan(fitCallsAfterConnect);
    expect(socket.resize.mock.calls.length).toBeGreaterThan(
      resizeCallsAfterConnect,
    );
  });

  it("attach 直後、実操作（keydown等）を観測する前の onData は sendInput を呼ばない（attach 再生ノイズの抑止）", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    const xterm = harness.xtermFor("medical");
    const socket = harness.socketFor("medical");
    const onDataCallback = xterm.onData.mock.calls[0]?.[0];
    if (!onDataCallback) throw new Error("onData callback が登録されていない");

    // xterm の自動応答（DA1 等）を模した data。ユーザー操作を一切観測していない
    // ため、pty へは転送されてはならない。
    act(() => {
      onDataCallback("\x1b[?1;2c");
    });

    expect(socket.sendInput).not.toHaveBeenCalled();
  });

  it("keydown（実操作）を観測した後の onData は sendInput を呼ぶ", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    const xterm = harness.xtermFor("medical");
    const socket = harness.socketFor("medical");
    const options = harness.optionsFor("medical");
    const onDataCallback = xterm.onData.mock.calls[0]?.[0];
    if (!onDataCallback) throw new Error("onData callback が登録されていない");

    // 実フロー同様、WS の open 通知（＝ゲートの reset）が先に起きた後で
    // ユーザーが実操作するケースを再現する。
    act(() => {
      options.onStatusChange?.("open");
    });

    const panel = screen.getByTestId("terminal-panel-medical");
    act(() => {
      fireEvent.keyDown(panel);
    });

    act(() => {
      onDataCallback("echo hi");
    });

    expect(socket.sendInput).toHaveBeenCalledWith("echo hi");
  });

  it("再接続（closed→open）でゲートがリセットされ、再び実操作を観測するまで onData を抑止する", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    const xterm = harness.xtermFor("medical");
    const socket = harness.socketFor("medical");
    const options = harness.optionsFor("medical");
    const onDataCallback = xterm.onData.mock.calls[0]?.[0];
    if (!onDataCallback) throw new Error("onData callback が登録されていない");
    const panel = screen.getByTestId("terminal-panel-medical");

    // 実操作を観測し、ゲートが開いていることを確認する。
    act(() => {
      fireEvent.keyDown(panel);
    });
    act(() => {
      onDataCallback("echo hi");
    });
    expect(socket.sendInput).toHaveBeenCalledWith("echo hi");

    // 切断 → 再接続（再 attach）: 再生ノイズが起き得るため、ゲートは再び閉じる。
    act(() => {
      options.onStatusChange?.("closed");
      options.onStatusChange?.("open");
    });

    const sendInputCallsAfterReconnect = socket.sendInput.mock.calls.length;
    act(() => {
      onDataCallback("\x1b[?1;2c");
    });
    // 特定引数での不呼び出しだけでなく、抑止中は呼び出し回数自体が
    // 増えていないことも確認する（引数違いの取りこぼしを防ぐ）。
    expect(socket.sendInput.mock.calls.length).toBe(
      sendInputCallsAfterReconnect,
    );
    expect(socket.sendInput).not.toHaveBeenCalledWith("\x1b[?1;2c");

    // 再接続後に改めて実操作を観測すれば、また送信されるようになる。
    act(() => {
      fireEvent.keyDown(panel);
    });
    act(() => {
      onDataCallback("echo again");
    });
    expect(socket.sendInput).toHaveBeenCalledWith("echo again");
  });

  it("window の resize イベントで、表示中のペインを再 fit して resize を送る", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));

    const xterm = harness.xtermFor("medical");
    const socket = harness.socketFor("medical");
    const fitCallsBefore = xterm.fit.mock.calls.length;
    const resizeCallsBefore = socket.resize.mock.calls.length;

    act(() => {
      fireEvent(window, new Event("resize"));
    });

    expect(xterm.fit.mock.calls.length).toBeGreaterThan(fitCallsBefore);
    expect(socket.resize.mock.calls.length).toBeGreaterThan(resizeCallsBefore);
  });
});
