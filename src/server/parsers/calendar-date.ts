// 「YYYY-MM-DD が暦日として実在するか」の単一定義。
//
// 正本は claude-flywheel 側のフォーマット契約（`contracts/schemas/*.schema.json`）。
// journal/index.jsonl の `date` と runs.jsonl の `ts` は、どちらも
// **pattern（値域の形式）＋ format: date / date-time（暦日の意味検証）の二層**で
// 規定されている（`2026-02-31` のように「形は合うが暦日として存在しない」値を
// 拒否するため）。board 側でも同じ判定を 2 箇所（journal.ts / runs.ts）が必要と
// するため、規則を二重に書かないようここに単一定義する。
// 契約物の逐語コピーは tests/fixtures/contracts/ を参照（VENDORING.md）。

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD`（ゼロ埋め必須）かつ暦日として実在する日付なら true。
 * 閏年も考慮する（2028-02-29 は真・2026-02-29 は偽）。
 */
export function isExistingCalendarDate(value: string): boolean {
  const match = value.match(DATE_PATTERN);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC は 0〜99 の年を 1900+n として解釈する（`Date.UTC(26, …)` → 1926 年）。
  // そのままだと 0001〜0099 年の日付が往復検査に落ちて拒否されるが、上流契約の
  // `format: date` / `date-time` はこれらを受理する（board だけが厳しくなる＝
  // 契約を board 側で解釈し直すことになる）ため、元の年へ戻してから検査する。
  if (year < 100) {
    date.setUTCFullYear(year);
  }
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
