// 作業ログ（カード詳細モーダル）のタイムスタンプ表示整形（Issue #152）。
//
// データ層（キャッシュ・API レスポンス）の `ts` は正本ファイルの値を無加工で
// 保持する（設計原則: 正本はファイル・board は消費者）。整形は表示だけの責務
// なのでこのモジュールに閉じ、呼び出し側は元の `ts` を title 属性等で
// 併せて残す（調査時に完全なタイムスタンプへ到達できるようにするため）。
//
// 入力の ts は 2 系統ある:
//   - journal 由来: "YYYY-MM-DD"（日付のみ。deriveLogEntries が entry.date を使う）
//   - runs.jsonl 由来: フル ISO 8601（オフセット付き。例 2026-08-14T09:05:27+09:00）
// 前者は時刻を持たないため、"00:00" を捏造せず日付のみのまま返す。

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * ログ行のタイムスタンプを分精度の短い形式（例: "2026-08-14 09:05"）へ整形する。
 * 日付のみの ts はそのまま、パースできない ts も加工せずそのまま返す
 * （board は独自解釈を持ち込まない。NFR-05）。
 *
 * タイムゾーンは board を動かしているマシンのローカル（fleet は単一マシン運用が
 * 前提。logEntrySortKey がローカル基準でソートしているのと同じ立場）。
 */
export function formatLogTimestamp(ts: string): string {
  if (DATE_ONLY_PATTERN.test(ts)) {
    return ts;
  }
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) {
    return ts;
  }
  const date = new Date(parsed);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
