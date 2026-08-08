import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @xterm/xterm・@xterm/addon-fit は jsdom では実描画できないため、
// Terminal コンストラクタに渡されたオプションだけを検証できるようモックする。
const terminalCtor = vi.fn();
// attachCustomKeyEventHandler に登録されたハンドラを捕捉し、テストから
// キーイベントを模して直接呼び出せるようにする（#44 コピー連携の検証用）。
const customKeyEventHandlers: Array<(event: KeyboardEvent) => boolean> = [];
// onSelectionChange に登録されたコールバックを捕捉し、テストから選択変化を
// 模して直接呼び出せるようにする（#73 copy-on-select の検証用）。
const selectionChangeCallbacks: Array<() => void> = [];
// hasSelection/getSelection の戻り値をテストごとに差し替えるための状態。
let mockHasSelection = false;
let mockSelectionText = "";
// terminal.loadAddon() に渡されたインスタンスを捕捉し、FitAddon/ClipboardAddon
// の双方がロードされたことを検証できるようにする（OSC 52 パススルー対応）。
// ClipboardAddon は `provider`（xterm-adapter.ts が渡すカスタム
// IClipboardProvider）も保持し、読み取り無効化・書き込み委譲の直接検証に使う
// （PR #138 レビュー指摘対応）。
type MockClipboardProvider = {
  readText: (selection?: string) => string | Promise<string>;
  writeText: (selection: string, data: string) => void | Promise<void>;
};
const LOADED_ADDONS: Array<{
  kind: string;
  provider?: MockClipboardProvider;
}> = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      terminalCtor(options);
    }
    loadAddon(addon: { kind: string }) {
      LOADED_ADDONS.push(addon);
    }
    open() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      customKeyEventHandlers.push(handler);
    }
    onSelectionChange(callback: () => void) {
      selectionChangeCallbacks.push(callback);
    }
    hasSelection() {
      return mockHasSelection;
    }
    getSelection() {
      return mockSelectionText;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    kind = "fit";
    fit() {}
  },
}));
vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class {
    kind = "clipboard";
    provider?: MockClipboardProvider;
    // 実物と同じ (base64?, provider?) の引数順で受け取る。
    constructor(_base64: unknown, provider?: MockClipboardProvider) {
      this.provider = provider;
    }
  },
}));

/**
 * Promise チェーン（writeText の reject → execCommand フォールバック →
 * dedup ロールバック等）がすべて解決するまでマイクロタスク/タイマーキューを
 * flush する。setTimeout(0) はイベントループを一周させるため、途中に挟まる
 * 複数段の .then/.catch チェーンをまとめて待てる。
 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// jsdom は document.execCommand 自体を実装しない（未定義プロパティ）ため、
// テストごとに差し替えられるよう型付きの薄いヘルパーを介して操作する
// （`any` キャスト・`delete` 演算子を避ける。Issue #116）。
type ExecCommandFn = (commandId: string) => boolean;
type DocumentWithExecCommand = { execCommand?: ExecCommandFn };

function stubExecCommand(fn: ExecCommandFn | undefined): void {
  Object.defineProperty(document as DocumentWithExecCommand, "execCommand", {
    value: fn,
    writable: true,
    configurable: true,
  });
}

// brightBlack が background/foreground の中間の明度にあることを検証するための
// ざっくりした明度（0〜255）。3色ともグレー系（RGB 各チャンネルがほぼ同値）
// なので、大小関係の検証には各チャンネルの単純平均で十分（WCAG のガンマ補正
// 付き相対輝度までは不要というのが KISS の判断）。
function approxBrightness(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (r + g + b) / 3;
}

describe("createXtermInstance", () => {
  beforeEach(() => {
    terminalCtor.mockClear();
    customKeyEventHandlers.length = 0;
    selectionChangeCallbacks.length = 0;
    LOADED_ADDONS.length = 0;
    mockHasSelection = false;
    mockSelectionText = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // テスト間の汚染を防ぐため、execCommand スタブを毎回リセットする。
    stubExecCommand(undefined);
  });

  it("等幅フォントスタックと明示的な fontSize を Terminal に渡す（プロンプト表示の文字崩れ防止 #27）", async () => {
    const { createXtermInstance } = await import("./xterm-adapter.ts");
    const container = document.createElement("div");

    createXtermInstance(container);

    expect(terminalCtor).toHaveBeenCalledTimes(1);
    const call = terminalCtor.mock.calls[0];
    if (!call) throw new Error("Terminal コンストラクタが呼ばれていません");
    const options = call[0] as {
      fontFamily?: string;
      fontSize?: number;
    };
    expect(options.fontFamily).toMatch(/monospace/);
    // ui-monospace/SFMono-Regular 等の具体的な等幅フォントを先頭候補に含む
    // （generic な "monospace" 単体には依存しない）。
    expect(options.fontFamily).toMatch(/ui-monospace|SFMono|Menlo/);
    expect(typeof options.fontSize).toBe("number");
    expect(options.fontSize).toBeGreaterThan(0);
  });

  it("macOptionClickForcesSelection を true にする（Issue #116: tmux の mouse on 環境で Option+ドラッグにより xterm.js のネイティブ選択を強制する既定 false の逃げ道を有効化する）", async () => {
    const { createXtermInstance } = await import("./xterm-adapter.ts");

    createXtermInstance(document.createElement("div"));

    const call = terminalCtor.mock.calls[0];
    if (!call) throw new Error("Terminal コンストラクタが呼ばれていません");
    const options = call[0] as { macOptionClickForcesSelection?: boolean };
    expect(options.macOptionClickForcesSelection).toBe(true);
  });

  it("theme に background より明るく foreground より暗い brightBlack を定義する（補完候補の視認性 #46）", async () => {
    const { createXtermInstance } = await import("./xterm-adapter.ts");

    createXtermInstance(document.createElement("div"));

    const call = terminalCtor.mock.calls[0];
    if (!call) throw new Error("Terminal コンストラクタが呼ばれていません");
    const options = call[0] as {
      theme?: {
        background?: string;
        foreground?: string;
        brightBlack?: string;
      };
    };
    const theme = options.theme;
    if (!theme?.background || !theme.foreground || !theme.brightBlack) {
      throw new Error(
        "theme.background/foreground/brightBlack が定義されていません",
      );
    }
    const backgroundBrightness = approxBrightness(theme.background);
    const brightBlackBrightness = approxBrightness(theme.brightBlack);
    const foregroundBrightness = approxBrightness(theme.foreground);
    expect(brightBlackBrightness).toBeGreaterThan(backgroundBrightness);
    expect(brightBlackBrightness).toBeLessThan(foregroundBrightness);
  });

  it("選択範囲がある状態で Cmd+C を検知すると getSelection の内容をクリップボードへ書き込み、xterm への通常キー処理を止める（#44）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mockHasSelection = true;
    mockSelectionText = "selected text";

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    expect(customKeyEventHandlers).toHaveLength(1);
    const handler = customKeyEventHandlers[0];
    if (!handler)
      throw new Error("attachCustomKeyEventHandler が登録されていません");
    const event = new KeyboardEvent("keydown", { key: "c", metaKey: true });

    const result = handler(event);

    expect(result).toBe(false);
    expect(writeText).toHaveBeenCalledWith("selected text");
  });

  it("選択が無い状態で Cmd+C 相当のキーイベントを受けても xterm の通常キー処理（Ctrl+C の SIGINT 等の入力転送）を妨げない（#44 回帰確認）", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mockHasSelection = false;

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    const handler = customKeyEventHandlers[0];
    if (!handler)
      throw new Error("attachCustomKeyEventHandler が登録されていません");
    const event = new KeyboardEvent("keydown", { key: "c", metaKey: true });

    const result = handler(event);

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("選択がある状態でも Ctrl+C（ctrlKey）はコピーとして横取りせず、SIGINT 相当の入力転送を妨げない（#44 コピーは Cmd+C 限定・回帰防止）", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mockHasSelection = true;
    mockSelectionText = "selected text";

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    const handler = customKeyEventHandlers[0];
    if (!handler)
      throw new Error("attachCustomKeyEventHandler が登録されていません");
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });

    const result = handler(event);

    // 判定条件を metaKey || ctrlKey に誤変更すると Ctrl+C を横取りし SIGINT が
    // 壊れる。ここで true・未書き込みを固定してその回帰を検知する。
    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keyup イベントではクリップボードへ書き込まない（xterm.js が同一ハンドラを keydown/keyup 双方で呼ぶことによる二重発火の回帰防止）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mockHasSelection = true;
    mockSelectionText = "selected text";

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    const handler = customKeyEventHandlers[0];
    if (!handler)
      throw new Error("attachCustomKeyEventHandler が登録されていません");
    const keyupEvent = new KeyboardEvent("keyup", { key: "c", metaKey: true });

    const result = handler(keyupEvent);

    expect(result).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("選択が非空になった時点で選択テキストを即座にクリップボードへコピーする（#73 copy-on-select。TUI の再描画で選択が消える前にコピーを完了させる）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    expect(selectionChangeCallbacks).toHaveLength(1);
    const onSelectionChange = selectionChangeCallbacks[0];
    if (!onSelectionChange)
      throw new Error("onSelectionChange が登録されていません");

    mockHasSelection = true;
    mockSelectionText = "copied on select";
    onSelectionChange();

    expect(writeText).toHaveBeenCalledWith("copied on select");
  });

  it("選択が空になった時点ではクリップボードを上書きしない（直前にコピーした内容を残す）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    const onSelectionChange = selectionChangeCallbacks[0];
    if (!onSelectionChange)
      throw new Error("onSelectionChange が登録されていません");

    mockHasSelection = false;
    mockSelectionText = "";
    onSelectionChange();

    expect(writeText).not.toHaveBeenCalled();
  });

  it("navigator.clipboard が undefined の環境では選択変化イベントで例外を投げず、代わりに execCommand フォールバックでコピーする", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    stubExecCommand(execCommand);

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    const onSelectionChange = selectionChangeCallbacks[0];
    if (!onSelectionChange)
      throw new Error("onSelectionChange が登録されていません");

    mockHasSelection = true;
    mockSelectionText = "no clipboard api";

    expect(() => onSelectionChange()).not.toThrow();
    await flushAsync();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("直前にコピーした文字列と同一の選択変化通知では writeText を再度呼ばない（ドラッグ中の高頻度発火の抑制）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    const onSelectionChange = selectionChangeCallbacks[0];
    if (!onSelectionChange)
      throw new Error("onSelectionChange が登録されていません");

    mockHasSelection = true;
    mockSelectionText = "same text";
    onSelectionChange();
    onSelectionChange();

    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("選択解除を挟んで再び同一文字列を選択した場合は writeText を呼び直す（dedup状態は選択解除でリセットされる。selfレビュー指摘の回帰防止）", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    const onSelectionChange = selectionChangeCallbacks[0];
    if (!onSelectionChange)
      throw new Error("onSelectionChange が登録されていません");

    mockHasSelection = true;
    mockSelectionText = "reselected text";
    onSelectionChange();

    mockHasSelection = false;
    mockSelectionText = "";
    onSelectionChange();

    mockHasSelection = true;
    mockSelectionText = "reselected text";
    onSelectionChange();

    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("書き込みに失敗した選択内容は dedup 記録されず、次の選択変化で再試行される（Issue #116: writeText 失敗時に誤って dedup 記録していたバグの修正）", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const execCommand = vi.fn().mockReturnValue(false);
    stubExecCommand(execCommand);

    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    const onSelectionChange = selectionChangeCallbacks[0];
    if (!onSelectionChange)
      throw new Error("onSelectionChange が登録されていません");

    mockHasSelection = true;
    mockSelectionText = "flaky text";
    onSelectionChange();
    await flushAsync();

    // writeText・execCommand フォールバックの両方が失敗しているため
    // dedup状態は確定しておらず、同一内容の再通知でも再試行できるはず。
    onSelectionChange();
    await flushAsync();

    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("ClipboardAddon をロードする（OSC 52 経由でクリップボード書き込みを要求するプログラムの橋渡し。読み取り無効化のカスタム IClipboardProvider を使用。Issue #116）", async () => {
    const { createXtermInstance } = await import("./xterm-adapter.ts");
    createXtermInstance(document.createElement("div"));

    expect(LOADED_ADDONS.some((addon) => addon.kind === "clipboard")).toBe(
      true,
    );
    // FitAddon が既存どおりロードされ続けていることも合わせて回帰確認する。
    expect(LOADED_ADDONS.some((addon) => addon.kind === "fit")).toBe(true);
  });

  describe("ClipboardAddon に渡すカスタム IClipboardProvider（PR #138 レビュー指摘: OSC 52 の読み取り要求でクリップボード内容が pty 入力へ流出する経路の遮断）", () => {
    function getLoadedClipboardProvider(): MockClipboardProvider {
      const clipboardAddon = LOADED_ADDONS.find(
        (addon) => addon.kind === "clipboard",
      );
      if (!clipboardAddon?.provider) {
        throw new Error("ClipboardAddon に provider が渡されていません");
      }
      return clipboardAddon.provider;
    }

    it("readText は常に空文字列を返し、navigator.clipboard.readText を呼ばない（OSC 52 の読み取り要求 `?` 相当）", async () => {
      const readText = vi.fn().mockResolvedValue("secret from os clipboard");
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { readText, writeText } });

      const { createXtermInstance } = await import("./xterm-adapter.ts");
      createXtermInstance(document.createElement("div"));

      const result = getLoadedClipboardProvider().readText("c");

      expect(result).toBe("");
      expect(readText).not.toHaveBeenCalled();
    });

    it("writeText は既存のコピー経路（copyToClipboard）へ委譲する（OSC 52 の書き込み要求）", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { clipboard: { writeText } });

      const { createXtermInstance } = await import("./xterm-adapter.ts");
      createXtermInstance(document.createElement("div"));

      await getLoadedClipboardProvider().writeText("c", "osc52 written text");

      expect(writeText).toHaveBeenCalledWith("osc52 written text");
    });

    it("writeText の委譲先（copyToClipboard）が失敗しても例外を投げない", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("denied"));
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      stubExecCommand(vi.fn().mockReturnValue(false));

      const { createXtermInstance } = await import("./xterm-adapter.ts");
      createXtermInstance(document.createElement("div"));

      await expect(
        getLoadedClipboardProvider().writeText("c", "will fail"),
      ).resolves.toBeUndefined();
    });
  });

  describe("Cmd+C ハンドラの execCommand フォールバック（#116: 実ブラウザでは navigator.clipboard.writeText が非同期APIの拒否等で reject しうる）", () => {
    it("navigator.clipboard.writeText が reject した場合、document.execCommand('copy') フォールバックでコピーする", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("denied"));
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const execCommand = vi.fn().mockReturnValue(true);
      stubExecCommand(execCommand);
      mockHasSelection = true;
      mockSelectionText = "selected text";

      const { createXtermInstance } = await import("./xterm-adapter.ts");
      createXtermInstance(document.createElement("div"));

      const handler = customKeyEventHandlers[0];
      if (!handler)
        throw new Error("attachCustomKeyEventHandler が登録されていません");
      const event = new KeyboardEvent("keydown", { key: "c", metaKey: true });

      const result = handler(event);
      await flushAsync();

      expect(result).toBe(false);
      expect(writeText).toHaveBeenCalledWith("selected text");
      expect(execCommand).toHaveBeenCalledWith("copy");
    });

    it("execCommand フォールバック実行後、コピー前にフォーカスしていた要素（xterm.js の隠し textarea 相当）へ明示的にフォーカスを復元する（フォールバックが xterm への入力フォーカスを奪ったままにしない。code-reviewer 指摘の回帰防止）", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("denied"));
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const hiddenXtermTextarea = document.createElement("textarea");
      document.body.appendChild(hiddenXtermTextarea);
      hiddenXtermTextarea.focus();
      // jsdom は select() での暗黙のフォーカス移動（実ブラウザの仕様）を再現
      // しないため、「元のフォーカス先へ戻す実装」の有無を、活性要素の比較
      // ではなく明示的な focus() 呼び出しの有無で検証する。
      const restoreFocusSpy = vi.spyOn(hiddenXtermTextarea, "focus");
      const execCommand = vi.fn().mockReturnValue(true);
      stubExecCommand(execCommand);
      mockHasSelection = true;
      mockSelectionText = "selected text";

      const { createXtermInstance } = await import("./xterm-adapter.ts");
      createXtermInstance(document.createElement("div"));

      const handler = customKeyEventHandlers[0];
      if (!handler)
        throw new Error("attachCustomKeyEventHandler が登録されていません");
      const event = new KeyboardEvent("keydown", { key: "c", metaKey: true });

      handler(event);
      await flushAsync();

      expect(restoreFocusSpy).toHaveBeenCalled();
      document.body.removeChild(hiddenXtermTextarea);
    });

    it("navigator.clipboard が undefined の場合も document.execCommand('copy') フォールバックでコピーし、xterm への通常キー処理を止める", async () => {
      vi.stubGlobal("navigator", {});
      const execCommand = vi.fn().mockReturnValue(true);
      stubExecCommand(execCommand);
      mockHasSelection = true;
      mockSelectionText = "selected text";

      const { createXtermInstance } = await import("./xterm-adapter.ts");
      createXtermInstance(document.createElement("div"));

      const handler = customKeyEventHandlers[0];
      if (!handler)
        throw new Error("attachCustomKeyEventHandler が登録されていません");
      const event = new KeyboardEvent("keydown", { key: "c", metaKey: true });

      const result = handler(event);
      await flushAsync();

      expect(result).toBe(false);
      expect(execCommand).toHaveBeenCalledWith("copy");
    });

    it("writeText・execCommand フォールバックの双方が失敗しても例外を投げない（コピー失敗はターミナルの他の動作に影響させない）", async () => {
      const writeText = vi.fn().mockRejectedValue(new Error("denied"));
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const execCommand = vi.fn().mockReturnValue(false);
      stubExecCommand(execCommand);
      mockHasSelection = true;
      mockSelectionText = "selected text";

      const { createXtermInstance } = await import("./xterm-adapter.ts");
      createXtermInstance(document.createElement("div"));

      const handler = customKeyEventHandlers[0];
      if (!handler)
        throw new Error("attachCustomKeyEventHandler が登録されていません");
      const event = new KeyboardEvent("keydown", { key: "c", metaKey: true });

      expect(() => handler(event)).not.toThrow();
      await flushAsync();
    });
  });
});
