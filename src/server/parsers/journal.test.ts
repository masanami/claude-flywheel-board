import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveLogEntries, deriveSummary, parseJournal } from "./journal.ts";

const fixture = (name: string) =>
  fileURLToPath(
    new URL(`../../../tests/fixtures/journal/${name}`, import.meta.url),
  );

describe("parseJournal", () => {
  it("正常な journal ファイルを行数どおりにパースする", async () => {
    const { entries, errors } = await parseJournal(
      fixture("valid-index.jsonl"),
    );

    expect(errors).toEqual([]);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      date: "2026-07-01",
      seq: 1,
      touched_issues: [{ id: "C-002-4", from: "未着手", to: "着手中" }],
      delegations: [],
      pr_urls: [],
      pending_approvals: [],
      decisions: [],
    });
  });

  it("壊れた行を ParseError として積みつつ、正常な行は失わずにパースする", async () => {
    const { entries, errors } = await parseJournal(
      fixture("broken-index.jsonl"),
    );

    // 正常行（物理1行目・5行目）は失われない
    expect(entries).toHaveLength(2);
    expect(entries[0]?.date).toBe("2026-07-05");
    expect(entries[1]?.date).toBe("2026-07-07");

    // 壊れた行（物理2行目: JSON構文エラー、物理4行目: 必須フィールド不正、
    // 物理6行目: touched_issues 要素の必須フィールド欠落、物理7行目: touched_issues 要素が null）
    expect(errors).toHaveLength(4);

    expect(errors[0]?.line).toBe(2);
    expect(errors[0]?.file).toBe(fixture("broken-index.jsonl"));
    expect(errors[0]?.raw).toContain("C-010");
    expect(errors[0]?.message.length).toBeGreaterThan(0);

    expect(errors[1]?.line).toBe(4);
    expect(errors[1]?.raw).toContain('"seq":"1"');
    expect(errors[1]?.message.length).toBeGreaterThan(0);

    expect(errors[2]?.line).toBe(6);
    expect(errors[2]?.raw).toContain("C-020");
    expect(errors[2]?.message.length).toBeGreaterThan(0);

    expect(errors[3]?.line).toBe(7);
    expect(errors[3]?.raw).toContain("touched_issues");
    expect(errors[3]?.message.length).toBeGreaterThan(0);
  });

  it("課題への言及がないファイルも正常にパースできる", async () => {
    const { entries, errors } = await parseJournal(
      fixture("no-mentions-index.jsonl"),
    );

    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
  });

  it("date がゼロ埋めされていない形式（2026-7-2）は ParseError になる", async () => {
    const { entries, errors } = await parseJournal(
      fixture("invalid-date-index.jsonl"),
    );

    expect(entries).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.raw).toContain("2026-7-2");
    expect(errors[0]?.message).toMatch(/date/);
  });

  it("date がカレンダー上存在しない日付（2026-13-99）は ParseError になる", async () => {
    const { entries, errors } = await parseJournal(
      fixture("invalid-date-index.jsonl"),
    );

    expect(entries).toHaveLength(0);
    expect(errors[1]?.raw).toContain("2026-13-99");
    expect(errors[1]?.message).toMatch(/date/);
  });
});

describe("deriveLogEntries", () => {
  it("touched_issues と pending_approvals から該当課題の言及を抽出し date/seq 昇順で返す", async () => {
    const { entries } = await parseJournal(fixture("valid-index.jsonl"));

    const logEntries = deriveLogEntries(entries, "C-002-4");

    expect(logEntries).toEqual([
      { ts: "2026-07-01", source: "journal", text: "未着手 → 着手中" },
      { ts: "2026-07-02", source: "journal", text: "FR-13: 設計レビュー待ち" },
      { ts: "2026-07-03", source: "journal", text: "着手中 → 検証中" },
      { ts: "2026-07-03", source: "journal", text: "検証中 → 完了" },
    ]);
  });

  it("該当課題への言及がなければ空配列を返す", async () => {
    const { entries } = await parseJournal(fixture("no-mentions-index.jsonl"));

    expect(deriveLogEntries(entries, "C-999")).toEqual([]);
  });
});

describe("deriveSummary", () => {
  it("直近（最新）のログエントリの text を返す", async () => {
    const { entries } = await parseJournal(fixture("valid-index.jsonl"));

    expect(deriveSummary(entries, "C-002-4")).toBe("検証中 → 完了");
    expect(deriveSummary(entries, "C-010")).toBe("FR-20: 完了確認待ち");
  });

  it("該当課題への言及がなければ undefined を返す", async () => {
    const { entries } = await parseJournal(fixture("no-mentions-index.jsonl"));

    expect(deriveSummary(entries, "C-999")).toBeUndefined();
  });
});
