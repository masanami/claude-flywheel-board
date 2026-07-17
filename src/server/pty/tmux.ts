import { execFile } from "node:child_process";

export type TmuxClient = {
  hasSession(sessionName: string): Promise<boolean>;
  newSession(sessionName: string, cwd: string): Promise<void>;
  sendKeysLiteral(sessionName: string, command: string): Promise<void>;
};

/** tmux コマンドを実行する（成功時は resolve、失敗時は reject）。DI 用の型。 */
export type CommandRunner = (command: string, args: string[]) => Promise<void>;

/**
 * `tmux has-session` はセッションが無い場合に非ゼロ終了するのが正常系のため、
 * 例外を reject にせず真偽値へ吸収する専用の runner を分離する。DI 用の型。
 */
export type HasSessionCheckRunner = (
  command: string,
  args: string[],
) => Promise<boolean>;

function defaultRunCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function defaultRunHasSessionCheck(
  command: string,
  args: string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, (error) => {
      resolve(!error);
    });
  });
}

/**
 * 改行 (\r\n) をスペースに正規化する。
 *
 * クリティカル設計決定（親 Issue #2 / #14・書き込み境界）: prefill は
 * `tmux send-keys -l` により literal・改行なしで送信する。呼び出し元が渡す
 * command 文字列に改行が含まれていても、ここで必ず除去することで
 * 「Enter 相当のコードパスを一切作らない」契約をコード上で担保する。
 */
export function stripNewlines(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export type TmuxClientDeps = {
  runCommand?: CommandRunner;
  runHasSessionCheck?: HasSessionCheckRunner;
};

export function createTmuxClient(deps: TmuxClientDeps = {}): TmuxClient {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const runHasSessionCheck =
    deps.runHasSessionCheck ?? defaultRunHasSessionCheck;

  return {
    hasSession(sessionName) {
      return runHasSessionCheck("tmux", ["has-session", "-t", sessionName]);
    },
    newSession(sessionName, cwd) {
      return runCommand("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        cwd,
      ]);
    },
    sendKeysLiteral(sessionName, command) {
      // -l（literal）フラグのみを付与し、Enter に相当する追加キー送信は行わない。
      // `--` で以降をオプションとして解釈させないガードを挟む（command が
      // `-` で始まっていても tmux 側のフラグとして誤解釈されない defense-in-depth）。
      return runCommand("tmux", [
        "send-keys",
        "-t",
        sessionName,
        "-l",
        "--",
        stripNewlines(command),
      ]);
    },
  };
}

/**
 * `tmux has-session` → 無ければ `tmux new-session -d -s <name> -c <cwd>` の
 * オーケストレーション（architecture.md §3.5 のセッションライフサイクル）。
 */
export async function ensureTmuxSession(
  tmux: TmuxClient,
  sessionName: string,
  cwd: string,
): Promise<void> {
  const exists = await tmux.hasSession(sessionName);
  if (!exists) {
    await tmux.newSession(sessionName, cwd);
  }
}
