import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parsePriorityPolicy,
  parsePriorityPolicyFile,
} from "./priority-policy.ts";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../../../tests/fixtures/priority-policy/", import.meta.url),
);

const fixturePath = (name: string) => `${FIXTURES_ROOT}${name}`;

describe("parsePriorityPolicy", () => {
  it("空文字列を渡すと policy undefined・ParseError 1件（active 行が見つからない）を返す", () => {
    const result = parsePriorityPolicy("", "priority-policy.md");

    expect(result.policy).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe("priority-policy.md");
    expect(result.errors[0]?.message).toMatch(/active/);
  });

  it("```text フェンス内の active がモード定義の見出しトークンと完全一致する場合、status: defined を返す", () => {
    const content = `## 現在のモード

\`\`\`text
active: release-freeze
\`\`\`

## モード定義

### \`normal\`（既定）

- 省略。

### \`release-freeze\`（記入例）

- 省略。
`;

    const result = parsePriorityPolicy(content, "priority-policy.md");

    expect(result.errors).toEqual([]);
    expect(result.policy).toEqual({
      active: "release-freeze",
      status: "defined",
    });
  });

  it("全角括弧の説明部（見出し後方のテキスト）はマッチングに使わない", () => {
    const content = `## 現在のモード

\`\`\`text
active: release-freeze
\`\`\`

## モード定義

### \`release-freeze\`（記入例・本番安定最優先。長い説明文でも影響しない）

- 省略。
`;

    const result = parsePriorityPolicy(content, "priority-policy.md");

    expect(result.policy).toEqual({
      active: "release-freeze",
      status: "defined",
    });
  });

  it("active がどのモード定義の見出しトークンとも一致しない場合、status: undefined-mode を返し ParseError にはしない", () => {
    const content = `## 現在のモード

\`\`\`text
active: vacation
\`\`\`

## モード定義

### \`normal\`（既定）

- 省略。
`;

    const result = parsePriorityPolicy(content, "priority-policy.md");

    expect(result.errors).toEqual([]);
    expect(result.policy).toEqual({
      active: "vacation",
      status: "undefined-mode",
    });
  });

  it("`active:` 行が ```text フェンスの外にある場合は契約違反として ParseError にする（独自解釈で救済しない）", () => {
    const content = `## 現在のモード

active: normal

## モード定義

### \`normal\`（既定）

- 省略。
`;

    const result = parsePriorityPolicy(content, "priority-policy.md");

    expect(result.policy).toBeUndefined();
    expect(result.errors).toHaveLength(1);
  });

  it("モード定義の見出しは「## モード定義」配下のみを対象とする（それより前のバッククォート付き言及には反応しない）", () => {
    const content = `> 見出し行を \`### \\\`release-freeze\\\`\` の形式で追記してよい、という説明文。

## 現在のモード

\`\`\`text
active: release-freeze
\`\`\`

## モード定義

### \`normal\`（既定）

- 省略。
`;

    const result = parsePriorityPolicy(content, "priority-policy.md");

    // "## モード定義" 配下に release-freeze の見出しが実在しないため undefined-mode。
    expect(result.policy).toEqual({
      active: "release-freeze",
      status: "undefined-mode",
    });
  });

  it("「## 現在のモード」より前にある ```text フェンス（説明用の記入例等）には反応しない（セルフレビュー指摘対応: 先頭フェンス誤検出）", () => {
    const content = `> 記入例:
>
> \`\`\`text
> active: <mode名を記載する例>
> \`\`\`

## 現在のモード

\`\`\`text
active: release-freeze
\`\`\`

## モード定義

### \`release-freeze\`（記入例）

- 省略。
`;

    const result = parsePriorityPolicy(content, "priority-policy.md");

    expect(result.errors).toEqual([]);
    expect(result.policy).toEqual({
      active: "release-freeze",
      status: "defined",
    });
  });

  it("「## モード定義」より後続のセクション（例: 「## 運用メモ」）に紛れ込んだ見出し行はモード定義として拾わない（セルフレビュー指摘対応・2周目: 当初のテストは対象行が「###」で始まらず境界の有無で結果が変わらなかったため、実際に境界の有無で判定が変わる入力に差し替え）", () => {
    const content = `## 現在のモード

\`\`\`text
active: vacation
\`\`\`

## モード定義

### \`normal\`（既定）

- 省略。

## 運用メモ

### \`vacation\`（運用メモに紛れ込んだ見出し。モード定義ではない）

- 省略。
`;

    const result = parsePriorityPolicy(content, "priority-policy.md");

    // "## 運用メモ" 配下の `### \`vacation\`` は "## モード定義" セクションの
    // 境界外（次の "##" 見出しより後）のため定義として数えない。
    // セクション終端が未設定（旧実装）だと誤って defined になっていたケース。
    expect(result.policy).toEqual({
      active: "vacation",
      status: "undefined-mode",
    });
  });

  it("active: 行はあるが値が空の場合、「行が見つからない」ではなく「値が空」という区別可能なメッセージにする（セルフレビュー指摘対応）", () => {
    const content = `## 現在のモード

\`\`\`text
active:
\`\`\`

## モード定義

### \`normal\`（既定）

- 省略。
`;

    const result = parsePriorityPolicy(content, "priority-policy.md");

    expect(result.policy).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/値が空/);
  });
});

describe("parsePriorityPolicyFile", () => {
  it("defined-active.md（フィクスチャ）を読み込み、status: defined の policy を返す", () => {
    const result = parsePriorityPolicyFile(fixturePath("defined-active.md"));

    expect(result.errors).toEqual([]);
    expect(result.policy).toEqual({
      active: "release-freeze",
      status: "defined",
    });
  });

  it("undefined-mode-active.md（フィクスチャ）を読み込み、status: undefined-mode の policy を返す", () => {
    const result = parsePriorityPolicyFile(
      fixturePath("undefined-mode-active.md"),
    );

    expect(result.errors).toEqual([]);
    expect(result.policy).toEqual({
      active: "vacation",
      status: "undefined-mode",
    });
  });

  it("no-active-line.md（フィクスチャ）を読み込むと ParseError になる", () => {
    const result = parsePriorityPolicyFile(fixturePath("no-active-line.md"));

    expect(result.policy).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.file).toBe(fixturePath("no-active-line.md"));
  });

  it("ファイルが存在しない（ENOENT）場合はエラーを投げず、policy undefined・errors 空を返す（方針ファイルは任意・後方互換）", () => {
    const result = parsePriorityPolicyFile(fixturePath("does-not-exist.md"));

    expect(result.policy).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it("ENOENT 以外の読み込みエラー（例: ディレクトリをファイルとして開こうとした EISDIR）は ParseError として返す", () => {
    // fixtures/priority-policy 自体はディレクトリなので readFileSync すると EISDIR になる。
    const result = parsePriorityPolicyFile(FIXTURES_ROOT.replace(/\/$/, ""));

    expect(result.policy).toBeUndefined();
    expect(result.errors).toHaveLength(1);
  });
});
