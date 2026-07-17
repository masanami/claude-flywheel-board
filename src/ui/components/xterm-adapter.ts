import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

// @xterm/xterm を直接 import する箇所をこのファイルに閉じ込める薄いラッパー。
// jsdom は xterm.js の描画（canvas 依存）を実行できないため、テストでは
// CreateXtermInstance を丸ごとモックに差し替える（TerminalPane.tsx 参照）。
// このファイル自体は単体テスト対象外（ブラウザでの実物置き換え口）。

export type XtermInstance = {
  write(data: string): void;
  onData(callback: (data: string) => void): void;
  /** container にフィットさせ、結果の cols/rows を返す（fit addon 呼び出し）。 */
  fit(): { cols: number; rows: number };
  dispose(): void;
};

export type CreateXtermInstance = (container: HTMLElement) => XtermInstance;

export const createXtermInstance: CreateXtermInstance = (container) => {
  const terminal = new Terminal({
    // ターミナル領域はライト/ダームテーマに関わらずダーク固定（要件どおり）。
    theme: { background: "#17181c", foreground: "#e7e7ea" },
    convertEol: true,
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
