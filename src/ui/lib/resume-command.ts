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

/**
 * run が「再開コマンドを提示してよい delegate 実行中 Run」かどうかを判定する。
 * 「kind が delegate」「stale」「repo が存在（truthy）」を満たすかどうかのみを見る
 * （課題の一致は呼び出し元の関心事＝ findStaleDelegateRun の責務）。
 * AgentColumn（run 単体を見る）・CardDetailModal（findStaleDelegateRun 経由）の
 * 両方から参照する共有述語として切り出し、判定基準を一元化する。
 */
export function isResumableDelegateRun(run: Run): boolean {
  return run.kind === "delegate" && run.stale && Boolean(run.repo);
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
