import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Challenge, LogEntry, Run } from "../board-types.ts";
import { prefill } from "../terminal-control.ts";
import { CardDetailModal } from "./CardDetailModal.tsx";

vi.mock("../terminal-control.ts", () => ({
  prefill: vi.fn(),
}));

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "C-001",
    title: "課題タイトル",
    status: "着手中",
    priority: "P1",
    position: "medical",
    needsHuman: false,
    summary: "直近の作業要約",
    ...overrides,
  };
}

function logEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: "2026-07-16T09:00:00Z",
    source: "journal",
    text: "着手中 → 検証中",
    ...overrides,
  };
}

function delegateRun(overrides: Partial<Run> = {}): Run {
  return {
    kind: "delegate",
    key: "session-1",
    challenge: "C-001",
    repo: "org/service-a",
    startedAt: "2026-07-16T09:00:00.000Z",
    stale: true,
    ...overrides,
  };
}

function delegateProvenance(
  overrides: Partial<Run["provenance"]> = {},
): NonNullable<Run["provenance"]> {
  return {
    file: ".flywheel/runs.jsonl",
    event: "delegate_start",
    ts: "2026-07-16T09:00:00.000Z",
    key: "session-1",
    raw: '{"event":"delegate_start","ts":"2026-07-16T09:00:00.000Z","session_id":"session-1"}',
    hasEnd: true,
    ...overrides,
  };
}

function adhocRun(overrides: Partial<Run> = {}): Run {
  return {
    kind: "adhoc",
    key: "adhoc-1",
    challenge: "C-001",
    title: "アドホック作業",
    startedAt: "2026-07-16T09:00:00.000Z",
    stale: false,
    ...overrides,
  };
}

function adhocProvenance(
  overrides: Partial<Run["provenance"]> = {},
): NonNullable<Run["provenance"]> {
  return {
    file: ".flywheel/runs.jsonl",
    event: "adhoc_start",
    ts: "2026-07-16T09:10:00.000Z",
    key: "adhoc-1",
    raw: '{"event":"adhoc_start","ts":"2026-07-16T09:10:00.000Z","id":"adhoc-1"}',
    hasEnd: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(prefill).mockClear();
});

describe("CardDetailModal", () => {
  it("StrictMode（effect の setup → cleanup → setup 二重実行）でも InvalidStateError にならず開く", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    expect(() =>
      render(
        <StrictMode>
          <CardDetailModal
            challenge={challenge()}
            agentName="medical"
            onClose={vi.fn()}
          />
        </StrictMode>,
      ),
    ).not.toThrow();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("台帳の全項目を表示する", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(
      <CardDetailModal
        challenge={challenge({
          id: "C-042",
          title: "詳細タイトル",
          status: "検証中",
          priority: "P1",
          position: "medical",
          needsHuman: true,
          summary: "要約テキスト",
        })}
        agentName="medical"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("C-042")).toBeInTheDocument();
    expect(screen.getAllByText("詳細タイトル").length).toBeGreaterThan(0);
    expect(screen.getByText("検証中")).toBeInTheDocument();
    expect(screen.getByText("P1")).toBeInTheDocument();
    expect(screen.getByText("medical")).toBeInTheDocument();
    expect(screen.getByText("要約テキスト")).toBeInTheDocument();
  });

  it("マウント時に GET /api/log?agent=<agentName>&challenge=<id> を呼び出す", () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CardDetailModal
        challenge={challenge({ id: "C-007" })}
        agentName="bi"
        onClose={vi.fn()}
      />,
    );

    expect(fetchMock).toHaveBeenCalledWith("/api/log?agent=bi&challenge=C-007");
  });

  it("フェッチ中はローディング表示をする", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/読み込み中/)).toBeInTheDocument();
  });

  it("フェッチ成功時に作業ログを ts / source バッジ / text のタイムラインで表示する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            logEntry({ ts: "2026-07-16T09:00:00Z", text: "着手中 → 検証中" }),
          ]),
      }),
    );

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("2026-07-16T09:00:00Z")).toBeInTheDocument();
    });
    expect(screen.getByText("着手中 → 検証中")).toBeInTheDocument();
  });

  it("source バッジは data-source 属性で journal / ledger / runs を出し分ける", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            logEntry({ source: "journal", text: "journal 由来" }),
            logEntry({ source: "ledger", text: "ledger 由来" }),
            logEntry({ source: "runs", text: "runs 由来" }),
          ]),
      }),
    );

    const { container } = render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll("[data-source]")).toHaveLength(3);
    });
    expect(
      container.querySelector('[data-source="journal"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-source="ledger"]'),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-source="runs"]')).toBeInTheDocument();
    expect(screen.getByText("runs 由来")).toBeInTheDocument();
  });

  it("フェッチ失敗時にエラー表示をする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/取得に失敗/)).toBeInTheDocument();
    });
  });

  it("開いたら閉じるボタンにフォーカスが当たる（フォーカス管理）", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "閉じる" })).toHaveFocus();
  });

  it("ESC キーで onClose が呼ばれる", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const onClose = vi.fn();

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("オーバーレイクリックで onClose が呼ばれる", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const onClose = vi.fn();

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={onClose}
      />,
    );

    // 実ブラウザでのクリックは mousedown → click の順でイベントが発火するため、
    // 実装側の「押下と確定が両方オーバーレイ上」判定に合わせて両方 fire する。
    const overlay = screen.getByTestId("modal-overlay");
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);

    expect(onClose).toHaveBeenCalled();
  });

  it("モーダル内クリックでは onClose が呼ばれない", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const onClose = vi.fn();

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={onClose}
      />,
    );

    // dialog 要素自体は role="dialog"（オーバーレイ相当）を兼ねるため、
    // 内側のコンテンツラッパーへのクリックであることを確認する。
    fireEvent.click(screen.getByTestId("card-detail-content"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("ダイアログ内で押下を開始しオーバーレイ上でクリックが確定しても onClose は呼ばれない（テキスト選択ドラッグの誤爆防止）", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    const onClose = vi.fn();

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={onClose}
      />,
    );

    // テキスト選択のドラッグ操作等で mousedown はダイアログ内コンテンツ、
    // click イベント自体はオーバーレイ（dialog 自身）上で確定するケースを模す。
    fireEvent.mouseDown(screen.getByTestId("card-detail-content"));
    fireEvent.click(screen.getByTestId("modal-overlay"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("編集・承認等の操作ボタンを持たない（読み取り専用・NFR-01）", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(
      <CardDetailModal
        challenge={challenge()}
        agentName="medical"
        onClose={vi.fn()}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("閉じる");
  });

  describe("再開コマンドの prefill 連携（#31・FR-12）", () => {
    it("対象課題に stale な delegate run がある場合、resumebox にコマンド文字列を表示する", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[delegateRun({ challenge: "C-001" })]}
        />,
      );

      expect(screen.getByTestId("resumebox")).toBeInTheDocument();
      expect(
        screen.getByDisplayValue(
          "cd .flywheel/repos/org/service-a && claude -p --resume session-1",
        ),
      ).toBeInTheDocument();
    });

    it("resumebox の見出し文言は「更新なし（要確認）」に統一されている（Issue #154 で断定表現「応答なし」から変更。stale は data 属性/内部名にのみ残す）", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[delegateRun({ challenge: "C-001" })]}
        />,
      );

      expect(
        screen.getByText(
          "⚠ 更新なし（要確認）のセッションがあります。再開コマンドをタブに挿入できます",
        ),
      ).toBeInTheDocument();
    });

    it("「タブにプリフィル」ボタンをクリックすると agent 名と resume コマンド文字列で prefill が呼ばれる", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[
            delegateRun({ challenge: "C-001", key: "session-xyz" }),
          ]}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "タブにプリフィル" }));

      expect(prefill).toHaveBeenCalledWith(
        "medical",
        "cd .flywheel/repos/org/service-a && claude -p --resume session-xyz",
      );
    });

    it("runningRuns が未指定の場合は resumebox を表示しない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
        />,
      );

      expect(screen.queryByTestId("resumebox")).not.toBeInTheDocument();
    });

    it("runningRuns が空配列の場合は resumebox を表示しない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[]}
        />,
      );

      expect(screen.queryByTestId("resumebox")).not.toBeInTheDocument();
    });

    it("stale ではない delegate run しか無い場合は resumebox を表示しない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[delegateRun({ challenge: "C-001", stale: false })]}
        />,
      );

      expect(screen.queryByTestId("resumebox")).not.toBeInTheDocument();
    });

    it("別の課題向けの stale delegate run しか無い場合は resumebox を表示しない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[delegateRun({ challenge: "C-999" })]}
        />,
      );

      expect(screen.queryByTestId("resumebox")).not.toBeInTheDocument();
    });

    it("repo が欠落している stale delegate run しか無い場合は resumebox を表示しない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[delegateRun({ challenge: "C-001", repo: undefined })]}
        />,
      );

      expect(screen.queryByTestId("resumebox")).not.toBeInTheDocument();
    });

    it("runningRuns があっても既存の「操作ボタンは閉じるのみ」以外は増えない場合、resumebox が無ければボタン数は1のまま", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[delegateRun({ challenge: "C-999" })]}
        />,
      );

      expect(screen.getAllByRole("button")).toHaveLength(1);
    });
  });

  describe("取得元表示（provenance。#85・#96 FR-A1/FR-A3/FR-A4/FR-A5）", () => {
    it("delegate run の provenance が file/event/ts/key で表示される（行番号は含まれない）", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[
            delegateRun({
              challenge: "C-001",
              provenance: delegateProvenance(),
            }),
          ]}
        />,
      );

      expect(screen.getByText(".flywheel/runs.jsonl")).toBeInTheDocument();
      expect(screen.getByText("delegate_start")).toBeInTheDocument();
      expect(screen.getByText("2026-07-16T09:00:00.000Z")).toBeInTheDocument();
      expect(screen.getByText("session-1")).toBeInTheDocument();
      expect(screen.queryByText(/行\d+/)).not.toBeInTheDocument();
    });

    it("adhoc run の provenance が file/event/ts/key で表示される", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[
            adhocRun({ challenge: "C-001", provenance: adhocProvenance() }),
          ]}
        />,
      );

      expect(screen.getByText(".flywheel/runs.jsonl")).toBeInTheDocument();
      expect(screen.getByText("adhoc_start")).toBeInTheDocument();
      expect(screen.getByText("2026-07-16T09:10:00.000Z")).toBeInTheDocument();
      expect(screen.getByText("adhoc-1")).toBeInTheDocument();
    });

    it("未終了 delegate_start（hasEnd: false）の場合「対応する delegate_end なし」相当が表示される", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[
            delegateRun({
              challenge: "C-001",
              provenance: delegateProvenance({ hasEnd: false }),
            }),
          ]}
        />,
      );

      expect(screen.getByText(/delegate_end.*なし/)).toBeInTheDocument();
    });

    it("未終了 adhoc_start（hasEnd: false）の場合「対応する adhoc_end なし」相当が表示される", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[
            adhocRun({
              challenge: "C-001",
              provenance: adhocProvenance({ hasEnd: false }),
            }),
          ]}
        />,
      );

      expect(screen.getByText(/adhoc_end.*なし/)).toBeInTheDocument();
    });

    it("provenance を持つ run が無い場合は取得元セクションを表示しない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[delegateRun({ challenge: "C-001" })]}
        />,
      );

      expect(screen.queryByTestId("raw-record")).not.toBeInTheDocument();
    });

    it("runningRuns が未指定の場合は取得元セクションを表示しない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
        />,
      );

      expect(screen.queryByTestId("raw-record")).not.toBeInTheDocument();
    });

    it("別の課題向けの provenance 付き run しか無い場合は取得元セクションを表示しない（課題フィルタの回帰検知）", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[
            delegateRun({
              challenge: "C-999",
              provenance: delegateProvenance(),
            }),
          ]}
        />,
      );

      expect(screen.queryByTestId("raw-record")).not.toBeInTheDocument();
      expect(screen.queryByText("session-1")).not.toBeInTheDocument();
    });

    it("元レコード展開セクション（data-testid=raw-record）を展開すると生 JSON 1 行がそのまま表示される", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
      const raw =
        '{"event":"delegate_start","ts":"2026-07-16T09:00:00.000Z","session_id":"session-1"}';

      render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[
            delegateRun({
              challenge: "C-001",
              provenance: delegateProvenance({ raw }),
            }),
          ]}
        />,
      );

      const rawRecord = screen.getByTestId("raw-record");
      expect(within(rawRecord).queryByText(raw)).not.toBeInTheDocument();

      fireEvent.click(within(rawRecord).getByRole("button"));

      expect(within(rawRecord).getByText(raw)).toBeInTheDocument();
    });
  });

  describe("課題台帳セクション（#94・#96・#102: challenge prop を直接表示）", () => {
    // FR-B2 が要求するタイトル・優先度・ステータスは、常時表示される既存の
    // <dl className="card-detail-fields">（challenge prop 由来）で既に満たされ
    // ているため、台帳セクション自体は新規追加項目（説明・完了条件・タスク案）
    // のみを表示する（重複表示を避けるため）。#102 の設計変更により、台帳
    // セクションは agent prop 経由の join を行わず、challenge prop を直接表示
    // する（CardDetailModal は台帳カードから開かれるため、表示すべき台帳
    // エントリは challenge prop として既に手元にある）。
    it("challenge の説明・完了条件・タスク案が表示され、タイトル・優先度・ステータスは既存の card-detail-fields 表示で満たされる", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({
            id: "C-001",
            status: "検証中",
            priority: "P2",
            description: "背景説明テキスト",
            completionCriteria: "完了条件テキスト",
            taskPlan: "タスク案テキスト",
          })}
          agentName="medical"
          onClose={vi.fn()}
        />,
      );

      const ledgerJoin = screen.getByTestId("ledger-join");
      expect(
        within(ledgerJoin).getByText("背景説明テキスト"),
      ).toBeInTheDocument();
      expect(
        within(ledgerJoin).getByText("完了条件テキスト"),
      ).toBeInTheDocument();
      expect(
        within(ledgerJoin).getByText("タスク案テキスト"),
      ).toBeInTheDocument();
      // タイトル・優先度・ステータスはカード詳細内（既存 dl）に表示されている
      // （タイトルは見出し h2 とも重複するため複数一致を許容する）。
      expect(screen.getAllByText("課題タイトル").length).toBeGreaterThan(0);
      expect(screen.getByText("P2")).toBeInTheDocument();
      expect(screen.getByText("検証中")).toBeInTheDocument();
    });

    it("台帳セクションは常に表示される（challenge prop は必須のため「見つかりません」分岐は無い）", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({
            id: "C-001",
            title: "台帳タイトル",
            description: "説明本文",
          })}
          agentName="medical"
          onClose={vi.fn()}
        />,
      );

      expect(screen.getByTestId("ledger-join")).toBeInTheDocument();
      expect(screen.getByText("説明本文")).toBeInTheDocument();
    });

    it("説明・完了条件・タスク案が無い課題は半角ハイフンで表示される", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      render(
        <CardDetailModal
          challenge={challenge({
            id: "C-001",
            description: undefined,
            completionCriteria: undefined,
            taskPlan: undefined,
          })}
          agentName="medical"
          onClose={vi.fn()}
        />,
      );

      const ledgerJoin = screen.getByTestId("ledger-join");
      expect(
        within(ledgerJoin).getAllByText("-").length,
      ).toBeGreaterThanOrEqual(3);
    });
  });

  describe("HTML/スクリプト断片のプレーンテキスト表示（AC-8）", () => {
    it("台帳の説明にHTML/スクリプト断片が含まれてもプレーンテキストとして表示され、実行・解釈されない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
      const malicious = "<script>window.__xss = true;</script><img src=x>";

      const { container } = render(
        <CardDetailModal
          challenge={challenge({ id: "C-001", description: malicious })}
          agentName="medical"
          onClose={vi.fn()}
        />,
      );

      expect(screen.getByText(malicious)).toBeInTheDocument();
      expect(container.querySelector("script")).not.toBeInTheDocument();
      expect(container.querySelector("img")).not.toBeInTheDocument();
    });

    it("元レコードにHTML/スクリプト断片が含まれてもプレーンテキストとして表示され、実行・解釈されない", () => {
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
      const rawWithScript =
        '{"event":"delegate_start","note":"<script>window.__xss = true;</script>"}';

      const { container } = render(
        <CardDetailModal
          challenge={challenge({ id: "C-001" })}
          agentName="medical"
          onClose={vi.fn()}
          runningRuns={[
            delegateRun({
              challenge: "C-001",
              provenance: delegateProvenance({ raw: rawWithScript }),
            }),
          ]}
        />,
      );

      fireEvent.click(
        within(screen.getByTestId("raw-record")).getByRole("button"),
      );

      expect(screen.getByText(rawWithScript)).toBeInTheDocument();
      expect(container.querySelector("script")).not.toBeInTheDocument();
    });
  });
});
