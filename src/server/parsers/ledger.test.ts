import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseLedger, parseLedgerFile } from "./ledger.ts";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../../../tests/fixtures/ledger/", import.meta.url),
);

const CONTRACT_LEDGER_ROOT = fileURLToPath(
  new URL(
    "../../../tests/fixtures/contracts/fixtures/ledger/",
    import.meta.url,
  ),
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

  // `人間対応待ち`（masanami/claude-flywheel#116 / 上流 docs/human-hold-representation.md 案 A）。
  // board が先に受理できないと、上流が書き始めた瞬間にそのエントリが ParseError へ回り
  // **カードごと board から消える**（承認導線ごと）。受理と needsHuman の両方を固定する。
  it("human-hold.md の 人間対応待ち エントリ（C-201）を errors なしで読む", () => {
    const content = readFixture("human-hold.md");

    const result = parseLedger(content, "human-hold.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges.map((c) => c.id)).toEqual(["C-201", "C-202"]);
    expect(result.challenges[0]?.status).toBe("人間対応待ち");
  });

  it("human-hold.md の 人間対応待ち エントリ（C-201）は needsHuman: true", () => {
    const content = readFixture("human-hold.md");

    const result = parseLedger(content, "human-hold.md");

    const c201 = result.challenges.find((c) => c.id === "C-201");
    const c202 = result.challenges.find((c) => c.id === "C-202");
    expect(c201?.needsHuman).toBe(true);
    expect(c202?.needsHuman).toBe(false);
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
    const content = readFixture("prefix-match.md");

    const result = parseLedger(content, "prefix-match.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges[0]?.completionCriteria).toBe(
      "別の注記でも一致すること",
    );
  });

  it("説明・タスク案は完全一致のみで抽出する（前方一致させない）: 括弧付きラベルは対応するフィールドに一致しない", () => {
    const content = readFixture("exact-match-only.md");

    const result = parseLedger(content, "exact-match-only.md");

    expect(result.errors).toEqual([]);
    const c202 = result.challenges[0];
    expect(c202?.description).toBeUndefined();
    expect(c202?.taskPlan).toBeUndefined();
  });

  it("完了条件系ラベルが複数あり最初の一致が空値の場合、値を持つ後続の一致を completionCriteria として採用する", () => {
    const content = readFixture("prefix-tiebreak.md");

    const result = parseLedger(content, "prefix-tiebreak.md");

    expect(result.errors).toEqual([]);
    expect(result.challenges[0]?.completionCriteria).toBe("後から追記された値");
  });

  it("説明・完了条件・タスク案がすべて無いエントリはエラーにならず、3フィールドとも undefined になる", () => {
    const content = readFixture("no-content-fields.md");

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

// 複数行フィールド（#151）と参照フィールド（#155）。フォーマットの正本は
// claude-flywheel `docs/challenge-ledger-format.md`（§複数行フィールドの記入形式 /
// §消費側（board 等）の読み取り規則 / §関連リポジトリ・関連Issue・関連PR）で、
// 入力は上流の契約フィクスチャの逐語コピー（tests/fixtures/contracts/VENDORING.md）。
describe("複数行フィールド・参照フィールド（#151 / #155）", () => {
  // 上流の contracts/fixtures/ledger/{valid,invalid}/ をそのまま写した vendoring 先
  // （tests/fixtures/contracts/VENDORING.md）。valid / invalid のどちらに置かれているかは
  // 上流の分類なので、名前から引けるようにここで吸収する。
  function readContractFixture(name: string): string {
    for (const kind of ["valid", "invalid"]) {
      const file = `${CONTRACT_LEDGER_ROOT}${kind}/${name}`;
      if (fs.existsSync(file)) {
        return fs.readFileSync(file, "utf-8");
      }
    }
    throw new Error(`契約フィクスチャが見つかりません: ${name}`);
  }

  function parseContractFixture(name: string) {
    return parseLedger(readContractFixture(name), name);
  }

  describe("受理方向: 上流の正例フィクスチャから値を取得できる", () => {
    it("形 A（複数行）の C-101 は タスク案・完了条件 をネスト項目の並びとして取得する", () => {
      const result = parseContractFixture("multiline-and-refs.md");

      expect(result.errors).toEqual([]);
      const c101 = result.challenges.find((c) => c.id === "C-101");
      expect(c101?.taskPlan).toBe(
        [
          "1. docs にフォーマットを規定する",
          "2. バリデータ・フィクスチャを同期する",
          "3. ready PR を作成する",
        ].join("\n"),
      );
      expect(c101?.completionCriteria).toBe(
        [
          "- 台帳フォーマットに複数行形式が規定されている",
          "- 既存の 1 行形式が受理され続ける",
        ].join("\n"),
      );
    });

    it("形 B（1 行）の C-102 は従来どおりフィールド行の値を取得する（後方互換）", () => {
      const result = parseContractFixture("multiline-and-refs.md");

      const c102 = result.challenges.find((c) => c.id === "C-102");
      expect(c102?.taskPlan).toBe(
        "(1) 調査する (2) 実装する (3) PR を作成する",
      );
      expect(c102?.completionCriteria).toBe(
        "既存台帳が一括書き換えなしで受理され続けること",
      );
    });

    it("形 C（空）の C-103 は タスク案・完了条件 とも undefined（未記入）になる", () => {
      const result = parseContractFixture("multiline-and-refs.md");

      const c103 = result.challenges.find((c) => c.id === "C-103");
      expect(c103?.taskPlan).toBeUndefined();
      expect(c103?.completionCriteria).toBeUndefined();
    });

    it("形 D（1 行値＋ネスト項目）の C-104 は値とネスト項目を連結して取得する", () => {
      const result = parseContractFixture("multiline-and-refs.md");

      const c104 = result.challenges.find((c) => c.id === "C-104");
      expect(c104?.taskPlan).toBe(
        [
          "段階的に移行する",
          "1. 先に規定を確定する",
          "2. 消費側の追随は別 Issue で行う",
        ].join("\n"),
      );
    });

    it("引用行（行頭 `>`）も継続行として説明に含める（ingest-challenges の原文引用）", () => {
      const result = parseContractFixture("handwritten-and-ingested.md");

      expect(result.errors).toEqual([]);
      const c002 = result.challenges.find((c) => c.id === "C-002");
      expect(c002?.description).toBe(
        [
          "（原文引用）",
          "> ## 背景",
          ">",
          "> 外部 Issue の本文をブロック引用で転記した複数行の説明。",
          "> 1. 番号付きリストを含む",
          "> 2. `- 備考:` のような行頭パターンも引用内では実フィールドではない",
        ].join("\n"),
      );
      // 引用ブロックの直後に来る通常のフィールド行は値に飲み込まれず、
      // 独立したフィールドとして読める（終端条件の確認）。
      expect(c002?.completionCriteria).toBe(
        "バリデータが本エントリを受理すること",
      );
      expect(c002?.taskPlan).toBe(["1. 調査する", "2. 実装する"].join("\n"));
    });

    it("さらに深い子項目（スペース4個）は相対的な階層を保ったまま値に含める", () => {
      const content = [
        "### [C-800] 深いネスト",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "- タスク案:",
        "  1. 親タスク",
        "    - 子の補足",
        "  2. 次の親タスク",
        "",
      ].join("\n");

      const result = parseLedger(content, "deep-nest.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges[0]?.taskPlan).toBe(
        ["1. 親タスク", "  - 子の補足", "2. 次の親タスク"].join("\n"),
      );
    });

    // 読み取り規則 4（承認チェックボックスはフィールド値ではない）は「`- 承認（人間が
    // チェック）:` の直下にネストされた専用構造」と**構造でスコープ**されている
    // （§承認プロトコル）。行の形（`- [ ] …`）だけで捨てると、完了条件・タスク案を
    // タスクリスト記法で書いたときに条件が黙って欠落する（PRレビュー指摘対応）。
    it("承認フィールド直下のチェックボックスはどのフィールド値にも混入しない（読み取り規則 4）", () => {
      const result = parseContractFixture("multiline-and-refs.md");

      const c101 = result.challenges.find((c) => c.id === "C-101");
      expect(c101?.taskPlan).not.toContain("計画を承認");
      expect(c101?.completionCriteria).not.toContain("完了を承認");
      // 承認フィールドの後ろに続くフィールドの値にも入らない。
      expect(c101?.status).toBe("着手中");
    });

    it("完了条件をタスクリスト記法で書いた場合はチェックボックス行も値として保持する", () => {
      const content = [
        "### [C-801] 完了条件をタスクリストで書く",
        "",
        "**人間記入欄**",
        "- 完了条件（任意）:",
        "  - 通常の条件",
        "  - [ ] チェック形式の条件",
        "  - もう一つの通常条件",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "",
      ].join("\n");

      const result = parseLedger(content, "checkbox-criteria.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges[0]?.completionCriteria).toBe(
        [
          "- 通常の条件",
          "- [ ] チェック形式の条件",
          "- もう一つの通常条件",
        ].join("\n"),
      );
    });

    // 継続行の収集は規定が複数行の値を定義しているフィールド（説明・完了条件・
    // タスク案）に限る。語彙・列挙で検証される制御フィールドを複数行化すると、
    // 正常なエントリが errors へ落ちてカードごと消える（PRレビュー指摘対応）。
    it("制御フィールド（ステータス・優先度・担当ポジション）の直下のインデント行は値に取り込まない", () => {
      const content = [
        "### [C-802] 制御フィールドの直下に注記がある",
        "",
        "**分類欄（エージェントが記入）**",
        "- 担当ポジション: harness",
        "  （ポジション名の注記）",
        "- 優先度: P1",
        "  （優先度の根拠メモ）",
        "- ステータス: 着手中",
        "  （2026-08-20 レビュー待ち）",
        "",
      ].join("\n");

      const result = parseLedger(content, "control-fields.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges).toHaveLength(1);
      const entry = result.challenges[0];
      expect(entry?.status).toBe("着手中");
      expect(entry?.priority).toBe("P1");
      expect(entry?.position).toBe("harness");
    });

    // 規定 5: フェンス内・HTML コメント内は台帳データではない。値を終端させず
    // 中身も含めずに読み飛ばし、ブロックが閉じたら同じフィールドの値へ戻る。
    it("引用ブロック中の複数行 HTML コメントを読み飛ばし、コメント終了後の引用行を値に戻す", () => {
      const content = [
        "### [C-803] 説明の途中に複数行コメントがある",
        "",
        "**人間記入欄**",
        "- 説明:（原文引用）",
        "> ## 背景",
        "> <!--",
        "> これはテンプレートのコメント",
        "> -->",
        "> 本文のつづき（重要）",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "",
      ].join("\n");

      const result = parseLedger(content, "comment-in-quote.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges[0]?.description).toBe(
        ["（原文引用）", "> ## 背景", "> 本文のつづき（重要）"].join("\n"),
      );
      expect(result.challenges[0]?.status).toBe("着手中");
    });

    it("ネスト項目の途中のフェンスを読み飛ばし、フェンス終了後のネスト項目を値に戻す", () => {
      const content = [
        "### [C-804] タスク案の途中にフェンスがある",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "- タスク案:",
        "  1. 実装する",
        "  ```",
        "  fenced sample",
        "  ```",
        "  2. 検証する",
        "",
      ].join("\n");

      const result = parseLedger(content, "fence-in-task-plan.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges[0]?.taskPlan).toBe(
        ["1. 実装する", "2. 検証する"].join("\n"),
      );
    });

    // 規定 3: 値の終端条件のうち「次のエントリ見出し」の経路。
    it("値の終端は次のエントリ見出し（読み取り規則 3）: 空行なしで見出しが続いても両エントリを読む", () => {
      const content = [
        "### [C-805] 複数行タスク案で終わるエントリ",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "- タスク案:",
        "  1. 実装する",
        "### [C-806] 空行なしで続く次のエントリ",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 未分類",
        "",
      ].join("\n");

      const result = parseLedger(content, "heading-terminates.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges.map((c) => c.id)).toEqual(["C-805", "C-806"]);
      expect(result.challenges[0]?.taskPlan).toBe("1. 実装する");
      expect(result.challenges[1]?.title).toBe("空行なしで続く次のエントリ");
    });

    it("上流の誤例（見出し直前の空行欠落）でも両エントリを読み、前のエントリの値に吸収しない", () => {
      const result = parseContractFixture("heading-no-blank-line.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges.map((c) => c.id)).toEqual(["C-005", "C-006"]);
      expect(result.challenges[0]?.taskPlan).toBe(
        ["1. 調査する", "2. 実装する", "3. 検証する"].join("\n"),
      );
    });

    it("同一ラベルが重複した場合は先勝ちで、重複側の継続行も先頭の値に取り込まない", () => {
      const content = [
        "### [C-807] タスク案が重複している",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "- タスク案: 先に書かれた値",
        "- タスク案:",
        "  1. 後から書かれたネスト項目",
        "",
      ].join("\n");

      const result = parseLedger(content, "duplicate-label.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges[0]?.taskPlan).toBe("先に書かれた値");
    });

    it("アーカイブ（完了エントリの移動先）の形 A タスク案も取得する", () => {
      const result = parseContractFixture("archive.md");

      expect(result.errors).toEqual([]);
      const c003 = result.challenges.find((c) => c.id === "C-003");
      expect(c003?.status).toBe("完了");
      expect(c003?.taskPlan).toBe("1. 修正 PR を作成する");
    });

    it("値の終端は空行（読み取り規則 3）: 空行より後のネスト項目は値に含めない", () => {
      const result = parseContractFixture("continuation-break-variants.md");

      const c603 = result.challenges.find((c) => c.id === "C-603");
      expect(c603?.taskPlan).toBe(["段階的に進める", "1. 調査する"].join("\n"));
    });
  });

  describe("参照フィールド（関連リポジトリ・関連Issue・関連PR）", () => {
    it("カンマ区切りの複数値を owner/repo/番号に分解する（完全形・短縮形の両方）", () => {
      const result = parseContractFixture("multiline-and-refs.md");

      const c101 = result.challenges.find((c) => c.id === "C-101");
      expect(c101?.relatedRepos).toEqual([
        {
          raw: "masanami/claude-flywheel",
          owner: "masanami",
          repo: "claude-flywheel",
        },
        {
          raw: "masanami/claude-flywheel-board",
          owner: "masanami",
          repo: "claude-flywheel-board",
        },
      ]);
      expect(c101?.relatedIssues).toEqual([
        {
          raw: "claude-flywheel#87",
          owner: "masanami",
          repo: "claude-flywheel",
          number: 87,
        },
        {
          raw: "masanami/claude-flywheel#89",
          owner: "masanami",
          repo: "claude-flywheel",
          number: 89,
        },
      ]);
      expect(c101?.relatedPrs).toEqual([
        {
          raw: "masanami/claude-flywheel#93",
          owner: "masanami",
          repo: "claude-flywheel",
          number: 93,
        },
      ]);
    });

    it("単一値の参照フィールドも配列 1 件として取得する", () => {
      const result = parseContractFixture("multiline-and-refs.md");

      const c104 = result.challenges.find((c) => c.id === "C-104");
      expect(c104?.relatedRepos).toHaveLength(1);
      expect(c104?.relatedIssues).toEqual([
        {
          raw: "claude-flywheel#91",
          owner: "masanami",
          repo: "claude-flywheel",
          number: 91,
        },
      ]);
    });

    it("フィールド行の値の一部に参照らしき文字列があってもリンク化の材料にしない（完全一致のみ）", () => {
      const content = [
        "### [C-808] 参照フィールドに自由文が混じる",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "- 関連リポジトリ: see masanami/claude-flywheel",
        "- 関連Issue: 詳細は claude-flywheel#87 を参照",
        "",
      ].join("\n");

      const result = parseLedger(content, "ref-anchor.md");

      expect(result.errors).toEqual([]);
      const entry = result.challenges[0];
      expect(entry?.relatedRepos).toEqual([
        { raw: "see masanami/claude-flywheel" },
      ]);
      expect(entry?.relatedIssues).toEqual([
        { raw: "詳細は claude-flywheel#87 を参照" },
      ]);
    });

    it("owner 付きの参照が自由文に埋まっている場合もリンク化しない（部分一致で拾わない）", () => {
      const content = [
        "### [C-810] 参照フィールドに owner 付きの参照が埋まっている",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "- 関連Issue: 詳細は masanami/claude-flywheel#87 を参照",
        "- 関連PR: masanami/claude-flywheel#93 と masanami/claude-flywheel#94",
        "",
      ].join("\n");

      const result = parseLedger(content, "ref-anchor-owner.md");

      expect(result.errors).toEqual([]);
      const entry = result.challenges[0];
      expect(entry?.relatedIssues).toEqual([
        { raw: "詳細は masanami/claude-flywheel#87 を参照" },
      ]);
      // カンマ区切りでない併記も 1 値として扱い、部分一致で先頭だけ拾わない。
      expect(entry?.relatedPrs).toEqual([
        { raw: "masanami/claude-flywheel#93 と masanami/claude-flywheel#94" },
      ]);
    });

    // 規定は参照フィールドの値の形を「カンマ区切り」としか定めておらず、複数行形式は
    // 定義していない。したがって参照フィールドは継続行を収集せず、複数行で書かれた
    // 値は形 E / 形 F と同じく欠落する（PRレビュー指摘対応: 実装とコメントの主張を一致させた）。
    it("参照フィールドを複数行形式で書いた場合は規定外の形として欠落する（誤ってマーカー付きの値を作らない）", () => {
      const content = [
        "### [C-809] 参照フィールドを複数行で書く",
        "",
        "**分類欄（エージェントが記入）**",
        "- ステータス: 着手中",
        "- 関連リポジトリ:",
        "  - masanami/claude-flywheel",
        "  - masanami/claude-flywheel-board",
        "",
      ].join("\n");

      const result = parseLedger(content, "ref-multiline.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges[0]?.relatedRepos).toBeUndefined();
    });

    it("参照フィールドが空欄・不在のエントリは undefined になる（後方互換）", () => {
      const result = parseContractFixture("multiline-and-refs.md");

      // C-102 は 3 フィールドとも行が無い（契約導入前の既存エントリ）。
      const c102 = result.challenges.find((c) => c.id === "C-102");
      expect(c102?.relatedRepos).toBeUndefined();
      expect(c102?.relatedIssues).toBeUndefined();
      expect(c102?.relatedPrs).toBeUndefined();
      // C-103 は 3 フィールドとも行はあるが値が空欄。
      const c103 = result.challenges.find((c) => c.id === "C-103");
      expect(c103?.relatedRepos).toBeUndefined();
      expect(c103?.relatedIssues).toBeUndefined();
      expect(c103?.relatedPrs).toBeUndefined();
    });

    it("短縮形の owner は同エントリの 関連リポジトリ から解決し、同名 repo が無ければ raw のみ保持する", () => {
      const content = readFixture("related-refs-shorthand.md");

      const result = parseLedger(content, "related-refs-shorthand.md");

      expect(result.errors).toEqual([]);
      const c701 = result.challenges.find((c) => c.id === "C-701");
      expect(c701?.relatedIssues).toEqual([
        {
          raw: "claude-flywheel#87",
          owner: "masanami",
          repo: "claude-flywheel",
          number: 87,
        },
        // 同エントリの 関連リポジトリ に other-repo が無いため owner 不明。
        { raw: "other-repo#12" },
        {
          raw: "masanami/other-repo#34",
          owner: "masanami",
          repo: "other-repo",
          number: 34,
        },
      ]);
    });

    it("関連リポジトリが空のエントリでは短縮形の owner を解決できず raw のみ保持する", () => {
      const content = readFixture("related-refs-shorthand.md");

      const result = parseLedger(content, "related-refs-shorthand.md");

      const c702 = result.challenges.find((c) => c.id === "C-702");
      expect(c702?.relatedRepos).toBeUndefined();
      expect(c702?.relatedIssues).toEqual([{ raw: "claude-flywheel#87" }]);
    });
  });

  describe("誤例方向: 規定が違反とする形でもクラッシュせず、規定どおりの読み取り結果になる", () => {
    it("形 F（ネスト項目のインデント欠落）は タスク案 が欠落し、エントリ自体は読める", () => {
      const result = parseContractFixture("task-plan-dedented.md");

      expect(result.errors).toEqual([]);
      const c201 = result.challenges.find((c) => c.id === "C-201");
      expect(c201?.status).toBe("計画承認待ち");
      expect(c201?.taskPlan).toBeUndefined();
    });

    it("形 E（太字見出しブロック）は タスク案 が欠落し、エントリ自体は読める", () => {
      const result = parseContractFixture("task-plan-bold-heading.md");

      expect(result.errors).toEqual([]);
      const c401 = result.challenges.find((c) => c.id === "C-401");
      expect(c401?.status).toBe("完了確認待ち");
      expect(c401?.taskPlan).toBeUndefined();
    });

    it("結合切れ（行頭ハイフン・アスタリスクのネスト項目）でも例外を投げず、値は欠落する", () => {
      const result = parseContractFixture("continuation-break-variants.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges.map((c) => c.id)).toEqual([
        "C-601",
        "C-602",
        "C-603",
      ]);
      expect(result.challenges[0]?.taskPlan).toBeUndefined();
      expect(result.challenges[1]?.taskPlan).toBeUndefined();
    });

    it("参照フィールドの自由記述・URL・プレースホルダは raw のみ保持し、リンク化の材料を持たない", () => {
      const result = parseContractFixture("related-refs-freetext.md");

      expect(result.errors).toEqual([]);
      const c301 = result.challenges.find((c) => c.id === "C-301");
      expect(c301?.relatedRepos).toEqual([{ raw: "board のリポジトリ" }]);
      expect(c301?.relatedIssues).toEqual([{ raw: "#87 と #89" }]);
      expect(c301?.relatedPrs).toEqual([
        { raw: "https://github.com/masanami/claude-flywheel/pull/93" },
      ]);
    });
  });
});

describe("承認チェックボックス（§承認プロトコル）", () => {
  const ENTRY = (approvalBlock: string, status = "計画承認待ち") =>
    `### [C-001] テスト課題

**分類欄（エージェントが記入）**
- ステータス: ${status}
${approvalBlock}
- 備考:
`;

  it("`- 承認（人間がチェック）:` 直下のチェックボックスを種別ごとに読み取る", () => {
    const result = parseLedger(
      ENTRY(
        `- 承認（人間がチェック）:
  - [x] 計画を承認（FR-13・承認対象＝タスク案）
  - [ ] 完了を承認（FR-32）`,
      ),
      "challenge-ledger.md",
    );

    expect(result.errors).toEqual([]);
    expect(result.challenges[0]?.approvals).toEqual({
      plan: {
        checked: true,
        line: 6,
        label: "計画を承認（FR-13・承認対象＝タスク案）",
      },
      completion: { checked: false, line: 7, label: "完了を承認（FR-32）" },
    });
  });

  it("旧表記（`計画を承認（FR-13）`）も前方一致で同定する", () => {
    // 規定: 承認の検出はラベルの前方一致で行い、旧表記のエントリも有効。
    const result = parseLedger(
      ENTRY(
        `- 承認（人間がチェック）:
  - [ ] 計画を承認（FR-13）
  - [ ] 完了を承認（FR-32）`,
      ),
      "challenge-ledger.md",
    );

    expect(result.challenges[0]?.approvals?.plan?.checked).toBe(false);
    expect(result.challenges[0]?.approvals?.plan?.label).toBe(
      "計画を承認（FR-13）",
    );
  });

  it("大文字 [X] も承認済みとして扱う", () => {
    const result = parseLedger(
      ENTRY(
        `- 承認（人間がチェック）:
  - [X] 計画を承認（FR-13）`,
      ),
      "challenge-ledger.md",
    );

    expect(result.challenges[0]?.approvals?.plan?.checked).toBe(true);
  });

  it("承認フィールド直下でないチェックボックス（タスク案のタスクリスト記法）を承認として拾わない", () => {
    // 規定 §消費側の読み取り規則 4 は「承認フィールド直下の専用構造」に限っており、
    // 行の形（`  - [ ] …`）だけで拾うと完了条件・タスク案の項目を承認と誤認する。
    const result = parseLedger(
      `### [C-001] テスト課題

**分類欄（エージェントが記入）**
- ステータス: 計画承認待ち
- タスク案:
  - [ ] 計画を承認 と書かれた紛らわしいタスク
- 備考:
`,
      "challenge-ledger.md",
    );

    expect(result.challenges[0]?.approvals).toBeUndefined();
    // タスク案の値としては保持される（既存の受理方向の挙動を壊さない）。
    expect(result.challenges[0]?.taskPlan).toBe(
      "- [ ] 計画を承認 と書かれた紛らわしいタスク",
    );
  });

  it("承認フィールドが無いエントリでは approvals が undefined になる", () => {
    const result = parseLedger(
      `### [C-001] テスト課題

**分類欄（エージェントが記入）**
- ステータス: 分類済
- 備考:
`,
      "challenge-ledger.md",
    );

    expect(result.challenges[0]?.approvals).toBeUndefined();
  });

  it("承認チェックが台帳の値（タスク案）に混入しない", () => {
    const result = parseLedger(
      `### [C-001] テスト課題

**分類欄（エージェントが記入）**
- ステータス: 計画承認待ち
- タスク案:
  1. 何かをする
- 承認（人間がチェック）:
  - [ ] 計画を承認（FR-13）
- 備考:
`,
      "challenge-ledger.md",
    );

    expect(result.challenges[0]?.taskPlan).toBe("1. 何かをする");
    expect(result.challenges[0]?.approvals?.plan?.checked).toBe(false);
  });

  it("同一種別の重複行は先勝ち（最初の1行を正とする）", () => {
    const result = parseLedger(
      ENTRY(
        `- 承認（人間がチェック）:
  - [ ] 計画を承認（FR-13）
  - [x] 計画を承認（重複）`,
      ),
      "challenge-ledger.md",
    );

    expect(result.challenges[0]?.approvals?.plan).toEqual({
      checked: false,
      line: 6,
      label: "計画を承認（FR-13）",
    });
  });

  it("上流契約フィクスチャの承認行を規定どおり読み取る（行番号込み）", () => {
    const contractPath = `${CONTRACT_LEDGER_ROOT}valid/multiline-and-refs.md`;
    const result = parseLedgerFile(contractPath);

    expect(result.errors).toEqual([]);
    const c102 = result.challenges.find((c) => c.id === "C-102");
    // C-102 は 計画承認待ち・未承認。board の承認ボタンが対象にするエントリ。
    expect(c102?.status).toBe("計画承認待ち");
    expect(c102?.approvals?.plan?.checked).toBe(false);
    expect(c102?.approvals?.completion?.checked).toBe(false);

    // 行番号は書き込み対象行の特定に使うため、実ファイルの中身と一致していること。
    const lines = fs.readFileSync(contractPath, "utf-8").split("\n");
    const planLine = c102?.approvals?.plan?.line;
    expect(planLine).toBeDefined();
    expect(lines[(planLine as number) - 1]).toContain("計画を承認");
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
