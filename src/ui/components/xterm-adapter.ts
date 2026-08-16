import {
  ClipboardAddon,
  type IClipboardProvider,
} from "@xterm/addon-clipboard";
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

/**
 * `navigator.clipboard.writeText` の同期フォールバック（Issue #116）。
 *
 * 実ブラウザでは Clipboard 非同期 API がフォーカス喪失・権限拒否等のエッジ
 * ケースで reject しうる（ユニットテストの常時 resolve するモックでは
 * 再現しない）。off-screen の一時 `<textarea>` を使う `document.execCommand`
 * 経由の同期コピーは非推奨 API だが、ユーザージェスチャー起因の呼び出し
 * スタック内で同期的に呼ばれる限り機能する defense-in-depth として許容する。
 */
function copyUsingExecCommandFallback(text: string): boolean {
  // execCommand("copy") はフォーカス中の選択範囲に対して働くため、一時
  // textarea へ明示的にフォーカスを移す必要がある。この間 xterm.js が
  // 内部で保持する隠し textarea（ユーザーの入力フォーカス先）からフォーカス
  // が奪われるため、後始末で必ず元のフォーカス先へ戻す（code-reviewer
  // 指摘: 戻し忘れるとコピーのたびにターミナルへの入力が止まって見える）。
  const previouslyFocused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  // 画面上に一切見えないようにする（off-screen 配置）。
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let succeeded = false;
  try {
    succeeded = document.execCommand("copy");
  } catch {
    // execCommand 自体が未実装（一部環境）または拒否された場合も、
    // コピー失敗として扱うだけで例外は外へ伝播させない。
    succeeded = false;
  } finally {
    document.body.removeChild(textarea);
    previouslyFocused?.focus();
  }
  return succeeded;
}

/**
 * クリップボードへの書き込みを試み、`navigator.clipboard` が無い場合・
 * `writeText` が reject した場合は同期フォールバック（execCommand）へ
 * 委ねる（Issue #116。#44/#73 で導入した各コピー経路の共通ヘルパー）。
 * 双方とも失敗した場合は reject する。
 */
function copyToClipboard(text: string): Promise<void> {
  if (!navigator.clipboard) {
    return copyUsingExecCommandFallback(text)
      ? Promise.resolve()
      : Promise.reject(new Error("clipboard write failed"));
  }
  return navigator.clipboard.writeText(text).catch(() => {
    if (!copyUsingExecCommandFallback(text)) {
      throw new Error("clipboard write failed");
    }
  });
}

/**
 * `ClipboardAddon`（OSC 52 ブリッジ）に渡すカスタム `IClipboardProvider`。
 *
 * 既定の `BrowserClipboardProvider` は OSC 52 の読み取り要求（`?`）に対し
 * `navigator.clipboard.readText()` の結果を `terminal.input()` 経由で pty
 * への入力として送り返す。pty 内で任意のプログラムが動く以上、これは
 * クリップボード内容（パスワード等の機密を含みうる）が pty 入力ストリームへ
 * 流出しうる経路になる（PR #138 レビュー指摘対応）。
 *
 * `readText` を常に空文字列で応答させることでこの経路を遮断する
 * （`navigator.clipboard.readText()` 自体を呼ばないため、ブラウザの
 * clipboard-read 権限プロンプトも発生しない）。書き込み方向（OSC 52 の
 * write 要求）は正当な用途のため許可し、`copyToClipboard`（writeText 失敗時
 * の execCommand フォールバックを含む共通経路）へ委譲する。
 */
const readDisabledClipboardProvider: IClipboardProvider = {
  readText: () => "",
  writeText: (_selection, data) => copyToClipboard(data).catch(() => {}),
};

/**
 * Terminal 生成オプション（board の埋め込みターミナルの端末エミュレーション設定）。
 *
 * `createXtermInstance` から分離して export しているのは、エミュレーション挙動の
 * 回帰テスト（xterm-emulation.test.ts）が「本番と同一のオプション」を
 * `@xterm/headless` に渡して検証できるようにするため（Issue #148）。オプションを
 * テスト側で書き写すと、本番設定を変えてもテストが追随せず回帰を検出できない。
 */
export const TERMINAL_OPTIONS = {
  // ターミナル領域はライト/ダークテーマに関わらずダーク固定（要件どおり）。
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
  // convertEol は指定しない（＝既定の false のまま）。Issue #148。
  //
  // convertEol を true にすると xterm.js は LF を受け取るたびにカーソル列を
  // 0 へ戻す（InputHandler.lineFeed が `buffer.x = 0` を実行する＝LF を暗黙の
  // CR+LF として扱う）。これは pty 由来のデータに対しては誤りで、xterm.js の
  // 型定義自身が「通常は pty の termios が LF→CRLF 変換を担うので、この設定を
  // 使うべきではない（non-PTY なデータ源のための設定）」と明記している。
  //
  // board のデータ源はまさに pty（node-pty → tmux）であり、以下の前提が揃う:
  //   - `infocmp xterm-256color` の `cud1` / `ind` はいずれも `^J`（＝素の LF）。
  //     つまり tmux は「列を保ったまま 1 行下げる」ために素の LF を送ってよい。
  //   - tmux は自身の pty の termios から `OPOST|ONLCR` を落とすため、pty 層が
  //     CR を足し直すことはない。
  // したがって convertEol: true のままだと、tmux が cud1/ind を選んだ瞬間に
  // xterm.js 側だけカーソルが 1 列目へ戻り、以降 tmux が書く文字が「本来とは
  // 別の列」＝1 列目に着弾する。さらに tmux は差分再描画（自分が把握している
  // 端末内容と一致するセルは書き直さない。実際の tmux 出力でも 2 スペース
  // インデント行を `ESC[<row>;3H` と列 3 から描き始め、変化のない区間を
  // `ESC[<n>C` で読み飛ばす）を行うため、一度ずれたセルは二度と上書きされず
  // 残骸として焼き付く。これは #148 の症状そのものである。
  fontFamily: MONOSPACE_FONT_FAMILY,
  fontSize: FONT_SIZE_PX,
  // tmux の `mouse on`（ユーザーの ~/.tmux.conf 由来。board 専用ソケットにも
  // 読み込まれる）環境では、tmux がマウストラッキングを要求するため
  // xterm.js 側のネイティブ選択（copy-on-select・Cmd+C の前提）が発生
  // しなくなる（Issue #116 調査結果）。既定 false のこのオプションを
  // true にすると、Option (⌥) + ドラッグでマウストラッキングを無視して
  // xterm.js のネイティブ選択を強制できる「逃げ道」が有効になる。
  macOptionClickForcesSelection: true,
} as const;

export const createXtermInstance: CreateXtermInstance = (container) => {
  const terminal = new Terminal({ ...TERMINAL_OPTIONS });

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
      // クリップボード書き込みの失敗（Clipboard API 非対応・フォーカス喪失・
      // 権限拒否等）は copyToClipboard 内の execCommand フォールバックに
      // 委ね、それも失敗した場合のみコピー操作自体の失敗として握り潰す
      // （ターミナルの他の動作には影響させない。Issue #116）。
      copyToClipboard(terminal.getSelection()).catch(() => {});
      return false;
    }
    return true;
  });

  // 選択直後に即座にクリップボードへコピーする（copy-on-select、#73）。
  // Claude Code の TUI はスピナー/ストリーミングで常時再描画しており、xterm.js
  // は表示内容が書き換わると選択を解除する。そのため「選択を保持したまま
  // Cmd+C を押す」前提（上記 attachCustomKeyEventHandler）は、再描画によって
  // Cmd+C を押す前に選択が消えてしまい機能しないケースがある。選択が確定した
  // 時点（onSelectionChange 発火時）で即座にコピーしておけば、後で選択が
  // 再描画により消えてもクリップボードには既に内容が入っているため実害がない。
  //
  // 直前にコピーした文字列を保持し、同一内容の再通知（ドラッグ中の高頻度
  // 発火）では writeText を呼び直さない（無駄な呼び出しの抑制。KISS を保ち
  // 複雑なデバウンス機構は導入しない）。
  let lastCopiedSelection: string | null = null;
  terminal.onSelectionChange(() => {
    if (!terminal.hasSelection()) {
      // 選択が解除された時点で dedup 状態もリセットする。保持したままだと、
      // 選択解除後に外部で別の内容をクリップボードにコピーし、その後
      // ターミナルで再び同じテキストを選択し直しても再コピーされず、
      // 「選択したのにクリップボードが古いままになる」直感に反する挙動に
      // なるため（selfレビュー指摘）。
      lastCopiedSelection = null;
      return;
    }
    const selection = terminal.getSelection();
    if (!selection) {
      return;
    }
    if (selection === lastCopiedSelection) {
      return;
    }
    // 呼び出し直後（Promise 解決前）に来る同一内容の再通知も抑制したいため、
    // 呼び出し前に同期的に「試行中」として記録する（ドラッグ中の高頻度発火の
    // 抑制。KISS を保ち複雑なデバウンス機構は導入しない）。
    //
    // ただし copyToClipboard（writeText と execCommand フォールバックの
    // 両方）が最終的に失敗した場合は、この記録を取り消して次の選択変化で
    // 再試行できるようにする（Issue #116: 失敗時も「コピー済み」として
    // 記録してしまい、以後同じ内容が二度と再送されなくなっていたバグの
    // 修正。「同一内容の再通知はスキップする」抑制効果は成功時のみ維持する）。
    lastCopiedSelection = selection;
    copyToClipboard(selection).catch(() => {
      if (lastCopiedSelection === selection) {
        lastCopiedSelection = null;
      }
    });
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // pty 内で動くプログラム（Claude Code 自身・tmux copy-mode・vim 等）が
  // OSC 52 エスケープシーケンスでクリップボード書き込みを要求した場合に、
  // xterm.js から navigator.clipboard.writeText へ橋渡しする（Issue #116。
  // #118 が指摘した「macOS 依存の経路」を board 側で明示的に持つための
  // 対応）。読み取り要求は空応答で無効化し、クリップボード内容が pty 入力
  // へ流れる経路を遮断する（PR #138 レビュー指摘対応。詳細は
  // readDisabledClipboardProvider のコメントを参照）。
  terminal.loadAddon(
    new ClipboardAddon(undefined, readDisabledClipboardProvider),
  );

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
