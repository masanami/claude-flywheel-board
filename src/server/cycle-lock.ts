import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * run-cycle の排他ロック（`<workspace>/.flywheel/cycle.lock`）を board 側から
 * 取得・解放する。**プロトコルの正本は claude-flywheel 側 `scripts/cycle-lock.sh`**
 * であり、本モジュールはその再実装である（requirements.md §8）。
 *
 * なぜ shell out せず再実装するか（#165 の決定）: プラグイン cache のパスは版番号を
 * 含み（`~/.claude/plugins/cache/claude-flywheel/claude-flywheel/<version>/`）bump の
 * たびに変わるため、`cycle-lock.sh` を直接呼ぶと board の正しさが利用者のプラグイン
 * 導入状態（版が上がるまでの配布ラグを含む）に依存してしまう。依存は
 * **プロトコル＝ローカル規約のレベル**に留め、board → flywheel の一方向の依存を
 * ファイル規約以上に太らせない。
 *
 * 上流と厳密に一致させている 3 点（ここを崩すと排他が壊れる）:
 *  1. ロック本体の作成は `mkdir`（`recursive` を**付けない**）。付けると既存でも
 *     成功してしまい、TOCTOU を避けるための原子性が失われる。親ディレクトリ
 *     `<workspace>/.flywheel` だけは事前に `recursive: true` で確保する。
 *  2. 所有者メタデータの書き込みに失敗したらロックを解除して中止する。メタ無しの
 *     ロックが残ると、以後の acquire が「所有者不明・mtime 2 時間以内」の分岐で
 *     最長 2 時間ブロックされる。
 *  3. 解放は**所有者が一致するときだけ**（記録済み `session_id` 一致、または pid 一致）。
 *     不一致なら削除しない。
 *
 * 上流と意図的に**異なる** 1 点（board 側の安全側の縮退）: board は**残骸ロックの
 * 回収を行わない**。上流の回収手順は `runs.jsonl` への `cycle_end (result=abandoned)`
 * 代筆を伴い、それは NFR-01 の区分③（エージェントの状態機械）にあたり board が
 * 書いてはならない。したがって board は既存ロックを見つけたら**種類を問わず取得を
 * 諦める**（削除もしない）。残骸は次の run-cycle が回収する。承認が一時的にできない
 * だけで自走は妨げないため、NFR-02（オプショナル性）に沿う縮退である。
 */

/** ワークスペースルートからのロックディレクトリの相対パス。 */
export const CYCLE_LOCK_RELATIVE_PATH = path.join(".flywheel", "cycle.lock");

/** 所有者メタデータのファイル名（ロックディレクトリ内）。 */
const OWNER_FILE_NAME = "owner";

/**
 * 所有者を特定できないロックを「並走中」とみなす猶予（ミリ秒）。上流
 * `cycle-lock.sh` の 7200 秒（2 時間）と同じ値。board は回収しないため
 * この閾値は**メッセージの出し分けにのみ**使う（超過していれば「残骸の可能性」と
 * 案内し、次の run-cycle が回収することを伝える）。
 */
const STALE_LOCK_THRESHOLD_MS = 7200 * 1000;

export function cycleLockPathFor(workspacePath: string): string {
  return path.join(workspacePath, CYCLE_LOCK_RELATIVE_PATH);
}

/**
 * ISO 8601（タイムゾーンオフセットはコロン付き `+09:00` 形式）の現在時刻。
 * 上流 `iso_now()`（`date +%Y-%m-%dT%H:%M:%S%z` ＋ コロン挿入）と同じ形にする。
 */
function isoNow(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  // getTimezoneOffset は「UTC - ローカル」の分数（JST なら -540）。表示は符号を反転する。
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * PID の開始時刻（`ps -o lstart=`）を空白正規化して返す。プロセス不在・`ps` が
 * 使えない環境では空文字。上流 `pid_lstart()` と同じ正規化（前後の空白除去・
 * 連続空白の 1 個への圧縮）を行う——board が書いた値を上流スクリプトが読んで
 * 比較するため、表記が一致していなければ生存判定が常に不一致になる。
 */
export function pidStartTime(pid: number): string {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (out.split("\n")[0] ?? "").trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

/** owner メタデータ（key=value 行）から key の値を返す。読めなければ undefined。 */
function metaGet(content: string, key: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1);
    }
  }
  return undefined;
}

/** ロックディレクトリの owner ファイルを読む。存在しない・読めない場合は undefined。 */
function readOwnerMeta(lockPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(lockPath, OWNER_FILE_NAME), "utf-8");
  } catch {
    return undefined;
  }
}

export type CycleLockHandle = {
  /**
   * ロックを解放する。所有者が一致しない場合は**削除せず** false を返す
   * （上流 exit code 3 に相当）。解放済み・ロック不在なら true。
   */
  release: () => boolean;
};

export type AcquireCycleLockResult =
  | { ok: true; handle: CycleLockHandle }
  | { ok: false; reason: string };

export type AcquireCycleLockOptions = {
  /** 解放時の所有者照合に使う識別子。board は 1 回の書き込みごとに一意な値を渡す。 */
  sessionId: string;
  /** テスト用の時刻注入。省略時は現在時刻。 */
  now?: Date;
};

/**
 * `<workspace>/.flywheel/cycle.lock` を取得する。既にロックが存在する場合は
 * **一切削除・回収せず**取得を諦める（上記の縮退。理由文字列を返す）。
 */
export function acquireCycleLock(
  workspacePath: string,
  options: AcquireCycleLockOptions,
): AcquireCycleLockResult {
  const lockPath = cycleLockPathFor(workspacePath);

  // 親ディレクトリだけは事前に確保する（ロック本体に recursive を使わないため、
  // 親が無いと mkdir が ENOENT で失敗し「並走」と誤読される）。
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason: `ロックディレクトリの親（${path.dirname(lockPath)}）を用意できませんでした: ${toMessage(error)}`,
    };
  }

  try {
    // recursive を付けない＝既存なら EEXIST で失敗する原子的操作（上流と同一）。
    fs.mkdirSync(lockPath);
  } catch (error) {
    return {
      ok: false,
      reason: describeExistingLock(lockPath, error, options.now ?? new Date()),
    };
  }

  // メタデータが書けないままロックだけ残ると、以後の acquire（board も run-cycle も）が
  // 最長 2 時間ブロックされるため、失敗時はロックを解除して中止する（上流 exit 4 相当）。
  try {
    writeOwnerMeta(lockPath, options.sessionId, options.now ?? new Date());
  } catch (error) {
    removeLock(lockPath);
    return {
      ok: false,
      reason: `所有者メタデータの書き込みに失敗したためロックを解除して中止しました: ${toMessage(error)}`,
    };
  }

  return {
    ok: true,
    handle: {
      release: () => releaseCycleLock(workspacePath, options.sessionId),
    },
  };
}

/**
 * ロックを解放する。所有者一致（記録済み `session_id` 一致、または pid 一致）の
 * ときだけ削除し、不一致なら**削除せず** false を返す（上流 `do_release` と同一）。
 */
export function releaseCycleLock(
  workspacePath: string,
  sessionId: string,
): boolean {
  const lockPath = cycleLockPathFor(workspacePath);
  if (!fs.existsSync(lockPath)) {
    return true;
  }
  const meta = readOwnerMeta(lockPath);
  const recordedSessionId = meta ? metaGet(meta, "session_id") : undefined;
  const recordedPid = meta ? metaGet(meta, "pid") : undefined;

  if (recordedSessionId !== undefined && recordedSessionId === sessionId) {
    removeLock(lockPath);
    return true;
  }
  if (recordedPid !== undefined && recordedPid === String(process.pid)) {
    removeLock(lockPath);
    return true;
  }
  return false;
}

function writeOwnerMeta(lockPath: string, sessionId: string, now: Date): void {
  const pid = process.pid;
  const lines = [
    `pid=${pid}`,
    `pid_start=${pidStartTime(pid)}`,
    `session_id=${sessionId}`,
    `acquired_at=${isoNow(now)}`,
    "",
  ];
  fs.writeFileSync(path.join(lockPath, OWNER_FILE_NAME), lines.join("\n"));
}

function removeLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // 解除に失敗しても呼び出し元にできることは無い（次サイクルの回収に委ねる）。
  }
}

/**
 * 取得に失敗した理由を、既存ロックの所有者メタデータから人間向けに説明する。
 * **判定結果によらず board はロックを削除しない**——この関数は文言の出し分け専用。
 */
function describeExistingLock(
  lockPath: string,
  error: unknown,
  now: Date,
): string {
  if (!isEexist(error)) {
    return `ロックの取得に失敗しました: ${toMessage(error)}`;
  }

  const meta = readOwnerMeta(lockPath);
  const recordedPid = meta ? metaGet(meta, "pid") : undefined;
  const recordedStart = meta ? metaGet(meta, "pid_start") : undefined;

  if (recordedPid && recordedStart) {
    const currentStart = pidStartTime(Number(recordedPid));
    if (currentStart !== "" && currentStart === recordedStart) {
      return `このエージェントで run-cycle が実行中です（cycle.lock の保持者 PID=${recordedPid} が生存中）。サイクルの完了を待ってから再試行してください`;
    }
    return `cycle.lock が残っていますが保持者（PID=${recordedPid}）は生存していません。board はロックの残骸回収を行わない（回収は runs.jsonl への abandoned 代筆を伴い NFR-01 の対象になる）ため、次の run-cycle が回収するのを待つか、手動で ${lockPath} を削除してください`;
  }

  const ageMs = now.getTime() - lockMtimeMs(lockPath, now);
  if (ageMs > STALE_LOCK_THRESHOLD_MS) {
    return `cycle.lock の所有者を特定できず、更新から 2 時間以上経過しています（残骸の可能性）。board は残骸回収を行わないため、次の run-cycle が回収するのを待つか、手動で ${lockPath} を削除してください`;
  }
  return "cycle.lock の所有者を特定できませんが、更新から 2 時間以内のため並走中とみなします。サイクルの完了を待ってから再試行してください";
}

/**
 * ロックの mtime（epoch ミリ秒）。取得できなければ現在時刻を返す——上流と同じく
 * 「取得不能時は更新直後とみなす」安全側に倒す（0 を返すと経過が巨大値になり、
 * 稼働中のロックを残骸と説明してしまう）。
 */
function lockMtimeMs(lockPath: string, now: Date): number {
  try {
    return fs.statSync(lockPath).mtimeMs;
  } catch {
    return now.getTime();
  }
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
