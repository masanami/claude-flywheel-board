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
    async newSession(sessionName, cwd) {
      await runCommand("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        cwd,
      ]);
      // 全画面 alt-screen UI（例: `/plugin`）で単独 Esc が tmux の既定 escape-time
      // （500ms）分だけ遅延・取りこぼしになる問題への対処（Issue #45）。
      //
      // escape-time は tmux 上「セッションオプション」として set-option -t
      // <session> で設定を試みても、実機検証の結果、実際にはサーバ全体
      // （同一 tmux サーバを共有する全セッション）に適用される（tmux の
      // escape-time 特有の挙動）。ここでは実際の挙動に合わせて -g
      // （グローバル/サーバスコープ）を明示的に使う。board が管理する tmux
      // セッション同士だけでなく、同一ユーザーが同じデフォルトソケットで
      // 使う他の tmux セッションにも影響し得るが、escape-time 0 化はローカル
      // 用途では概ね無害なため許容する（親チケットのクリティカル設計決定でも
      // サーバ/セッションスコープいずれも許容されている）。
      //
      // set-option 自体の失敗（万一 tmux サーバが直後に落ちた等）は
      // ベストエフォートとして扱い、newSession 全体を失敗させない。
      // セッション作成成功後に set-option だけが reject すると、
      // ensureTmuxSession の重複セッション再確認ロジック（hasSession の
      // 再チェックで存在すれば成功扱いにする経路）が意図せずこのエラーを
      // 握り潰してしまう（本来は duplicate-session エラー用の回復パス）。
      // set-option 失敗をここで明示的に吸収することで、その紛らわしい
      // 経路に依存せず、newSession の成否をセッション作成の成否だけに
      // 一致させる。
      try {
        await runCommand("tmux", ["set-option", "-g", "escape-time", "0"]);
      } catch (error) {
        console.warn(
          `tmux escape-time の設定に失敗しました（セッション "${sessionName}" 自体は作成済み）:`,
          error,
        );
      }
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
 *
 * 並行接続時の競合吸収: 複数の WS 接続がほぼ同時に `hasSession` を呼ぶと、
 * 双方が「無い」を見た直後に片方が先に `newSession` を成功させ、後発の
 * `newSession` は tmux の "duplicate session" エラーで失敗し得る。この場合、
 * newSession 失敗を即座に呼び出し元へ伝播させず、hasSession を再確認して
 * セッションが実在すれば（先発の newSession が成功した結果とみなし）成功扱いに
 * する。再確認しても存在しない場合（tmux バイナリ不在等、本当の失敗）は元の
 * エラーをそのまま rethrow する。
 */
export async function ensureTmuxSession(
  tmux: TmuxClient,
  sessionName: string,
  cwd: string,
): Promise<void> {
  const exists = await tmux.hasSession(sessionName);
  if (exists) {
    return;
  }

  try {
    await tmux.newSession(sessionName, cwd);
  } catch (error) {
    const existsAfterFailure = await tmux.hasSession(sessionName);
    if (!existsAfterFailure) {
      throw error;
    }
  }
}
