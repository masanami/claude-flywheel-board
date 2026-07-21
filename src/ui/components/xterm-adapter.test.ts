import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @xterm/xterm・@xterm/addon-fit は jsdom では実描画できないため、
// Terminal コンストラクタに渡されたオプションだけを検証できるようモックする。
const terminalCtor = vi.fn();
// attachCustomKeyEventHandler に登録されたハンドラを捕捉し、テストから
// キーイベントを模して直接呼び出せるようにする（#44 コピー連携の検証用）。
const customKeyEventHandlers: Array<(event: KeyboardEvent) => boolean> = [];
// hasSelection/getSelection の戻り値をテストごとに差し替えるための状態。
let mockHasSelection = false;
let mockSelectionText = "";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      terminalCtor(options);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      customKeyEventHandlers.push(handler);
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
    fit() {}
  },
}));

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
    mockHasSelection = false;
    mockSelectionText = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
