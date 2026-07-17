// board から埋め込みターミナルへ流し込む指示文の生成（純粋関数）。
//
// クリティカル設計決定（親 #2 / #16）: board は台帳を書かない（NFR-01）。
// D&D 並べ替え・「＋差し込み」ゴーストの結果は、ここで生成した指示文を
// terminal-control.ts の prefill() で該当タブに流し込むだけに留める。
// 実際の台帳更新は人間が Enter を押した後、ターミナル内のエージェントが行う。

export type AdjacentChallenge = {
  id: string;
  priority?: string;
};

function priorityLabel(
  adjacent: AdjacentChallenge,
  suffixWhenSpecified: string,
): string {
  return adjacent.priority
    ? `${adjacent.priority} ${suffixWhenSpecified}`
    : "適切な優先度で";
}

/**
 * 既存カードの D&D 並べ替え（FR-09）向けの指示文を生成する。
 *
 * @param challengeId 並べ替え対象の課題ID
 * @param targetChallenge ドロップ先の直下に来る隣接カード（先頭への移動等、
 *   隣接カードが存在しない場合は undefined）
 */
export function buildReorderInstruction(
  challengeId: string,
  targetChallenge: AdjacentChallenge | undefined,
): string {
  if (!targetChallenge) {
    return `課題 ${challengeId} の優先度を最上位に変更してください`;
  }
  return `課題 ${challengeId} の優先度を ${targetChallenge.id} より上（${priorityLabel(targetChallenge, "以上")}）に変更してください`;
}

/**
 * 「＋差し込み」ゴーストカードの確定（FR-13）向けの指示文を生成する。
 *
 * @param content ゴーストカードに入力された課題内容
 * @param targetChallenge ドロップ先の直下に来る隣接カード（隣接カードが
 *   存在しない場合＝最優先位置は undefined）
 */
export function buildInsertInstruction(
  content: string,
  targetChallenge: AdjacentChallenge | undefined,
): string {
  if (!targetChallenge) {
    return `差し込み: 「${content}」を課題台帳に追加してください。優先度は最上位でお願いします`;
  }
  return `差し込み: 「${content}」を課題台帳に追加してください。優先度は ${targetChallenge.id} より上（${priorityLabel(targetChallenge, "相当")}）でお願いします`;
}
