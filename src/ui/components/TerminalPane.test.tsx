import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { prefill } from "../terminal-control.ts";
import type { TerminalSocketOptions } from "../terminal-ws.ts";
import { TerminalPane } from "./TerminalPane.tsx";
import type { CreateXtermInstance } from "./xterm-adapter.ts";

// #57（ターミナルペインの縦分割）: 各エージェントタブは「左=エージェント
// （kind=agent）／右=手動シェル（kind=shell）」の常時2分割で表示される。
// 1タブあたり WS 接続は2本になるため、このハーネスは (agent, kind) の
// 複合キーで socket / xterm / options を追跡する。

type PaneKind = "agent" | "shell";

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

function paneKey(agent: string, kind: PaneKind): string {
  return `${agent}:${kind}`;
}

type Harness = {
  connect: Mock<(options: TerminalSocketOptions) => FakeSocket>;
  createXterm: CreateXtermInstance;
  fetchAgents: Mock<() => Promise<string[]>>;
  socketFor(agent: string, kind?: PaneKind): FakeSocket;
  xtermFor(agent: string, kind?: PaneKind): FakeXterm;
  optionsFor(agent: string, kind?: PaneKind): TerminalSocketOptions;
};

function buildHarness(agents: string[]): Harness {
  const sockets = new Map<string, FakeSocket>();
  const xterms = new Map<string, FakeXterm>();
  const optionsByKey = new Map<string, TerminalSocketOptions>();
  // createXterm(container) は ensureConnection 内で connect(...) の直前に
  // 同期呼び出しされる（interleave しない）。そのため、直近の未割当 xterm を
  // FIFO キューに積んでおき、続く connect 呼び出しの (agent, kind) と
  // 紐付ける。
  const pendingXterms: FakeXterm[] = [];

  const createXterm = vi.fn((_container: HTMLElement) => {
    const xterm = createFakeXterm();
    pendingXterms.push(xterm);
    return xterm;
  });

  const connect = vi.fn((options: TerminalSocketOptions) => {
    const url = new URL(options.url, "http://localhost");
    const agent = url.searchParams.get("agent") ?? "";
    const kind = (url.searchParams.get("kind") ?? "agent") as PaneKind;
    const key = paneKey(agent, kind);
    const socket = createFakeSocket();
    sockets.set(key, socket);
    optionsByKey.set(key, options);
    const xterm = pendingXterms.shift();
    if (xterm) {
      xterms.set(key, xterm);
    }
    return socket;
  });

  const fetchAgents = vi.fn(() => Promise.resolve(agents));

  return {
    connect,
    createXterm,
    fetchAgents,
    socketFor(agent: string, kind: PaneKind = "agent") {
      const socket = sockets.get(paneKey(agent, kind));
      if (!socket) {
        throw new Error(`socket for ${agent}:${kind} not created`);
      }
      return socket;
    },
    xtermFor(agent: string, kind: PaneKind = "agent") {
      const xterm = xterms.get(paneKey(agent, kind));
      if (!xterm) {
        throw new Error(`xterm for ${agent}:${kind} not created`);
      }
      return xterm;
    },
    optionsFor(agent: string, kind: PaneKind = "agent") {
      const options = optionsByKey.get(paneKey(agent, kind));
      if (!options) {
        throw new Error(`options for ${agent}:${kind} not created`);
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

  it("初回は先頭タブの2ペイン（agent/shell）のみ接続され、他のタブは未接続である", async () => {
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
      expect(harness.connect).toHaveBeenCalledTimes(2);
    });
    expect(harness.optionsFor("medical", "agent")).toBeDefined();
    expect(harness.optionsFor("medical", "shell")).toBeDefined();
    expect(() => harness.socketFor("bi", "agent")).toThrow();
    expect(() => harness.socketFor("bi", "shell")).toThrow();
  });

  it("エージェント（左）ペインは kind=agent、シェル（右）ペインは kind=shell で接続する（#57）", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const agentUrl = new URL(
      harness.optionsFor("medical", "agent").url,
      "http://localhost",
    );
    const shellUrl = new URL(
      harness.optionsFor("medical", "shell").url,
      "http://localhost",
    );
    expect(agentUrl.searchParams.get("agent")).toBe("medical");
    expect(agentUrl.searchParams.get("kind")).toBe("agent");
    expect(shellUrl.searchParams.get("agent")).toBe("medical");
    expect(shellUrl.searchParams.get("kind")).toBe("shell");
  });

  it("別タブをクリックすると新規に2ペイン分の接続が張られ、元の接続は close されない", async () => {
    const harness = buildHarness(["medical", "bi"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));
    const medicalAgentSocket = harness.socketFor("medical", "agent");
    const medicalShellSocket = harness.socketFor("medical", "shell");

    act(() => {
      fireEvent.click(screen.getByText("bi"));
    });

    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(4));
    expect(harness.socketFor("bi", "agent")).toBeDefined();
    expect(harness.socketFor("bi", "shell")).toBeDefined();
    expect(medicalAgentSocket.close).not.toHaveBeenCalled();
    expect(medicalShellSocket.close).not.toHaveBeenCalled();
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
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));
    const socket = harness.socketFor("medical", "agent");
    const xterm = harness.xtermFor("medical", "agent");

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
    expect(harness.connect).toHaveBeenCalledTimes(2);
    expect(harness.createXterm).toHaveBeenCalledTimes(2);
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

  describe("キーボードでのリサイズ（#25）", () => {
    it("リサイズハンドルに role=separator と関連 aria 属性を持つ", async () => {
      const harness = buildHarness(["medical"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");

      const handle = screen.getByTestId("terminal-resize-handle");
      expect(handle).toHaveAttribute("role", "separator");
      expect(handle).toHaveAttribute("aria-orientation", "horizontal");
      expect(handle).toHaveAttribute("aria-valuenow", "320");
      expect(handle).toHaveAttribute("aria-valuemin", "120");
      expect(handle).toHaveAttribute("aria-valuemax", "800");
      expect(handle).toHaveAttribute("aria-label", "ターミナルパネルの高さ");
      expect(handle).toHaveAttribute("tabIndex", "0");
    });

    it("ArrowUp キーで高さが32px増える", async () => {
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

      act(() => {
        fireEvent.keyDown(handle, { key: "ArrowUp" });
      });

      expect(pane.style.height).toBe("352px");
      expect(handle).toHaveAttribute("aria-valuenow", "352");
    });

    it("ArrowDown キーで高さが32px減る", async () => {
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

      act(() => {
        fireEvent.keyDown(handle, { key: "ArrowDown" });
      });

      expect(pane.style.height).toBe("288px");
      expect(handle).toHaveAttribute("aria-valuenow", "288");
    });

    it("上限（800px）到達後は ArrowUp を押しても超えない", async () => {
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

      act(() => {
        for (let i = 0; i < 20; i += 1) {
          fireEvent.keyDown(handle, { key: "ArrowUp" });
        }
      });

      expect(pane.style.height).toBe("800px");
    });

    it("下限（120px）到達後は ArrowDown を押しても下回らない", async () => {
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

      act(() => {
        for (let i = 0; i < 20; i += 1) {
          fireEvent.keyDown(handle, { key: "ArrowDown" });
        }
      });

      expect(pane.style.height).toBe("120px");
    });
  });

  describe("縦分割スプリッター（#57）", () => {
    it("agent（左）/ shell（右）の2ペインが常時レンダリングされる（トグルなし）", async () => {
      const harness = buildHarness(["medical"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");

      expect(
        screen.getByTestId("terminal-panel-medical-agent"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("terminal-panel-medical-shell"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("terminal-split-handle-medical"),
      ).toBeInTheDocument();
    });

    it("複数タブを開いてもスプリッターの testid は agent ごとに一意であり、非アクティブタブの分と衝突しない（セルフレビュー指摘）", async () => {
      const harness = buildHarness(["medical", "bi"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");
      act(() => {
        fireEvent.click(screen.getByText("bi"));
      });
      await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(4));

      // medical タブ（非アクティブになった後も DOM には display:none で残る）と
      // bi タブ、双方のスプリッターが同時に DOM 上に存在するが、testid が
      // agent 名で一意化されているため getByTestId が単一要素に解決できる
      // （複数一致による throw が起きないことの確認）。
      expect(
        screen.getByTestId("terminal-split-handle-medical"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("terminal-split-handle-bi"),
      ).toBeInTheDocument();
    });

    it("スプリッターに role=separator と関連 aria 属性を持つ", async () => {
      const harness = buildHarness(["medical"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");

      const handle = screen.getByTestId("terminal-split-handle-medical");
      expect(handle).toHaveAttribute("role", "separator");
      expect(handle).toHaveAttribute("aria-orientation", "vertical");
      expect(handle).toHaveAttribute("aria-valuenow", "480");
      expect(handle).toHaveAttribute("aria-valuemin", "200");
      expect(handle).toHaveAttribute("aria-valuemax", "1200");
      expect(handle).toHaveAttribute("tabIndex", "0");
    });

    it("スプリッターのドラッグでエージェントペインの幅が変わる", async () => {
      const harness = buildHarness(["medical"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");

      const agentPanel = screen.getByTestId("terminal-panel-medical-agent");
      const handle = screen.getByTestId("terminal-split-handle-medical");
      const widthBefore = agentPanel.style.width;

      act(() => {
        fireEvent.mouseDown(handle, { clientX: 480 });
        fireEvent.mouseMove(window, { clientX: 600 });
        fireEvent.mouseUp(window);
      });

      expect(agentPanel.style.width).not.toBe(widthBefore);
      expect(agentPanel.style.width).toBe("600px");
    });

    it("ArrowRight キーでエージェントペイン幅が32px増える", async () => {
      const harness = buildHarness(["medical"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");

      const agentPanel = screen.getByTestId("terminal-panel-medical-agent");
      const handle = screen.getByTestId("terminal-split-handle-medical");

      act(() => {
        fireEvent.keyDown(handle, { key: "ArrowRight" });
      });

      expect(agentPanel.style.width).toBe("512px");
      expect(handle).toHaveAttribute("aria-valuenow", "512");
    });

    it("ArrowLeft キーでエージェントペイン幅が32px減る", async () => {
      const harness = buildHarness(["medical"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");

      const agentPanel = screen.getByTestId("terminal-panel-medical-agent");
      const handle = screen.getByTestId("terminal-split-handle-medical");

      act(() => {
        fireEvent.keyDown(handle, { key: "ArrowLeft" });
      });

      expect(agentPanel.style.width).toBe("448px");
      expect(handle).toHaveAttribute("aria-valuenow", "448");
    });

    it("上限（1200px）到達後は ArrowRight を押しても超えない", async () => {
      const harness = buildHarness(["medical"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");

      const agentPanel = screen.getByTestId("terminal-panel-medical-agent");
      const handle = screen.getByTestId("terminal-split-handle-medical");

      act(() => {
        for (let i = 0; i < 30; i += 1) {
          fireEvent.keyDown(handle, { key: "ArrowRight" });
        }
      });

      expect(agentPanel.style.width).toBe("1200px");
    });

    it("下限（200px）到達後は ArrowLeft を押しても下回らない", async () => {
      const harness = buildHarness(["medical"]);

      render(
        <TerminalPane
          connect={harness.connect}
          createXterm={harness.createXterm}
          fetchAgents={harness.fetchAgents}
        />,
      );

      await screen.findByText("medical");

      const agentPanel = screen.getByTestId("terminal-panel-medical-agent");
      const handle = screen.getByTestId("terminal-split-handle-medical");

      act(() => {
        for (let i = 0; i < 30; i += 1) {
          fireEvent.keyDown(handle, { key: "ArrowLeft" });
        }
      });

      expect(agentPanel.style.width).toBe("200px");
    });
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

  it("terminal-control の prefill(agent, command) を呼ぶと対象タブがアクティブになり、対応するエージェント接続の prefill が呼ばれる", async () => {
    const harness = buildHarness(["medical", "bi"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    act(() => {
      prefill("bi", "echo hi");
    });

    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(4));
    expect(harness.socketFor("bi", "agent").prefill).toHaveBeenCalledWith(
      "echo hi",
    );
    expect(screen.getByText("bi").getAttribute("aria-selected")).toBe("true");
  });

  it("【安全要件・#57】prefill(agent, command) は shell（右）側の接続には一切届かない", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    act(() => {
      prefill("medical", "echo hi");
    });

    expect(harness.socketFor("medical", "agent").prefill).toHaveBeenCalledWith(
      "echo hi",
    );
    expect(
      harness.socketFor("medical", "shell").prefill,
    ).not.toHaveBeenCalled();
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
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

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
    expect(harness.socketFor("medical", "agent").prefill).toHaveBeenCalledWith(
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
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    // "bi" はまだ未接続（タブを開いていない）。この状態で連続して prefill を
    // 呼ぶと、どちらも接続確立前のキューに積まれる。
    act(() => {
      prefill("bi", "echo 1");
      prefill("bi", "echo 2");
    });

    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(4));

    const biAgentSocket = harness.socketFor("bi", "agent");
    expect(biAgentSocket.prefill).toHaveBeenNthCalledWith(1, "echo 1");
    expect(biAgentSocket.prefill).toHaveBeenNthCalledWith(2, "echo 2");
    expect(biAgentSocket.prefill).toHaveBeenCalledTimes(2);
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
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    act(() => {
      prefill("unknown-agent", "echo hi");
    });

    expect(harness.connect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("unknown-agent")).not.toBeInTheDocument();
  });

  it("アンマウント時に開いている全ての接続（agent/shell 両ペイン）を close/dispose する", async () => {
    const harness = buildHarness(["medical", "bi"]);

    const { unmount } = render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    act(() => {
      fireEvent.click(screen.getByText("bi"));
    });
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(4));

    const medicalAgentSocket = harness.socketFor("medical", "agent");
    const medicalShellSocket = harness.socketFor("medical", "shell");
    const biAgentSocket = harness.socketFor("bi", "agent");
    const biShellSocket = harness.socketFor("bi", "shell");
    const medicalAgentXterm = harness.xtermFor("medical", "agent");
    const medicalShellXterm = harness.xtermFor("medical", "shell");
    const biAgentXterm = harness.xtermFor("bi", "agent");
    const biShellXterm = harness.xtermFor("bi", "shell");

    unmount();

    expect(medicalAgentSocket.close).toHaveBeenCalled();
    expect(medicalShellSocket.close).toHaveBeenCalled();
    expect(biAgentSocket.close).toHaveBeenCalled();
    expect(biShellSocket.close).toHaveBeenCalled();
    expect(medicalAgentXterm.dispose).toHaveBeenCalled();
    expect(medicalShellXterm.dispose).toHaveBeenCalled();
    expect(biAgentXterm.dispose).toHaveBeenCalled();
    expect(biShellXterm.dispose).toHaveBeenCalled();
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
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const xterm = harness.xtermFor("medical", "agent");
    const socket = harness.socketFor("medical", "agent");
    const options = harness.optionsFor("medical", "agent");

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
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const xterm = harness.xtermFor("medical", "agent");
    const socket = harness.socketFor("medical", "agent");
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
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const xterm = harness.xtermFor("medical", "agent");
    const socket = harness.socketFor("medical", "agent");
    const options = harness.optionsFor("medical", "agent");
    const onDataCallback = xterm.onData.mock.calls[0]?.[0];
    if (!onDataCallback) throw new Error("onData callback が登録されていない");

    // 実フロー同様、WS の open 通知（＝ゲートの reset）が先に起きた後で
    // ユーザーが実操作するケースを再現する。
    act(() => {
      options.onStatusChange?.("open");
    });

    const panel = screen.getByTestId("terminal-panel-medical-agent");
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
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const xterm = harness.xtermFor("medical", "agent");
    const socket = harness.socketFor("medical", "agent");
    const options = harness.optionsFor("medical", "agent");
    const onDataCallback = xterm.onData.mock.calls[0]?.[0];
    if (!onDataCallback) throw new Error("onData callback が登録されていない");
    const panel = screen.getByTestId("terminal-panel-medical-agent");

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

  it("agent（左）ペインと shell（右）ペインの入力ゲートは独立に働く（一方の keydown が他方を開かない）", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const agentXterm = harness.xtermFor("medical", "agent");
    const agentSocket = harness.socketFor("medical", "agent");
    const shellXterm = harness.xtermFor("medical", "shell");
    const shellSocket = harness.socketFor("medical", "shell");
    const agentOnData = agentXterm.onData.mock.calls[0]?.[0];
    const shellOnData = shellXterm.onData.mock.calls[0]?.[0];
    if (!agentOnData || !shellOnData) {
      throw new Error("onData callback が登録されていない");
    }

    // agent 側のみで実操作を観測させる。
    const agentPanel = screen.getByTestId("terminal-panel-medical-agent");
    act(() => {
      fireEvent.keyDown(agentPanel);
    });

    act(() => {
      agentOnData("echo agent-side");
      shellOnData("echo shell-side");
    });

    // agent 側は実操作済みなので転送される。shell 側は実操作を一切
    // 観測していないため、ゲートが開かず転送されない（ペインが独立している証明）。
    expect(agentSocket.sendInput).toHaveBeenCalledWith("echo agent-side");
    expect(shellSocket.sendInput).not.toHaveBeenCalled();
  });

  it("window の resize イベントで、表示中のペイン（agent/shell 両方）を再 fit して resize を送る", async () => {
    const harness = buildHarness(["medical"]);

    render(
      <TerminalPane
        connect={harness.connect}
        createXterm={harness.createXterm}
        fetchAgents={harness.fetchAgents}
      />,
    );

    await screen.findByText("medical");
    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(2));

    const agentXterm = harness.xtermFor("medical", "agent");
    const agentSocket = harness.socketFor("medical", "agent");
    const shellXterm = harness.xtermFor("medical", "shell");
    const shellSocket = harness.socketFor("medical", "shell");
    const agentFitCallsBefore = agentXterm.fit.mock.calls.length;
    const agentResizeCallsBefore = agentSocket.resize.mock.calls.length;
    const shellFitCallsBefore = shellXterm.fit.mock.calls.length;
    const shellResizeCallsBefore = shellSocket.resize.mock.calls.length;

    act(() => {
      fireEvent(window, new Event("resize"));
    });

    expect(agentXterm.fit.mock.calls.length).toBeGreaterThan(
      agentFitCallsBefore,
    );
    expect(agentSocket.resize.mock.calls.length).toBeGreaterThan(
      agentResizeCallsBefore,
    );
    expect(shellXterm.fit.mock.calls.length).toBeGreaterThan(
      shellFitCallsBefore,
    );
    expect(shellSocket.resize.mock.calls.length).toBeGreaterThan(
      shellResizeCallsBefore,
    );
  });
});
