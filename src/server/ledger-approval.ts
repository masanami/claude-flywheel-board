import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireCycleLock } from "./cycle-lock.ts";
import type { ApprovalKind, Challenge } from "./parsers/ledger.ts";
import { APPROVAL_REQUIRED_STATUS, parseLedger } from "./parsers/ledger.ts";
import type { ParseError } from "./parsers/types.ts";

/**
 * 承認チェック（FR-13 / FR-32）を board から台帳へ書き込む（FR-20 / NFR-01 区分②）。
 *
 * **書くのはチェックボックス 1 行の `[ ]` → `[x]` だけ**。ステータス行・分類欄の
 * 他フィールド・journal・memory・runs.jsonl には一切触れない（NFR-01 区分③）。
 * ステータスの前進（`計画承認待ち → 着手中` / `完了確認待ち → 完了`）は規定どおり
 * エージェントが次サイクルで代行する。
 *
 * **書いたら人間の git identity でコミットするところまでで 1 単位**。claude-flywheel の
 * 承認の真正性規定（`docs/challenge-ledger-format.md` §承認プロトコル「真正性」経路 1 /
 * `skills/run-cycle/SKILL.md` 手順1「承認の真正性」）は「チェックの `[x]` への変更が
 * **人間のコミットで入っている**こと」を有効な承認の条件としており、ファイルを書いた
 * だけでコミットしない実装では `git log` の author 確認を満たさず、**エージェントは
 * それを承認として検出しない**（作業ツリーが汚れるだけで前進しない）。
 *
 * 逆に言えば、コミットまで行えばエージェントから見て board 経由の承認は「人間が
 * GitHub 上でチェックを入れた」のと区別がつかない。これが claude-flywheel 側に
 * 本機能のための変更が要らない理由である（requirements.md §8）。
 */

/** 承認の書き込みが安全に行える最大ファイルサイズ（バイト）。異常に巨大な台帳の全読み込みを避ける。 */
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

/** git サブコマンドのタイムアウト（ミリ秒）。遅い共有マウント等で API が返らなくなるのを防ぐ。 */
const GIT_TIMEOUT_MS = 30_000;

/** git サブコマンドの出力バッファ上限（異常出力での無制限バッファリング防止）。 */
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

export type ApproveChallengeInput = {
  /** エージェントのワークスペースルート（fleet entry の path）。 */
  workspacePath: string;
  /** 台帳ファイルの絶対パス（`<workspace>/challenge-ledger.md`）。 */
  ledgerPath: string;
  /** 対象課題 ID（例: `C-072`）。 */
  challengeId: string;
  /** 承認種別。 */
  kind: ApprovalKind;
};

export type ApproveChallengeResult =
  | { ok: true; commit: string; challenge: Challenge }
  /**
   * `status` は HTTP のステータスコードにそのまま使う。
   * 409 = 前提条件の不成立（並走ロック・ステータス不一致・既に承認済み）、
   * 404 = 対象が見つからない、400 = 入力不正、500 = 環境・I/O 側の失敗。
   */
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/** 承認種別ごとのコミットメッセージ（agent workspace 側の慣習に合わせた Conventional Commits）。 */
function commitMessageFor(challengeId: string, kind: ApprovalKind): string {
  const label = kind === "plan" ? "計画を承認（FR-13）" : "完了を承認（FR-32）";
  return `chore: ${challengeId} の${label}`;
}

/**
 * 書き込み前後の台帳が**契約上同じもの**であることを検証する（NFR-01 区分③の防波堤）。
 *
 * 「対象チェックボックス 1 個が `[ ]` → `[x]` になった」以外の差分が生じていないことを、
 * 再パース結果の突き合わせで確認する。行単位の置換であっても、置換対象の行番号を
 * 取り違えていれば別エントリの承認を立てたり、エントリを壊してパースエラーへ落としたり
 * しうる——それを**書き込んだ結果から**検出するのがこの関数の役目であり、
 * 検証に落ちた場合は呼び出し元が書き込み前の内容へ戻す。
 */
export function verifyApprovalRewrite(
  before: { challenges: Challenge[]; errors: ParseError[] },
  after: { challenges: Challenge[]; errors: ParseError[] },
  challengeId: string,
  kind: ApprovalKind,
): string | null {
  if (after.errors.length !== before.errors.length) {
    return `書き込み後の台帳でパースエラー件数が変化しました（${before.errors.length} → ${after.errors.length}）`;
  }
  if (after.challenges.length !== before.challenges.length) {
    return `書き込み後の台帳でエントリ数が変化しました（${before.challenges.length} → ${after.challenges.length}）`;
  }

  for (const [index, beforeEntry] of before.challenges.entries()) {
    const afterEntry = after.challenges[index];
    if (afterEntry === undefined) {
      return `書き込み後の台帳でエントリ ${beforeEntry.id} が失われました`;
    }
    if (afterEntry.id !== beforeEntry.id) {
      return `書き込み後の台帳でエントリの並びが変化しました（${beforeEntry.id} → ${afterEntry.id}）`;
    }
    if (afterEntry.status !== beforeEntry.status) {
      return `書き込み後の台帳で ${beforeEntry.id} のステータスが変化しました（${beforeEntry.status} → ${afterEntry.status}）。board はステータス行を書かない（NFR-01 区分③）`;
    }
    for (const checkKind of ["plan", "completion"] as const) {
      const wasChecked = beforeEntry.approvals?.[checkKind]?.checked ?? false;
      const isChecked = afterEntry.approvals?.[checkKind]?.checked ?? false;
      const isTarget = beforeEntry.id === challengeId && checkKind === kind;
      if (isTarget) {
        if (!isChecked) {
          return `対象の承認チェック（${challengeId} / ${checkKind}）が書き込み後も未承認のままです`;
        }
        continue;
      }
      if (wasChecked !== isChecked) {
        return `対象外の承認チェック（${afterEntry.id} / ${checkKind}）が変化しました`;
      }
    }
  }
  return null;
}

/**
 * 承認チェックを 1 件書き込み、人間の git identity でコミットする。
 *
 * 排他: `<workspace>/.flywheel/cycle.lock` を取得している間だけ書き込む。ロックを
 * 取れなければ何もせず 409 を返す（run-cycle と台帳を同時に書かないため）。
 */
export function approveChallenge(
  input: ApproveChallengeInput,
): ApproveChallengeResult {
  const { workspacePath, ledgerPath, challengeId, kind } = input;

  // board の書き込み 1 回ごとに一意な所有者識別子。上流 cycle-lock.sh の
  // `--session-id` と同じ位置づけで、解放時の所有者照合に使う。
  const lockSessionId = `board-approval-${process.pid}-${Date.now()}`;
  const lock = acquireCycleLock(workspacePath, { sessionId: lockSessionId });
  if (!lock.ok) {
    return { ok: false, status: 409, error: lock.reason };
  }

  try {
    return writeApprovalUnderLock(ledgerPath, workspacePath, challengeId, kind);
  } finally {
    lock.handle.release();
  }
}

function writeApprovalUnderLock(
  ledgerPath: string,
  workspacePath: string,
  challengeId: string,
  kind: ApprovalKind,
): ApproveChallengeResult {
  let original: string;
  try {
    const stat = fs.statSync(ledgerPath);
    if (stat.size > MAX_LEDGER_BYTES) {
      return {
        ok: false,
        status: 500,
        error: `台帳が大きすぎて安全に書き込めません（${stat.size} バイト）: ${ledgerPath}`,
      };
    }
    original = fs.readFileSync(ledgerPath, "utf-8");
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `台帳の読み込みに失敗しました: ${toMessage(error)}`,
    };
  }

  const before = parseLedger(original, ledgerPath);
  const target = before.challenges.find((c) => c.id === challengeId);
  if (target === undefined) {
    return {
      ok: false,
      status: 404,
      error: `課題 ${challengeId} が台帳に見つかりません（パースエラーで落ちている可能性もあります）: ${ledgerPath}`,
    };
  }

  const requiredStatus = APPROVAL_REQUIRED_STATUS[kind];
  if (target.status !== requiredStatus) {
    return {
      ok: false,
      status: 409,
      error: `課題 ${challengeId} のステータスは「${target.status}」であり、この承認は「${requiredStatus}」のときのみ意味を持ちます（規定 §承認プロトコルのステータス前提）`,
    };
  }

  const checkbox = target.approvals?.[kind];
  if (checkbox === undefined) {
    return {
      ok: false,
      status: 409,
      error: `課題 ${challengeId} に対応する承認チェックボックス行が台帳にありません。board は人間の欄を捏造しないため、行の追加はエージェント（run-cycle の台帳正規化）に委ねます`,
    };
  }
  if (checkbox.checked) {
    return {
      ok: false,
      status: 409,
      error: `課題 ${challengeId} は既に承認済みです（${checkbox.label}）`,
    };
  }

  // 対象は「パーサが同定した 1 行」だけ。行全体を組み立て直さず、その行の中の
  // 最初の `[ ]` を `[x]` へ置き換える（ラベル・インデント・行末を保存する）。
  const lines = original.split("\n");
  const index = checkbox.line - 1;
  const targetLine = lines[index];
  if (targetLine === undefined || !targetLine.includes("[ ]")) {
    return {
      ok: false,
      status: 500,
      error: `承認チェックボックス行（${checkbox.line} 行目）を特定できませんでした。台帳が読み込み後に変更された可能性があります`,
    };
  }
  lines[index] = targetLine.replace("[ ]", "[x]");
  const updated = lines.join("\n");

  const after = parseLedger(updated, ledgerPath);
  const violation = verifyApprovalRewrite(before, after, challengeId, kind);
  if (violation) {
    return {
      ok: false,
      status: 500,
      error: `フォーマット契約の検証に失敗したため書き込みを中止しました: ${violation}`,
    };
  }

  try {
    fs.writeFileSync(ledgerPath, updated);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `台帳の書き込みに失敗しました: ${toMessage(error)}`,
    };
  }

  const commitResult = commitLedger(
    workspacePath,
    ledgerPath,
    challengeId,
    kind,
  );
  if (!commitResult.ok) {
    // コミットできなかった `[x]` は承認として成立しない（真正性の経路 1 を満たさない）。
    // 作業ツリーに未コミットの `[x]` を残すと、利用者からは承認できたように見えて
    // エージェントは前進しないという最悪の食い違いになるため、必ず書き戻す。
    restore(ledgerPath, original);
    return commitResult;
  }

  const approvedEntry = after.challenges.find((c) => c.id === challengeId);
  return {
    ok: true,
    commit: commitResult.commit,
    // 直前の find で同定済みのエントリ（verifyApprovalRewrite が同一性を保証済み）。
    challenge: approvedEntry ?? target,
  };
}

function restore(ledgerPath: string, original: string): void {
  try {
    fs.writeFileSync(ledgerPath, original);
  } catch {
    // 書き戻しにも失敗した場合、呼び出し元にできることは無い。エラー応答に
    // コミット失敗の事実は載るため、利用者は作業ツリーを自分で確認できる。
  }
}

/**
 * 台帳 1 ファイルだけをコミットする。
 *
 * - **author は上書きしない**。board は人間の手元で動くため、リポジトリ／グローバルの
 *   `user.name` / `user.email` がそのまま人間の identity になる。これが承認の真正性
 *   （経路 1: 人間のコミット）を満たす唯一の要件である。
 * - **`GIT_AUTHOR_*` / `GIT_COMMITTER_*` を子プロセスから外す**。board を Claude Code
 *   セッションのシェルから起動した場合、これらが継承されて author が人間以外に
 *   化けうる。config へフォールバックさせることで identity を人間に固定する。
 * - **pathspec 付き commit** にして、台帳以外の未コミット変更（エージェントが作業中の
 *   journal 等）を巻き込まない。
 */
function commitLedger(
  workspacePath: string,
  ledgerPath: string,
  challengeId: string,
  kind: ApprovalKind,
): { ok: true; commit: string } | { ok: false; status: 500; error: string } {
  const relativeLedger = path.relative(workspacePath, ledgerPath);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_AUTHOR_") || key.startsWith("GIT_COMMITTER_")) {
      delete env[key];
    }
  }

  const run = (args: string[]): string =>
    execFileSync("git", ["-C", workspacePath, ...args], {
      encoding: "utf-8",
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  // identity が未設定だと commit 自体が失敗する。先に確認して、原因が分かる
  // メッセージを返す（承認は人間の identity でコミットされて初めて成立するため、
  // ここを曖昧なまま進めない）。
  let identity: string;
  try {
    identity = `${run(["config", "user.name"])} <${run(["config", "user.email"])}>`;
  } catch {
    return {
      ok: false,
      status: 500,
      error: `${workspacePath} に git の user.name / user.email が設定されていないためコミットできません。承認は人間の identity のコミットとして記録される必要があります（承認の真正性・経路 1）`,
    };
  }

  try {
    run([
      "commit",
      "-m",
      commitMessageFor(challengeId, kind),
      "--",
      relativeLedger,
    ]);
    return { ok: true, commit: run(["rev-parse", "HEAD"]) };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: `台帳のコミットに失敗しました（identity: ${identity}）。書き込みは取り消しました: ${toMessage(error)}`,
    };
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    // execFileSync のエラーは stderr に原因が出る（message は "Command failed" のみ）。
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const detail = stderr ? String(stderr).trim() : "";
    return detail === "" ? error.message : `${error.message}: ${detail}`;
  }
  return String(error);
}
