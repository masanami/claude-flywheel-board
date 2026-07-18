import * as nodePty from "node-pty";

export type PtyExitEvent = { exitCode: number; signal?: number };

export type PtyProcess = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /**
   * pty からのデータ出力（onData）を一時停止する（node-pty の flow control API）。
   * バックプレッシャー制御（Issue #26）: WS 送信バッファ（ws.bufferedAmount）が
   * 高水位を超えた際、呼び出し側（bridge.ts）がこれを呼ぶ。
   */
  pause(): void;
  /** pause() で止めた pty からのデータ出力を再開する。 */
  resume(): void;
};

export type SpawnTerminalPty = (sessionName: string, cwd: string) => PtyProcess;

export type SpawnPtyOptions = {
  cwd: string;
  cols?: number;
  rows?: number;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * node-pty の IPty を PtyProcess インタフェースへ変換する薄いアダプタ。
 * tmux に限らず任意のコマンドを spawn できる（テスト容易性のため一般化）。
 */
export function spawnPtyProcess(
  file: string,
  args: string[],
  options: SpawnPtyOptions,
): PtyProcess {
  const ptyProcess = nodePty.spawn(file, args, {
    name: "xterm-color",
    cols: options.cols ?? DEFAULT_COLS,
    rows: options.rows ?? DEFAULT_ROWS,
    cwd: options.cwd,
    env: process.env,
  });

  return {
    onData(listener) {
      ptyProcess.onData(listener);
    },
    onExit(listener) {
      ptyProcess.onExit((event) =>
        listener({ exitCode: event.exitCode, signal: event.signal }),
      );
    },
    write(data) {
      ptyProcess.write(data);
    },
    resize(cols, rows) {
      ptyProcess.resize(cols, rows);
    },
    kill() {
      ptyProcess.kill();
    },
    pause() {
      ptyProcess.pause();
    },
    resume() {
      ptyProcess.resume();
    },
  };
}

/**
 * `tmux attach -t <sessionName> \; refresh-client` を spawn する
 * （cwd＝エージェント repo ルート）。WS `/ws/terminal` 接続確立後、node-pty で
 * pty ⇔ WS の双方向ストリームを開始するために使う（architecture.md §3.5）。
 *
 * `refresh-client` を続けるのは、attach 直後のハンドシェイク中に xterm.js 側へ
 * 部分的な制御列が描画残骸（文字化け行）として残ることがあるため。attach 完了後に
 * tmux へ全画面再描画を要求して残骸を上書きする（tmux コマンドであり、シェルへの
 * 入力・実行は一切発生しない）。
 */
export function createNodePtySpawner(): SpawnTerminalPty {
  return (sessionName, cwd) =>
    spawnPtyProcess(
      "tmux",
      ["attach", "-t", sessionName, ";", "refresh-client"],
      { cwd },
    );
}
