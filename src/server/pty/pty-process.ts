import * as nodePty from "node-pty";

export type PtyExitEvent = { exitCode: number; signal?: number };

export type PtyProcess = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
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
  };
}

/**
 * `tmux attach -t <sessionName>` を spawn する（cwd＝エージェント repo ルート）。
 * WS `/ws/terminal` 接続確立後、node-pty で pty ⇔ WS の双方向ストリームを開始する
 * ために使う（architecture.md §3.5）。
 */
export function createNodePtySpawner(): SpawnTerminalPty {
  return (sessionName, cwd) =>
    spawnPtyProcess("tmux", ["attach", "-t", sessionName], { cwd });
}
