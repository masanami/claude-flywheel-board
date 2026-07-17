import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

// @xterm/xterm を直接 import する箇所をこのファイルに閉じ込める薄いラッパー。
// jsdom は xterm.js の実描画（canvas 依存）を実行できないため、TerminalPane.tsx の
// テストでは CreateXtermInstance を丸ごとモックに差し替え、実描画そのものは
// 単体テスト対象外とする。一方、Terminal に渡す「生成オプション」（fontFamily 等）
// はモック無しで検証可能なため、xterm-adapter.test.ts で @xterm/xterm 自体を
// モックして固定している（詳細はそちらを参照）。

export type XtermInstance = {
  write(data: string): void;
  onData(callback: (data: string) => void): void;
  /** container にフィットさせ、結果の cols/rows を返す（fit addon 呼び出し）。 */
  fit(): { cols: number; rows: number };
  dispose(): void;
};

export type CreateXtermInstance = (container: HTMLElement) => XtermInstance;

// xterm.js の既定 fontFamily は generic な "monospace" キーワードのみ（v6）。
// 実行環境のフォールバック次第でグリフ幅が xterm.js の計測値とずれ、固定セル幅
// グリッド上でプロポーショナルな見た目の文字（例: bold 装飾された prompt の
// パス表示）が欠けて見える・単語内に空白が入って見える不具合が起きる（#27）。
// 等幅であることが保証された具体的なフォントスタックと fontSize を明示する。
const MONOSPACE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const FONT_SIZE_PX = 14;

export const createXtermInstance: CreateXtermInstance = (container) => {
  const terminal = new Terminal({
    // ターミナル領域はライト/ダームテーマに関わらずダーク固定（要件どおり）。
    theme: { background: "#17181c", foreground: "#e7e7ea" },
    convertEol: true,
    fontFamily: MONOSPACE_FONT_FAMILY,
    fontSize: FONT_SIZE_PX,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  return {
    write(data: string) {
      terminal.write(data);
    },
    onData(callback: (data: string) => void) {
      terminal.onData(callback);
    },
    fit() {
      fitAddon.fit();
      return { cols: terminal.cols, rows: terminal.rows };
    },
    dispose() {
      terminal.dispose();
    },
  };
};
