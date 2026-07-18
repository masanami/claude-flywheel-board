// 再開コマンドの prefill 連携（#31・FR-12）向けの純粋関数。
//
// クリティカル設計決定（親 Issue #28 / #2）: ここで組み立てるのは prefill する
// 「未実行の」コマンド文字列のみ。Enter 送信・自動実行の経路はここにも作らない
// （実際に流し込むのは呼び出し元が terminal-control.ts の prefill() を使う）。

import type { Run } from "../board-types.ts";

/**
 * stale な delegate 実行中セッションを再開するためのコマンド文字列を組み立てる。
 * `run.repo`（repos.tsv の name）と session_id から
 * `cd .flywheel/repos/<repo> && claude -p --resume <session_id>` を生成する。
 */
export function buildResumeCommand(repo: string, sessionId: string): string {
  return `cd .flywheel/repos/${repo} && claude -p --resume ${sessionId}`;
}

// repo（repos.tsv の name）向けの安全な文字集合。org/repo 形式（例:
// "org/service-a"）のようにディレクトリ区切りを含む正当な値がすでに使われて
// いるため "/" も許可する。英数字・ドット・アンダースコア・ハイフン・
// スラッシュ以外（シェルメタ文字 `;` `|` `&` `` ` `` `$` `(` `)` 、空白、
// 改行等）を含む場合は不正な値として扱う。
const SAFE_REPO_PATTERN = /^[A-Za-z0-9._/-]+$/;
// session_id（delegate_start の UUID 等）向けの安全な文字集合。repo と異なり
// パス区切りとしての "/" は許可しない。先頭は英数字必須（セルフレビュー指摘
// 対応: 先頭ハイフンを許すと `claude -p --resume <key>` に展開した際、<key> が
// `-x` のようなオプションフラグとして誤解釈される余地があるため）。
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * repo に ".." というパス区切りセグメントが含まれるか（パストラバーサル）。
 * セルフレビュー指摘対応: SAFE_REPO_PATTERN は org/repo 形式のため "/" と "."
 * を許可しているが、その組み合わせだけでは "../../etc" のような値も文字集合を
 * 通過してしまい、`cd .flywheel/repos/<repo>` の展開先が委譲先クローン配下から
 * 抜けられてしまう懸念が残る。プリフィルのみ・非実行（NFR-01）で実害は限定的
 * だが、「怪しいものは提示しない」方針を徹底するため、".." セグメントを
 * 個別に弾く。
 */
function hasPathTraversalSegment(repo: string): boolean {
  return repo.split("/").includes("..");
}

/**
 * run が「再開コマンドを提示してよい delegate 実行中 Run」かどうかを判定する。
 * 「kind が delegate」「stale」「repo が存在（truthy）」に加えて、`repo` /
 * `key`（session_id）が安全な文字集合から外れていないかを見る。
 *
 * resume コマンドは prefill のみで実行はしない（NFR-01・クリティカル設計
 * 決定）が、ユーザーが中身を精査せず Enter を押す可能性は排除できないため、
 * シェルメタ文字等を含む値はコマンド文字列をサニタイズするのではなく
 * 「そもそも再開ボタン自体を出さない」方針を取る（怪しいものは提示しない）。
 *
 * 課題の一致は呼び出し元の関心事（findStaleDelegateRun の責務）。
 * AgentColumn（run 単体を見る）・CardDetailModal（findStaleDelegateRun 経由）の
 * 両方から参照する共有述語として切り出し、判定基準を一元化する。
 */
export function isResumableDelegateRun(run: Run): boolean {
  return (
    run.kind === "delegate" &&
    run.stale &&
    Boolean(run.repo) &&
    SAFE_REPO_PATTERN.test(run.repo ?? "") &&
    !hasPathTraversalSegment(run.repo ?? "") &&
    SAFE_SESSION_ID_PATTERN.test(run.key)
  );
}

/**
 * 指定した課題（challengeId）に対応する、stale な delegate 実行中 Run を探す。
 * `isResumableDelegateRun` に加えて「challenge が一致」を満たす最初の run を返す。
 * 該当が無ければ undefined。
 */
export function findStaleDelegateRun(
  runs: Run[] | undefined,
  challengeId: string,
): Run | undefined {
  return runs?.find(
    (run) => isResumableDelegateRun(run) && run.challenge === challengeId,
  );
}
