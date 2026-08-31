import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cycleLockPathFor } from "./cycle-lock.ts";
import { approveChallenge, verifyApprovalRewrite } from "./ledger-approval.ts";
import { parseLedger } from "./parsers/ledger.ts";

const LEDGER_NAME = "challenge-ledger.md";

// 上流フォーマット規定どおりの最小台帳。承認チェックボックスは分類欄の
// `- 承認（人間がチェック）:` の直下に 2 スペースインデントで置く。
function ledgerContent(options?: {
  planChecked?: boolean;
  status?: string;
  omitApprovalField?: boolean;
}): string {
  const status = options?.status ?? "計画承認待ち";
  const plan = options?.planChecked ? "x" : " ";
  const approvalBlock = options?.omitApprovalField
    ? ""
    : `- 承認（人間がチェック）:
  - [${plan}] 計画を承認（FR-13・承認対象＝タスク案）
  - [ ] 完了を承認（FR-32）
`;
  return `# 課題台帳

### [C-001] 先行する別の課題

**分類欄（エージェントが記入）**
- ステータス: 着手中
- 承認（人間がチェック）:
  - [x] 計画を承認（FR-13・承認対象＝タスク案）
  - [ ] 完了を承認（FR-32）
- 備考:

### [C-002] 承認対象の課題

**分類欄（エージェントが記入）**
- 担当ポジション: harness
- 優先度: P1
- ステータス: ${status}
- タスク案:
  1. なにかをする
${approvalBlock}- 備考:
`;
}

let workspace: string;
let ledgerPath: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", workspace, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "board-approval-"));
  ledgerPath = path.join(workspace, LEDGER_NAME);
  fs.writeFileSync(ledgerPath, ledgerContent());

  git("init", "-q");
  // 人間の identity を模す。board は author を上書きせず config へフォールバック
  // させるため、ここに設定した値がそのままコミットの author になる。
  git("config", "user.name", "Human Operator");
  git("config", "user.email", "human@example.com");
  git("add", LEDGER_NAME);
  git("commit", "-q", "-m", "chore: 台帳を追加");
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = saved;
}

function approve(overrides?: Partial<Parameters<typeof approveChallenge>[0]>) {
  return approveChallenge({
    workspacePath: workspace,
    ledgerPath,
    challengeId: "C-002",
    kind: "plan",
    ...overrides,
  });
}

describe("approveChallenge", () => {
  it("対象のチェックボックス 1 行だけを [ ] → [x] に書き換える", () => {
    const before = fs.readFileSync(ledgerPath, "utf-8");

    const result = approve();

    expect(result.ok).toBe(true);
    const after = fs.readFileSync(ledgerPath, "utf-8");
    const changed = after
      .split("\n")
      .filter((line, i) => line !== before.split("\n")[i]);
    expect(changed).toEqual([
      "  - [x] 計画を承認（FR-13・承認対象＝タスク案）",
    ]);
  });

  it("ステータス行を書き換えない（遷移はエージェントが代行する・NFR-01 区分③）", () => {
    approve();

    const parsed = parseLedger(
      fs.readFileSync(ledgerPath, "utf-8"),
      ledgerPath,
    );
    expect(parsed.challenges.find((c) => c.id === "C-002")?.status).toBe(
      "計画承認待ち",
    );
  });

  it("人間の git identity でコミットする（承認の真正性・経路 1）", () => {
    const result = approve();

    expect(result.ok).toBe(true);
    expect(git("log", "-1", "--format=%an <%ae>")).toBe(
      "Human Operator <human@example.com>",
    );
    expect(git("log", "-1", "--format=%s")).toBe(
      "chore: C-002 の計画を承認（FR-13）",
    );
    // 書き込みがコミット済み＝作業ツリーに未コミットの [x] を残さない。
    expect(git("status", "--porcelain")).toBe("");
  });

  it("GIT_AUTHOR_* を継承しても author を人間の config に固定する", () => {
    // board を Claude Code セッションのシェルから起動した場合に環境変数が
    // 継承されうる。承認は人間のコミットでなければ成立しないため、ここで落とす。
    const saved = process.env.GIT_AUTHOR_NAME;
    process.env.GIT_AUTHOR_NAME = "Some Agent";
    process.env.GIT_AUTHOR_EMAIL = "agent@example.com";
    try {
      expect(approve().ok).toBe(true);
      expect(git("log", "-1", "--format=%an <%ae>")).toBe(
        "Human Operator <human@example.com>",
      );
    } finally {
      restoreEnv("GIT_AUTHOR_NAME", saved);
      restoreEnv("GIT_AUTHOR_EMAIL", undefined);
    }
  });

  it("台帳以外の未コミット変更を巻き込まない（pathspec 付き commit）", () => {
    const other = path.join(workspace, "priority-policy.md");
    fs.writeFileSync(other, "エージェントが編集中\n");

    expect(approve().ok).toBe(true);

    expect(git("status", "--porcelain")).toContain("priority-policy.md");
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe(LEDGER_NAME);
  });

  it("戻り値のコミット SHA が HEAD と一致する", () => {
    const result = approve();

    expect(result.ok && result.commit).toBe(git("rev-parse", "HEAD"));
  });

  it("成功時に cycle.lock を解放する", () => {
    expect(approve().ok).toBe(true);

    expect(fs.existsSync(cycleLockPathFor(workspace))).toBe(false);
  });

  it("cycle.lock を取得できないときは何も書かず 409 を返す", () => {
    fs.mkdirSync(cycleLockPathFor(workspace), { recursive: true });
    const before = fs.readFileSync(ledgerPath, "utf-8");

    const result = approve();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
    }
    expect(fs.readFileSync(ledgerPath, "utf-8")).toBe(before);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("ステータスが承認の前提と合わないときは 409 を返し、書き込まない", () => {
    fs.writeFileSync(ledgerPath, ledgerContent({ status: "着手中" }));
    const before = fs.readFileSync(ledgerPath, "utf-8");

    const result = approve();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("計画承認待ち");
    }
    expect(fs.readFileSync(ledgerPath, "utf-8")).toBe(before);
  });

  it("完了承認は 完了確認待ち のときだけ通る", () => {
    fs.writeFileSync(ledgerPath, ledgerContent({ status: "完了確認待ち" }));

    expect(approve({ kind: "completion" }).ok).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf-8")).toContain(
      "  - [x] 完了を承認（FR-32）",
    );
  });

  it("既に承認済みなら 409 を返す（二重コミットを作らない）", () => {
    fs.writeFileSync(ledgerPath, ledgerContent({ planChecked: true }));

    const result = approve();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain("既に承認済み");
    }
  });

  it("承認チェックボックス行が無いエントリでは行を作らず 409 を返す", () => {
    // 「機械が人間の欄を捏造しない」（上流 §台帳の正規化 2）に合わせる。
    fs.writeFileSync(ledgerPath, ledgerContent({ omitApprovalField: true }));

    const result = approve();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain(
        "承認チェックボックス行が台帳にありません",
      );
    }
    // C-002 に承認欄が生えていないこと（C-001 の承認欄は元から存在する）。
    const parsed = parseLedger(
      fs.readFileSync(ledgerPath, "utf-8"),
      ledgerPath,
    );
    expect(parsed.challenges.find((c) => c.id === "C-002")?.approvals).toBe(
      undefined,
    );
  });

  it("課題 ID が重複している台帳では書き込みを中止する（どちらを承認すべきか決まらない）", () => {
    // 同じ ID のエントリが 2 つある台帳では、行の特定は最初の 1 件に当たる一方、
    // 書き込み後の突き合わせは「その ID の承認が立っていること」を全エントリに
    // 要求するため、片方だけ立った状態は契約違反として検出される。board が
    // 曖昧なまま片方を承認して人間の意図と食い違うより、中止して知らせる方が安全。
    fs.appendFileSync(
      ledgerPath,
      `
### [C-002] 同じ ID の別エントリ

**分類欄（エージェントが記入）**
- ステータス: 計画承認待ち
- 承認（人間がチェック）:
  - [ ] 計画を承認（FR-13・承認対象＝タスク案）
- 備考:
`,
    );
    const before = fs.readFileSync(ledgerPath, "utf-8");

    const result = approve();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("フォーマット契約の検証に失敗");
    }
    // 検証に落ちたら書き込まない（ファイルは無傷・コミットも増えない）。
    expect(fs.readFileSync(ledgerPath, "utf-8")).toBe(before);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("存在しない課題 ID は 404 を返す", () => {
    const result = approve({ challengeId: "C-999" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  it("別エントリ（C-001）の承認状態を変えない", () => {
    approve();

    const parsed = parseLedger(
      fs.readFileSync(ledgerPath, "utf-8"),
      ledgerPath,
    );
    const c001 = parsed.challenges.find((c) => c.id === "C-001");
    expect(c001?.approvals?.plan?.checked).toBe(true);
    expect(c001?.approvals?.completion?.checked).toBe(false);
  });

  it("コミットできない場合は書き込みを取り消す（未コミットの [x] を残さない）", () => {
    // index.lock を先に作って git commit を失敗させる。承認は人間のコミットで
    // なければ成立しないため、ファイルだけ [x] に書き換わって残るのが最悪の状態
    // （利用者には承認できたように見えるのに、エージェントは前進しない）。
    fs.writeFileSync(path.join(workspace, ".git", "index.lock"), "");
    const before = fs.readFileSync(ledgerPath, "utf-8");

    const result = approve();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("書き込みは取り消しました");
    }
    expect(fs.readFileSync(ledgerPath, "utf-8")).toBe(before);
    expect(fs.existsSync(cycleLockPathFor(workspace))).toBe(false);
  });

  it("git identity が未設定なら書き込まず、理由を明示して失敗する", () => {
    // グローバル/システム設定を遮断したうえでローカル設定を外し、identity が
    // 本当に無い状態を作る。
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    const savedSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    git("config", "--unset", "user.name");
    git("config", "--unset", "user.email");
    const before = fs.readFileSync(ledgerPath, "utf-8");

    try {
      const result = approve();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("承認の真正性");
      }
      expect(fs.readFileSync(ledgerPath, "utf-8")).toBe(before);
    } finally {
      restoreEnv("GIT_CONFIG_GLOBAL", savedGlobal);
      restoreEnv("GIT_CONFIG_SYSTEM", savedSystem);
    }
  });
});

describe("verifyApprovalRewrite", () => {
  const parse = (content: string) => parseLedger(content, LEDGER_NAME);

  it("対象チェックだけが変化していれば null（違反なし）を返す", () => {
    const before = parse(ledgerContent());
    const after = parse(ledgerContent({ planChecked: true }));

    expect(verifyApprovalRewrite(before, after, "C-002", "plan")).toBeNull();
  });

  it("対象が未承認のままなら違反として検出する", () => {
    const before = parse(ledgerContent());

    expect(verifyApprovalRewrite(before, before, "C-002", "plan")).toContain(
      "未承認のまま",
    );
  });

  it("ステータスが変化したら違反として検出する", () => {
    const before = parse(ledgerContent());
    const after = parse(ledgerContent({ planChecked: true, status: "着手中" }));

    expect(verifyApprovalRewrite(before, after, "C-002", "plan")).toContain(
      "ステータスが変化",
    );
  });

  it("対象外の承認チェックが変化したら違反として検出する", () => {
    const before = parse(ledgerContent());
    const after = parse(
      ledgerContent({ planChecked: true }).replace(
        "  - [x] 計画を承認（FR-13・承認対象＝タスク案）\n  - [ ] 完了を承認（FR-32）\n- 備考:\n\n### [C-002]",
        "  - [x] 計画を承認（FR-13・承認対象＝タスク案）\n  - [x] 完了を承認（FR-32）\n- 備考:\n\n### [C-002]",
      ),
    );

    expect(verifyApprovalRewrite(before, after, "C-002", "plan")).toContain(
      "対象外の承認チェック",
    );
  });

  it("エントリが失われたら違反として検出する", () => {
    const before = parse(ledgerContent());
    const after = parse(
      ledgerContent({ planChecked: true }).replace(
        "### [C-001] 先行する別の課題",
        "## [C-001] 先行する別の課題",
      ),
    );

    expect(verifyApprovalRewrite(before, after, "C-002", "plan")).toContain(
      "エントリ数が変化",
    );
  });

  it("パースエラーが増えたら違反として検出する", () => {
    const before = parse(ledgerContent());
    const after = parse(
      ledgerContent({ planChecked: true }).replace(
        "- ステータス: 計画承認待ち",
        "- ステータス: 存在しない語彙",
      ),
    );

    expect(verifyApprovalRewrite(before, after, "C-002", "plan")).toContain(
      "パースエラー件数が変化",
    );
  });
});
