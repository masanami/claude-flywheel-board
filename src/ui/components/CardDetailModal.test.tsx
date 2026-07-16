import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Challenge, LogEntry } from "../board-types.ts";
import { CardDetailModal } from "./CardDetailModal.tsx";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CardDetailModal", () => {
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

  it("source バッジは data-source 属性で journal / ledger を出し分ける", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            logEntry({ source: "journal", text: "journal 由来" }),
            logEntry({ source: "ledger", text: "ledger 由来" }),
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
      expect(container.querySelectorAll("[data-source]")).toHaveLength(2);
    });
    expect(
      container.querySelector('[data-source="journal"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-source="ledger"]'),
    ).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("dialog"));

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

    // テキスト選択のドラッグ操作等で mousedown はダイアログ内、
    // click イベント自体はオーバーレイ上で確定するケースを模す。
    fireEvent.mouseDown(screen.getByRole("dialog"));
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
});
