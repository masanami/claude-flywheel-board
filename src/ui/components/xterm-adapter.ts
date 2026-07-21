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
    theme: {
      background: "#17181c",
      foreground: "#e7e7ea",
      // 補完候補（dim/ゴースト表示）用のグレー。background より明るく
      // foreground より暗い明度に固定し、通常入力文字とはっきり区別できる
      // ようにする（#46）。xterm.js の minimumContrastRatio は既定値が
      // 1（＝補正なし。型定義コメント "1: The default, do nothing." 参照）
      // のため明示指定はしない。既定のままで dim の明度差が意図せず
      // 持ち上げられる心配は無いと確認済み。
      brightBlack: "#6c6f78",
    },
    convertEol: true,
    fontFamily: MONOSPACE_FONT_FAMILY,
    fontSize: FONT_SIZE_PX,
  });

  // ターミナル上の選択範囲を Cmd+C で OS クリップボードへコピーできるように
  // する（#44）。xterm.js は選択→クリップボードの自動コピーを行わないため、
  // attachCustomKeyEventHandler でキー入力を横取りする。
  //
  // このハンドラは xterm.js が内部でアタッチする隠し textarea の keydown/
  // keyup/keypress リスナの中から呼ばれるものであり、attach-input-gate.ts が
  // capture フェーズで container に貼る keydown リスナ（ゲートを開く役割）
  // とは別のレイヤーで動作する（両モジュールの前提はそちらのファイル冒頭
  // コメントを参照）。capture フェーズのリスナは常にこの層より先に発火する
  // ため、Cmd+C のキー入力そのものは通常のキー入力と同様にゲートを開く
  // （＝互いを妨げない）。
  //
  // event.type === "keydown" に限定するのは、xterm.js が同一ハンドラを keyup
  // でも呼び出すため（コピー操作後も選択は残るので isCopyShortcut かつ
  // hasSelection() が keyup でも真になり、writeText が二重発火してしまう）。
  //
  // 選択がある場合のみ getSelection() をクリップボードへ書き出し、false を
  // 返して xterm.js の通常処理（onData 発火）を止める。選択が無い通常の
  // キー入力（Ctrl+C による SIGINT 相当のシグナル送出等）では true を返し、
  // 既存の入力転送フローを一切妨げない。
  terminal.attachCustomKeyEventHandler((event) => {
    const isCopyShortcut =
      event.type === "keydown" &&
      event.metaKey &&
      event.key.toLowerCase() === "c";
    if (isCopyShortcut && terminal.hasSelection()) {
      // Clipboard API 非対応環境（navigator.clipboard が undefined）では、
      // .writeText へのプロパティアクセスで同期例外になるのを避けるため、
      // コピーを諦めて通常キー処理へ委ねる（true を返す）。127.0.0.1 固定
      // バインド＝secure context のため現実の到達性は限定的だが防御的に扱う。
      if (!navigator.clipboard) {
        return true;
      }
      // クリップボード書き込みの失敗（フォーカス喪失・権限拒否等）はコピー
      // 操作自体の失敗に留め、ターミナルの他の動作には影響させない。
      navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
      return false;
    }
    return true;
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
