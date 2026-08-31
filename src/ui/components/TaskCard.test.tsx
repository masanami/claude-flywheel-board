import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
// 実ファイルの中身をそのまま取り込む（jsdom 環境では import.meta.url が file: URL に
// ならず node:fs で解決できないため、Vite の ?raw で読み込む）。
import humanHoldLedger from "../../../tests/fixtures/ledger/human-hold.md?raw";
import { parseLedger } from "../../server/parsers/ledger.ts";
import type { Challenge } from "../board-types.ts";
import { CHALLENGE_DRAG_MIME, TaskCard } from "./TaskCard.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "C-001",
    title: "課題タイトル",
    status: "未分類",
    needsHuman: false,
    ...overrides,
  };
}

describe("TaskCard", () => {
  it("タイトルを表示する", () => {
    render(
      <TaskCard
        challenge={challenge({ title: "テストタイトル" })}
        agentName="medical"
      />,
    );

    expect(screen.getByText("テストタイトル")).toBeInTheDocument();
  });

  it("メタ行に ID・ステータステキスト・ポジションを表示する", () => {
    render(
      <TaskCard
        challenge={challenge({
          id: "C-042",
          status: "着手中",
          position: "medical",
        })}
        agentName="medical"
      />,
    );

    expect(screen.getByText("C-042")).toBeInTheDocument();
    expect(screen.getByText("着手中")).toBeInTheDocument();
    expect(screen.getByText("medical")).toBeInTheDocument();
  });

  it("ポジション未設定の場合はポジション表示を省略する", () => {
    const { container } = render(
      <TaskCard
        challenge={challenge({ position: undefined })}
        agentName="medical"
      />,
    );

    expect(
      container.querySelector("[data-testid='task-card-position']"),
    ).not.toBeInTheDocument();
  });

  it("ステータスに対応する色ドットを data-status 属性で出し分ける", () => {
    const { container } = render(
      <TaskCard
        challenge={challenge({ status: "完了" })}
        agentName="medical"
      />,
    );

    const dot = container.querySelector(".status-dot");
    expect(dot).toHaveAttribute("data-status", "完了");
  });

  // 型に足しただけでは「カードとして出る」ことの証明にならないため、実ファイルの台帳を
  // パーサに通した結果をそのまま描画して確認する（フィクスチャ → parseLedger → TaskCard）。
  it("人間対応待ちの台帳を実際にパースした結果が、承認待ちマーカーつきのカードとして出る", () => {
    const parsed = parseLedger(humanHoldLedger, "human-hold.md");
    expect(parsed.errors).toEqual([]);
    const held = parsed.challenges.find((c) => c.id === "C-201");
    if (!held) throw new Error("人間対応待ちの課題がパース結果に無い");

    const { container } = render(
      <TaskCard challenge={held} agentName="medical" />,
    );

    const card = container.querySelector(".task-card");
    expect(card).toHaveAttribute("data-needs-human", "true");
    expect(container.querySelector(".status-dot")).toHaveAttribute(
      "data-status",
      "人間対応待ち",
    );
    expect(screen.getByText("人間対応待ち")).toBeInTheDocument();
  });

  it("承認導線を持たないカードは詳細モーダルを開く実ボタン 1 個だけを持つ", () => {
    // カード自体は詳細モーダルを開くための単一の実ボタンとして実装される
    // （アクセシビリティ上、キーボード操作可能な要素は <button> が適切）。
    //
    // Issue #165 でこのテストの意図を改訂した: 以前は「承認・実行など状態を
    // 変更するボタンを一切持たない（観測専用・NFR-01）」を固定していたが、
    // FR-20 の改訂により**承認待ちカードには承認ボタンを置く**ようになった。
    // 現在このテストが固定しているのは「承認対象でないカードにはボタンが
    // 増えない」ことであり、承認ボタンの出し分けは別 describe が固定する。
    // 実行・却下・ステータス変更といった**エージェントの状態機械**への操作
    // （NFR-01 区分③）を持たないことは、引き続きこのカウントが担保する。
    render(<TaskCard challenge={challenge()} agentName="medical" />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
  });

  describe("D&D 並べ替え（#16）", () => {
    it("draggable 属性を持つ", () => {
      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      expect(card).toHaveAttribute("draggable", "true");
    });

    it("dragstart で dataTransfer に課題IDをセットする", () => {
      render(
        <TaskCard challenge={challenge({ id: "C-042" })} agentName="medical" />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      const setData = vi.fn();
      fireEvent.dragStart(card, {
        dataTransfer: { setData, effectAllowed: "" },
      });

      expect(setData).toHaveBeenCalledWith(CHALLENGE_DRAG_MIME, "C-042");
    });
  });

  describe("ホバー・フォーカスによるツールチップ", () => {
    it("ホバーで summary をツールチップとして表示する", () => {
      render(
        <TaskCard
          challenge={challenge({ summary: "直近の作業要約" })}
          agentName="medical"
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      fireEvent.mouseEnter(card);

      expect(screen.getByRole("tooltip")).toHaveTextContent("直近の作業要約");

      fireEvent.mouseLeave(card);

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("キーボードフォーカスで summary をツールチップとして表示する", () => {
      render(
        <TaskCard
          challenge={challenge({ summary: "直近の作業要約" })}
          agentName="medical"
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.focus(card);

      expect(screen.getByRole("tooltip")).toHaveTextContent("直近の作業要約");

      fireEvent.blur(card);

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("summary が無い場合はホバーしてもツールチップを表示しない", () => {
      render(
        <TaskCard
          challenge={challenge({ summary: undefined })}
          agentName="medical"
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.mouseEnter(card);

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("ツールチップの id をカードの aria-describedby で参照する", () => {
      render(
        <TaskCard
          challenge={challenge({ summary: "直近の作業要約" })}
          agentName="medical"
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      expect(card).not.toHaveAttribute("aria-describedby");

      fireEvent.mouseEnter(card);

      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.id).not.toBe("");
      expect(card).toHaveAttribute("aria-describedby", tooltip.id);

      fireEvent.mouseLeave(card);

      expect(card).not.toHaveAttribute("aria-describedby");
    });
  });

  describe("詳細モーダルを開く操作", () => {
    it("クリックで詳細モーダルが開く", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      fireEvent.click(screen.getByText("課題タイトル"));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("Enter キー押下で詳細モーダルが開く", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.keyDown(card, { key: "Enter" });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("モーダルの閉じるボタンをクリックすると閉じる", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      fireEvent.click(screen.getByText("課題タイトル"));
      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("閉じるボタンでモーダルを閉じるとトリガーのカードへフォーカスが戻る", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.click(card);
      fireEvent.click(screen.getByRole("button", { name: "閉じる" }));

      expect(card).toHaveFocus();
    });

    it("ESC キーでモーダルを閉じるとトリガーのカードへフォーカスが戻る", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.click(card);
      fireEvent.keyDown(document, { key: "Escape" });

      expect(card).toHaveFocus();
    });

    it("バックドロップクリックでモーダルを閉じるとトリガーのカードへフォーカスが戻る", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.click(card);

      const overlay = screen.getByTestId("modal-overlay");
      fireEvent.mouseDown(overlay);
      fireEvent.click(overlay);

      expect(card).toHaveFocus();
    });
  });

  describe("キーボードでの並べ替え操作（#25）", () => {
    it("フォーカス中のみ「Alt+↑/↓ で並べ替え」ヒントを表示する", () => {
      render(<TaskCard challenge={challenge()} agentName="medical" />);

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      expect(screen.queryByText("Alt+↑/↓ で並べ替え")).not.toBeInTheDocument();

      fireEvent.focus(card);

      expect(screen.getByText("Alt+↑/↓ で並べ替え")).toBeInTheDocument();

      fireEvent.blur(card);

      expect(screen.queryByText("Alt+↑/↓ で並べ替え")).not.toBeInTheDocument();
    });

    it("Alt+ArrowUp で onReorderMove('up') が呼ばれる（isReordering の値によらない）", () => {
      const onReorderMove = vi.fn();
      render(
        <TaskCard
          challenge={challenge()}
          agentName="medical"
          onReorderMove={onReorderMove}
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.keyDown(card, { key: "ArrowUp", altKey: true });

      expect(onReorderMove).toHaveBeenCalledWith("up");
    });

    it("Alt+ArrowDown で onReorderMove('down') が呼ばれる", () => {
      const onReorderMove = vi.fn();
      render(
        <TaskCard
          challenge={challenge()}
          agentName="medical"
          onReorderMove={onReorderMove}
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });

      expect(onReorderMove).toHaveBeenCalledWith("down");
    });

    it("修飾キー無しの矢印キーでは onReorderMove を呼ばない", () => {
      const onReorderMove = vi.fn();
      render(
        <TaskCard
          challenge={challenge()}
          agentName="medical"
          onReorderMove={onReorderMove}
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.keyDown(card, { key: "ArrowUp" });
      fireEvent.keyDown(card, { key: "ArrowDown" });

      expect(onReorderMove).not.toHaveBeenCalled();
    });

    it("isReordering=true の状態で Enter を押すと onReorderConfirm が呼ばれ、モーダルは開かない", () => {
      const onReorderConfirm = vi.fn();
      render(
        <TaskCard
          challenge={challenge()}
          agentName="medical"
          isReordering
          onReorderConfirm={onReorderConfirm}
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.keyDown(card, { key: "Enter" });

      expect(onReorderConfirm).toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("isReordering=true の状態で Escape を押すと onReorderCancel が呼ばれる", () => {
      const onReorderCancel = vi.fn();
      render(
        <TaskCard
          challenge={challenge()}
          agentName="medical"
          isReordering
          onReorderCancel={onReorderCancel}
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.keyDown(card, { key: "Escape" });

      expect(onReorderCancel).toHaveBeenCalled();
    });

    it("isReordering=true の状態でカードが blur すると onReorderCancel が呼ばれる（フォーカス喪失時の見えないモード残留を防ぐ）", () => {
      const onReorderCancel = vi.fn();
      render(
        <TaskCard
          challenge={challenge()}
          agentName="medical"
          isReordering
          onReorderCancel={onReorderCancel}
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.blur(card);

      expect(onReorderCancel).toHaveBeenCalled();
    });

    it("isReordering=false のときに blur しても onReorderCancel は呼ばれない", () => {
      const onReorderCancel = vi.fn();
      render(
        <TaskCard
          challenge={challenge()}
          agentName="medical"
          onReorderCancel={onReorderCancel}
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.blur(card);

      expect(onReorderCancel).not.toHaveBeenCalled();
    });

    it("isReordering=false（既定）のとき、素の Enter は従来通り詳細モーダルを開く（回帰確認）", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
      const onReorderConfirm = vi.fn();

      render(
        <TaskCard
          challenge={challenge()}
          agentName="medical"
          onReorderConfirm={onReorderConfirm}
        />,
      );

      const card = screen.getByText("課題タイトル").closest(".task-card-body");
      if (!card) throw new Error("task-card-body が見つかりません");

      fireEvent.keyDown(card, { key: "Enter" });

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(onReorderConfirm).not.toHaveBeenCalled();
    });
  });
});

describe("TaskCard の承認ボタン（Issue #165・FR-20）", () => {
  const approvable = (overrides: Partial<Challenge> = {}): Challenge =>
    challenge({
      id: "C-010",
      status: "計画承認待ち",
      needsHuman: true,
      approvals: {
        plan: { checked: false, line: 9, label: "計画を承認（FR-13）" },
        completion: { checked: false, line: 10, label: "完了を承認（FR-32）" },
      },
      ...overrides,
    });

  it("計画承認待ちのカードに「計画を承認」ボタンを出す", () => {
    render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        onApprove={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "計画を承認" }),
    ).toBeInTheDocument();
  });

  it("完了確認待ちのカードには「完了を承認」ボタンを出す", () => {
    render(
      <TaskCard
        challenge={approvable({ status: "完了確認待ち" })}
        agentName="medical"
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
      <TaskCard
        challenge={approvable({ status: "人間対応待ち" })}
        agentName="medical"
        onApprove={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "計画を承認" }),
    ).not.toBeInTheDocument();
  });

  it("承認済み（[x]）のカードには承認ボタンを出さない", () => {
    render(
      <TaskCard
        challenge={approvable({
          approvals: {
            plan: { checked: true, line: 9, label: "計画を承認（FR-13）" },
          },
        })}
        agentName="medical"
        onApprove={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "計画を承認" }),
    ).not.toBeInTheDocument();
  });

  it("onApprove が未指定なら承認ボタンを出さない", () => {
    render(<TaskCard challenge={approvable()} agentName="medical" />);

    expect(
      screen.queryByRole("button", { name: "計画を承認" }),
    ).not.toBeInTheDocument();
  });

  it("読み取り専用（アーカイブ）では承認ボタンを出さない", () => {
    render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        readOnly
        onApprove={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "計画を承認" }),
    ).not.toBeInTheDocument();
  });

  it("1 クリック目では送信せず、確認を挟む（誤操作対策）", () => {
    const onApprove = vi.fn();
    render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));

    expect(onApprove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "承認する" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "やめる" })).toBeInTheDocument();
  });

  it("確認後の「承認する」で課題 ID と承認種別を送る", async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: true });
    render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));

    expect(onApprove).toHaveBeenCalledWith("C-010", "plan");
    // 承認が済んでも board 側の state は書き換えない（正本はファイル。台帳の
    // [x] は fs-watch → WS agent_update で戻ってくる）。ここでは呼び出し形だけ固定する。
    await screen.findByRole("button", { name: "計画を承認" });
  });

  it("「やめる」で送信せず元に戻る", () => {
    const onApprove = vi.fn();
    render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));

    expect(onApprove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "計画を承認" }),
    ).toBeInTheDocument();
  });

  it("失敗時はサーバのエラーメッセージをカード上に表示する", async () => {
    const onApprove = vi.fn().mockResolvedValue({
      ok: false,
      error: "このエージェントで run-cycle が実行中です",
    });
    render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "このエージェントで run-cycle が実行中です",
    );
  });

  it("承認ボタンはカードの中に描画される（#169）", () => {
    // 人間からの要望: 承認ボタンはカードの外（直下の兄弟）ではなくカードの中に
    // 置く。#168 の時点では兄弟に出していたが、#169 でカードを
    // 「コンテナ（.task-card）＋内側のクリック領域（.task-card-body）」に
    // 分けたことで、入れ子を作らずに中へ収められるようになった。
    render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        onApprove={vi.fn()}
      />,
    );

    const approveButton = screen.getByRole("button", { name: "計画を承認" });
    expect(approveButton.closest(".task-card")).not.toBeNull();
  });

  it("インタラクティブ要素の入れ子が無い（<button> の中に <button> を置かない）", () => {
    // #168 から引き継いだ意図。<button> の入れ子は不正な HTML で、キーボード
    // 操作・支援技術の挙動が壊れ、クリックが親へ伝播して意図しないモーダルが
    // 開く。#169 でカードをコンテナ＋クリック領域に分けたため、「承認ボタンが
    // カードの外にある」ことではなく「入れ子が無い」ことを直接固定する。
    // 承認の 2 段階（確認中）も入れ子を作らないことを、両フェーズで確認する。
    const { container } = render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        onApprove={vi.fn()}
      />,
    );

    const assertNoNestedButtons = () => {
      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.length).toBeGreaterThan(1);
      for (const button of buttons) {
        expect(button.querySelector("button")).toBeNull();
      }
      // カード本文のクリック領域（詳細モーダルを開く <button>）の中に
      // 承認導線が紛れ込んでいないことも直接確認する。
      expect(
        container.querySelector(".task-card-body .task-card-approval"),
      ).toBeNull();
    };

    assertNoNestedButtons();

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));

    assertNoNestedButtons();
  });

  it("承認ボタンを押しても詳細モーダルは開かない", () => {
    render(
      <TaskCard
        challenge={approvable()}
        agentName="medical"
        onApprove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "計画を承認" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
