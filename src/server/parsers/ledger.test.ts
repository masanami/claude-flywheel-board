import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLedger, parseLedgerFile } from "./ledger.ts";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../../../tests/fixtures/ledger/", import.meta.url),
);

function readFixture(name: string): string {
  return fs.readFileSync(`${FIXTURES_ROOT}${name}`, "utf-8");
}

describe("parseLedger", () => {
  it("空文字列を渡すとエラーなし・エントリなしを返す", () => {
    const result = parseLedger("", "challenge-ledger.md");

    expect(result).toEqual({ challenges: [], errors: [] });
  });

  it("valid.md の3件すべてを challenges として返し、errors は空", () => {
    const content = readFixture("valid.md");

    const result = parseLedger(content, "valid.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges).toHaveLength(3);
    expect(result.challenges.map((c) => c.id)).toEqual([
      "C-001",
      "C-002",
      "C-003",
    ]);
  });

  it("valid.md の 計画承認待ち / 完了確認待ち エントリは needsHuman: true", () => {
    const content = readFixture("valid.md");

    const result = parseLedger(content, "valid.md");

    const c001 = result.challenges.find((c) => c.id === "C-001");
    const c003 = result.challenges.find((c) => c.id === "C-003");
    expect(c001?.needsHuman).toBe(true);
    expect(c003?.needsHuman).toBe(true);
  });

  it("valid.md の 着手中 エントリ（C-002）は needsHuman: false", () => {
    const content = readFixture("valid.md");

    const result = parseLedger(content, "valid.md");

    const c002 = result.challenges.find((c) => c.id === "C-002");
    expect(c002?.needsHuman).toBe(false);
  });

  it("broken-mixed.md では正常な2件が challenges に残り、壊れた3件は errors に入る", () => {
    const content = readFixture("broken-mixed.md");

    const result = parseLedger(content, "broken-mixed.md");

    expect(result.challenges.map((c) => c.id)).toEqual(["C-020", "C-023"]);
    expect(result.errors).toHaveLength(3);
    for (const error of result.errors) {
      expect(error.file).toBe("broken-mixed.md");
      expect(typeof error.line).toBe("number");
      expect(error.raw.length).toBeGreaterThan(0);
    }
  });

  it("invalid-status.md の仕様外ステータス（レビュー中）は ParseError になる（challenges は空）", () => {
    const content = readFixture("invalid-status.md");

    const result = parseLedger(content, "invalid-status.md");

    expect(result.challenges).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/仕様外/);
    expect(result.errors[0]?.raw).toContain("C-010");
  });

  it("empty.md（実ファイル）を渡しても例外を投げず空の結果を返す", () => {
    const content = readFixture("empty.md");

    const result = parseLedger(content, "empty.md");

    expect(result).toEqual({ challenges: [], errors: [] });
  });

  it("template-with-fence.md はフェンス内の C-001 記入例を誤検出せず、フェンス外の C-100 のみを返す", () => {
    const content = readFixture("template-with-fence.md");

    const result = parseLedger(content, "template-with-fence.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]?.id).toBe("C-100");
  });
});

describe("parseLedgerFile", () => {
  it("実ファイルパスから読み込み、valid.md の3件を返す", () => {
    const result = parseLedgerFile(`${FIXTURES_ROOT}valid.md`);

    expect(result.errors).toEqual([]);
    expect(result.challenges.map((c) => c.id)).toEqual([
      "C-001",
      "C-002",
      "C-003",
    ]);
  });
});
