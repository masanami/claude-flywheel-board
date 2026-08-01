// 課題台帳 join ヘルパー（Issue #94 / #96）。
//
// クリティカル設計決定（機能仕様 docs/features/task-provenance-ledger-join.md
// 「機能全体の設計 > アーキテクチャ決定」）: join は UI 側で実施する。
// AgentBoard には challenges / archivedChallenges / runningRuns が既に
// 同居しており、課題 ID による突き合わせはスナップショット受信済みデータの
// 参照だけで完結する（新規 API・新規導出ロジックは追加しない）。

import type { AgentBoard, Challenge } from "../board-types.ts";

/**
 * 課題 ID から台帳エントリを探す。`agent.challenges`（現行の台帳）を先に
 * 探索し、見つからなければ `agent.archivedChallenges`（アーカイブ台帳）へ
 * フォールバックする（FR-B3）。どちらにも見つからない場合は undefined を
 * 返す（呼び出し側が「台帳に見つかりません」を表示する。join 失敗でタスク行
 * 自体の表示は壊さない設計）。
 */
export function findChallengeById(
  agent: AgentBoard,
  id: string,
): Challenge | undefined {
  return (
    agent.challenges.find((challenge) => challenge.id === id) ??
    agent.archivedChallenges.find((challenge) => challenge.id === id)
  );
}
