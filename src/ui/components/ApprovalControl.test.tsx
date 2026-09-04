import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Challenge } from "../board-types.ts";
import { ApprovalControl } from "./ApprovalControl.tsx";

// ApprovalControl.tsx の抽出元は TaskCard.tsx の「TaskCard の承認ボタン
//（Issue #165・FR-20）」（#171・D2）。判定（readOnly / onApprove 未指定 /
// 承認対象外ステータス / 既に [x]）と 2 段階フロー・エラー表示はこのコンポーネント
// 側に閉じ込めたため、ホスト非依存のロジックはここで一元的に検証する。
// TaskCard.test.tsx の同名 describe は「移設」ではなく意図的に**残置**している
//（D2 の受け入れ条件＝既存テストが無改変で通ることの担保）ため、承認ロジック
// そのものの網羅ケースは TaskCard.test.tsx と本ファイルの双方に存在する。
// CardDetailModal.test.tsx 側は結線（props が正しく渡っているか・D1/D5 の固定）
// の確認に絞り、判定の網羅は持たない。

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "C-001",
    title: "課題タイトル",
    status: "未分類",
    needsHuman: false,
    ...overrides,
  };
}

function approvable(overrides: Partial<Challenge> = {}): Challenge {
  return challenge({
    id: "C-010",
    status: "計画承認待ち",
    needsHuman: true,
    approvals: {
      plan: { checked: false, line: 9, label: "計画を承認（FR-13）" },
      completion: { checked: false, line: 10, label: "完了を承認（FR-32）" },
    },
    ...overrides,
  });
}

describe("ApprovalControl", () => {
  it("計画承認待ちには「計画を承認」ボタンを出す", () => {
    render(<ApprovalControl challenge={approvable()} onApprove={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "計画を承認" }),
    ).toBeInTheDocument();
  });

  it("完了確認待ちには「完了を承認」ボタンを出す", () => {
    render(
      <ApprovalControl
        challenge={approvable({ status: "完了確認待ち" })}
        onApprove={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "完了を承認" }),
    ).toBeInTheDocument();
  });

  it("人間対応待ち（回答待ちの保留）には承認ボタンを出さない", () => {
    // 保留は承認ではなく分類欄の `人間の回答` への記入を待つ状態であり、
    // チェックボックスを立てても意味を持たない（上流 §保留プロトコル）。
    render(
      <ApprovalControl
        challenge={approvable({ status: "人間対応待ち" })}
        onApprove={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "計画を承認" }),
    ).not.toBeInTheDocument();
  });

  it("承認済み（[x]）には承認ボタンを出さない", () => {
    render(
      <ApprovalControl
        challenge={approvable({
          approvals: {
            plan: { checked: true, line: 9, label: "計画を承認（FR-13）" },
          },
        })}
        onApprove={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "計画を承認" }),
    ).not.toBeInTheDocument();
  });

  it("onApprove が未指定なら何も描画しない", () => {
    const { container } = render(<ApprovalControl challenge={approvable()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("readOnly なら何も描画しない", () => {
    const { container } = render(
      <ApprovalControl challenge={approvable()} onApprove={vi.fn()} readOnly />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("承認対象外ステータスでは何も描画しない", () => {
    const { container } = render(
      <ApprovalControl challenge={challenge()} onApprove={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("1 クリック目では送信せず、確認を挟む（誤操作対策）", () => {
    const onApprove = vi.fn();
    render(<ApprovalControl challenge={approvable()} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));

    expect(onApprove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "承認する" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "やめる" })).toBeInTheDocument();
  });

  it("確認後の「承認する」で課題 ID と承認種別を送る", async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: true });
    render(<ApprovalControl challenge={approvable()} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));

    expect(onApprove).toHaveBeenCalledWith("C-010", "plan");
    await screen.findByRole("button", { name: "計画を承認" });
  });

  it("「やめる」で送信せず元に戻る", () => {
    const onApprove = vi.fn();
    render(<ApprovalControl challenge={approvable()} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));

    expect(onApprove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "計画を承認" }),
    ).toBeInTheDocument();
  });

  it("失敗時はサーバのエラーメッセージを表示する", async () => {
    const onApprove = vi.fn().mockResolvedValue({
      ok: false,
      error: "このエージェントで run-cycle が実行中です",
    });
    render(<ApprovalControl challenge={approvable()} onApprove={onApprove} />);

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "このエージェントで run-cycle が実行中です",
    );
  });

  it("className を渡すとルート要素へ合成される（呼び出し元固有のレイアウト用）", () => {
    const { container } = render(
      <ApprovalControl
        challenge={approvable()}
        onApprove={vi.fn()}
        className="task-card-approval"
      />,
    );

    const root = container.firstElementChild;
    expect(root).toHaveClass("approval-control");
    expect(root).toHaveClass("task-card-approval");
  });
});

// 「承認する」ボタンの強調配色が実際に適用されるか（詳細度の回帰テスト）。
//
// jsdom は外部 CSS を適用せずカスケードも解決しないため、算出スタイルでは検証
// できない。TaskCard.test.tsx の「カードの余白の持ち主」と同じく、出荷される
// CSS ファイルを実ファイルとして読み、宣言とセレクタを直接検査する。
//
// 固定したい意図: 確定ボタンのルールは `.approval-control button`（背景を
// transparent・文字色を inherit に落とす共通ルール）より**詳細度が高い**こと。
// #168 の時点では `.task-card-approval-confirm`（0,1,0）が
// `.task-card-approval button`（0,1,1）に負けており、強調色も WCAG AA 対応の
// 文字色固定も効いていなかった。#171 でルールを移設するにあたって直したため、
// 移設や整理でまた負けることがないようここで固定する。
describe("承認確定ボタンの配色が共通ボタンルールに負けない（詳細度・#171）", () => {
  const boardStyles = readFileSync(
    resolve(process.cwd(), "src/ui/styles.css"),
    "utf-8",
  );

  // クラス（.foo）と要素型（button 等）の個数だけで足りる比較。このファイルの
  // 対象セレクタには ID も属性/擬似クラスも出てこないため 2 要素で十分。
  function specificity(selector: string): [number, number] {
    const classes = selector.match(/\.[a-zA-Z0-9_-]+/g)?.length ?? 0;
    const types =
      selector.replace(/\.[a-zA-Z0-9_-]+/g, " ").match(/[a-zA-Z][a-zA-Z0-9]*/g)
        ?.length ?? 0;
    return [classes, types];
  }

  // 共通ルール（背景を transparent・文字色を inherit に落とす側）のセレクタは
  // 固定文字列で指定する。styles.css には `background: transparent;` を持つ
  // ルールが 10 個以上あり、宣言から引き当てると別のルールを掴んでしまうため。
  const SHARED_BUTTON_SELECTOR = ".approval-control button";

  function declarationsFor(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declarations = new RegExp(
      `(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`,
    ).exec(boardStyles)?.[1];
    if (declarations === undefined) {
      throw new Error(`CSS ルール ${selector} が styles.css に見つかりません`);
    }
    return declarations.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  // 確定ボタンのルールは、WCAG AA 対応で固定した文字色（#1c1c1f。styles.css 内で
  // ここにしか出てこない）から引き当てる。セレクタ名を直接書くと、セレクタを
  // 変えた瞬間にテストが「ルールが無い」で落ちるだけになり、詳細度の意図を
  // 固定できないため。
  function confirmRuleSelector(): string {
    const selector = /(?:^|\n)([^\n{}]+?)\s*\{[^}]*color: #1c1c1f;[^}]*\}/.exec(
      boardStyles,
    )?.[1];
    if (selector === undefined) {
      throw new Error("確定ボタンの配色ルールが styles.css に見つかりません");
    }
    return selector.trim();
  }

  it("共通ルール側が確定ボタンの配色を打ち消す宣言を持つ（前提の確認）", () => {
    const shared = declarationsFor(SHARED_BUTTON_SELECTOR);
    expect(shared).toMatch(/background:\s*transparent\s*;/);
    expect(shared).toMatch(/color:\s*inherit\s*;/);
  });

  it("確定ボタンのルールが .approval-control button より詳細度で上回る", () => {
    const shared = specificity(SHARED_BUTTON_SELECTOR);
    const confirm = specificity(confirmRuleSelector());

    expect(confirm[0] * 100 + confirm[1]).toBeGreaterThan(
      shared[0] * 100 + shared[1],
    );
  });
});
