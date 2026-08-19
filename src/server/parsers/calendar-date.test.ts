// 暦日の実在判定。判定の正本は上流契約の `format: date` / `format: date-time`
// （tests/fixtures/contracts/schemas/）で、board が独自に厳しく・緩くしないことを固定する。

import { describe, expect, it } from "vitest";
import { isExistingCalendarDate } from "./calendar-date.ts";

describe("isExistingCalendarDate", () => {
  it("実在する日付を受理する", () => {
    for (const value of ["2026-08-20", "2026-01-01", "2026-12-31"]) {
      expect(isExistingCalendarDate(value), value).toBe(true);
    }
  });

  it("閏年の 02-29 は受理し、非閏年の 02-29 は拒否する", () => {
    expect(isExistingCalendarDate("2028-02-29")).toBe(true);
    expect(isExistingCalendarDate("2000-02-29")).toBe(true);
    expect(isExistingCalendarDate("2026-02-29")).toBe(false);
    // 100 の倍数だが 400 の倍数ではない年は閏年ではない
    expect(isExistingCalendarDate("2100-02-29")).toBe(false);
  });

  it("形は合うが暦日として存在しない日付を拒否する", () => {
    for (const value of [
      "2026-02-31",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
    ]) {
      expect(isExistingCalendarDate(value), value).toBe(false);
    }
  });

  // Date.UTC は 0〜99 の年を 1900+n として解釈する。上流契約（format: date）は
  // これらの年を受理するため、board だけが拒否する状態にしない。
  it("0001〜0099 年も上流契約と同じく受理する", () => {
    for (const value of ["0001-01-01", "0026-08-14", "0099-12-31"]) {
      expect(isExistingCalendarDate(value), value).toBe(true);
    }
    expect(isExistingCalendarDate("0026-02-31")).toBe(false);
  });

  it("YYYY-MM-DD 以外の形は拒否する（ゼロ埋め必須・前後の余分を許さない）", () => {
    for (const value of [
      "2026-8-20",
      "26-08-20",
      "2026/08/20",
      "2026-08-20T00:00:00Z",
      " 2026-08-20",
      "",
    ]) {
      expect(isExistingCalendarDate(value), value).toBe(false);
    }
  });
});
