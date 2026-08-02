// 取得元（provenance）表示のラベル定義（Issue #101 / FR-A2・FR-A4）。
// RunProvenance.event（開始イベント種別）から、表示に使う「キーラベル」と
// 「対応する終了イベント名」を導出する。AgentColumn（実行中セクションの
// describeProvenance）と CardDetailModal（取得元セクションの終了イベント表示）
// の両方が同じ導出ロジックに依存していたため、二重実装を避けてここへ集約する
// （PRレビュー指摘対応）。
//
// Record<RunProvenance["event"], string> を採用する理由（CardDetailModal の
// 元コメントを移設）: 三項演算子で else 側を決め打ちにすると、
// RunProvenance["event"] のユニオンが将来拡張（例: cycle_start 追加。機能仕様
// のスコープ外節に将来拡張の言及あり）された際にコンパイルエラーにならず
// サイレントに誤った表示になりうる。Record<K, V> は全キー必須のため、
// ユニオン拡張時に「このキーが無い」という型エラーで気付ける。

import type { RunProvenance } from "../board-types.ts";

/** RunProvenance.key の意味を表す表示ラベル（delegate: session_id / adhoc: id）。 */
export const KEY_LABEL: Record<RunProvenance["event"], string> = {
  delegate_start: "session_id",
  adhoc_start: "id",
};

/** 開始イベント種別に対応する終了イベント名の表示ラベル。 */
export const END_EVENT_LABEL: Record<RunProvenance["event"], string> = {
  delegate_start: "delegate_end",
  adhoc_start: "adhoc_end",
};
