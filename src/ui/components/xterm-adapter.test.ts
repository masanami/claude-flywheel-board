import { describe, expect, it, vi } from "vitest";

// @xterm/xterm・@xterm/addon-fit は jsdom では実描画できないため、
// Terminal コンストラクタに渡されたオプションだけを検証できるようモックする。
const terminalCtor = vi.fn();
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor(options: Record<string, unknown>) {
      terminalCtor(options);
    }
    loadAddon() {}
    open() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

describe("createXtermInstance", () => {
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
});
