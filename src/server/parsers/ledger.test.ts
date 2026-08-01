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

  it("valid.md の C-001 は 説明・完了条件（前方一致: 完了条件（任意・分かれば））・タスク案 を抽出する", () => {
    const content = readFixture("valid.md");

    const result = parseLedger(content, "valid.md");

    const c001 = result.challenges.find((c) => c.id === "C-001");
    expect(c001?.description).toBe("環境変数でパスを上書きしたい");
    expect(c001?.completionCriteria).toBe("環境変数でパスを指定できる");
    expect(c001?.taskPlan).toBe("1. resolveFleetManifestPath を実装する");
  });

  it("valid.md の C-002 は 完了条件 系フィールドが無いため completionCriteria が undefined になる（説明・タスク案は抽出される）", () => {
    const content = readFixture("valid.md");

    const result = parseLedger(content, "valid.md");

    const c002 = result.challenges.find((c) => c.id === "C-002");
    expect(c002?.description).toBe(
      "テンプレのフェンス内記入例を誤検出しないようにしたい",
    );
    expect(c002?.completionCriteria).toBeUndefined();
    expect(c002?.taskPlan).toBe("1. フェンス検出ロジックを追加する");
  });

  it("完了条件（任意） のように括弧内の注記が異なる前方一致ラベルも completionCriteria として抽出する", () => {
    const content = [
      "### [C-200] 前方一致の別表記テスト",
      "",
      "**人間記入欄**",
      "- 説明: 前方一致の別表記を確認する",
      "- 完了条件（任意）: 別の注記でも一致すること",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "- タスク案: 1. 前方一致を確認する",
      "",
    ].join("\n");

    const result = parseLedger(content, "prefix-match.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges[0]?.completionCriteria).toBe(
      "別の注記でも一致すること",
    );
  });

  it("説明・タスク案は完全一致のみで抽出する（前方一致させない）: 括弧付きラベルは対応するフィールドに一致しない", () => {
    const content = [
      "### [C-202] 完全一致の否定テスト",
      "",
      "**人間記入欄**",
      "- 説明（任意）: 完全一致ではないので description に入らないはず",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "- タスク案（案）: 完全一致ではないので taskPlan に入らないはず",
      "",
    ].join("\n");

    const result = parseLedger(content, "exact-match-only.md");

    expect(result.errors).toEqual([]);
    const c202 = result.challenges[0];
    expect(c202?.description).toBeUndefined();
    expect(c202?.taskPlan).toBeUndefined();
  });

  it("完了条件系ラベルが複数あり最初の一致が空値の場合、値を持つ後続の一致を completionCriteria として採用する", () => {
    const content = [
      "### [C-203] 前方一致タイブレークのテスト",
      "",
      "**人間記入欄**",
      "- 完了条件（任意）: ",
      "- 完了条件（任意・分かれば）: 後から追記された値",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
    ].join("\n");

    const result = parseLedger(content, "prefix-tiebreak.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges[0]?.completionCriteria).toBe("後から追記された値");
  });

  it("説明・完了条件・タスク案がすべて無いエントリはエラーにならず、3フィールドとも undefined になる", () => {
    const content = [
      "### [C-201] フィールド無しのテスト",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
    ].join("\n");

    const result = parseLedger(content, "no-content-fields.md");

    expect(result.errors).toEqual([]);
    const c201 = result.challenges[0];
    expect(c201?.description).toBeUndefined();
    expect(c201?.completionCriteria).toBeUndefined();
    expect(c201?.taskPlan).toBeUndefined();
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

  function minimalEntry(idRaw: string): string {
    return [
      `### [${idRaw}] 階層IDのテスト`,
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
    ].join("\n");
  }

  it("階層課題ID（C-002-4 のような枝番付き）を valid として受理する", () => {
    const content = minimalEntry("C-002-4");

    const result = parseLedger(content, "hierarchical.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]?.id).toBe("C-002-4");
  });

  it('id が "C-" のみ（数字なし）の場合は引き続き ParseError になる', () => {
    const content = minimalEntry("C-");

    const result = parseLedger(content, "invalid-id.md");

    expect(result.challenges).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/id が不正です/);
  });

  it('id が "C-a"（数字以外を含む）の場合は引き続き ParseError になる', () => {
    const content = minimalEntry("C-a");

    const result = parseLedger(content, "invalid-id.md");

    expect(result.challenges).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/id が不正です/);
  });

  it("4連バッククォートのフェンス内にある3連バッククォート＋見出し行を課題として誤検出しない（フェンスの記号・長さ一致判定）", () => {
    const content = [
      "# 課題台帳",
      "",
      "````",
      "```",
      "### [C-999] フェンス内で誤検出されてはいけない見出し",
      "```",
      "````",
      "",
      "### [C-100] フェンスの外にある実データ",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
    ].join("\n");

    const result = parseLedger(content, "nested-fence.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]?.id).toBe("C-100");
  });

  it("html-comment.md の HTML コメントで囲まれた記入例はエントリとして解釈されず、コメント後の実エントリのみを返す", () => {
    const content = readFixture("html-comment.md");

    const result = parseLedger(content, "html-comment.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]?.id).toBe("C-100");
  });

  it("html-comment.md のフィールド行末尾インラインコメント（優先度の <!-- fp:... -->）は従来どおり値に含めてパースされる", () => {
    const content = readFixture("html-comment.md");

    const result = parseLedger(content, "html-comment.md");

    expect(result.challenges[0]?.priority).toBe("P1 <!-- fp:31284b3668e8 -->");
  });

  it("複数行にまたがる HTML コメント（<!-- の行から --> の行まで）はすべてスキップし、前後のエントリは正しくパースされる", () => {
    const content = [
      "### [C-050] コメント前のエントリ",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
      "<!-- ここからコメント",
      "### [C-999] コメント内なので無視されるべき",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "-->",
      "",
      "### [C-100] コメント後のエントリ",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
    ].join("\n");

    const result = parseLedger(content, "multi-line-comment.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges.map((c) => c.id)).toEqual(["C-050", "C-100"]);
  });

  it("フェンス内に現れる <!-- はコメント開始として扱わない（フェンス優先）", () => {
    const content = [
      "# 課題台帳",
      "",
      "```",
      "<!-- フェンス内なのでコメント開始として扱われないはず（閉じの --> は無い）",
      "```",
      "",
      "### [C-100] フェンスの外にある実データ",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
    ].join("\n");

    const result = parseLedger(content, "fence-with-html-comment.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]?.id).toBe("C-100");
  });

  it("コメント内に現れる ``` はフェンス開始として扱わない（コメント優先）", () => {
    const content = [
      "<!-- コメント開始",
      "```",
      "コメント中の ``` はフェンスとして扱われないはず",
      "-->",
      "",
      "### [C-100] コメント終了後の実データ",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
    ].join("\n");

    const result = parseLedger(content, "comment-with-fence.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]?.id).toBe("C-100");
  });

  it("~~~ フェンスも同条件（同じ記号かつ開始以上の長さ）で閉じ判定する", () => {
    const content = [
      "# 課題台帳",
      "",
      "~~~~",
      "~~~",
      "### [C-888] フェンス内で誤検出されてはいけない見出し",
      "~~~",
      "~~~~",
      "",
      "### [C-100] フェンスの外にある実データ",
      "",
      "**分類欄（エージェントが記入）**",
      "- ステータス: 未分類",
      "",
    ].join("\n");

    const result = parseLedger(content, "nested-tilde-fence.md");

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
