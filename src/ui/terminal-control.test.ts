import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyAgentAddFailed,
  notifyAgentAddRequested,
  notifyAgentAdded,
  prefill,
  registerTerminalController,
  resetTerminalControllerForTest,
  unregisterTerminalController,
} from "./terminal-control.ts";
import type { TerminalController } from "./terminal-control.ts";

afterEach(() => {
  // モジュールスコープのレジストリをテスト間で汚染しないよう明示的にクリアする。
  //
  // 以前は `unregisterTerminalController({ prefill: () => {} })` のように毎回
  // 新規オブジェクトを渡していたが、unregisterTerminalController は「現在登録中
  // のものと一致する場合のみクリアする」契約のため、新規オブジェクトでは絶対に
  // 一致せず実際には何もクリアされていなかった（例えば「現在登録中のものと
  // 一致する場合のみクリアする」テストは、意図的に不一致な unregister を試みて
  // controllerA を登録したまま終わるため、次のテストへ汚染が漏れ得た）。
  // resetTerminalControllerForTest はテスト専用に「現在の登録内容を問わず」
  // 確実にレジストリを空にするため、こちらを使う。
  resetTerminalControllerForTest();
});

// Issue #125: TerminalController は markPendingNewAgent/clearPendingNewAgent も
// 実装が必須のため、テスト用フェイクを都度組み立てるヘルパーを用意する。
function buildFakeController(
  overrides: Partial<TerminalController> = {},
): TerminalController {
  return {
    prefill: vi.fn(),
    addAgent: vi.fn(),
    markPendingNewAgent: vi.fn(),
    clearPendingNewAgent: vi.fn(),
    ...overrides,
  };
}

describe("terminal-control", () => {
  it("登録済みコントローラの prefill を呼ぶ", () => {
    const controllerPrefill = vi.fn();
    registerTerminalController(
      buildFakeController({ prefill: controllerPrefill }),
    );

    prefill("medical", "echo hi");

    expect(controllerPrefill).toHaveBeenCalledWith("medical", "echo hi");
  });

  it("未登録時は何もしない（例外を投げない）", () => {
    expect(() => {
      prefill("medical", "echo hi");
    }).not.toThrow();
  });

  it("unregisterTerminalController は現在登録中のものと一致する場合のみクリアする", () => {
    const controllerA = buildFakeController();
    const controllerB = buildFakeController();

    registerTerminalController(controllerA);
    // B は現在登録されていないため、unregister しても A は残る。
    unregisterTerminalController(controllerB);

    prefill("medical", "echo hi");

    expect(controllerA.prefill).toHaveBeenCalledWith("medical", "echo hi");
    expect(controllerB.prefill).not.toHaveBeenCalled();
  });

  it("登録中のコントローラを unregister すると以後 prefill は何もしない", () => {
    const controller = buildFakeController();
    registerTerminalController(controller);
    unregisterTerminalController(controller);

    prefill("medical", "echo hi");

    expect(controller.prefill).not.toHaveBeenCalled();
  });

  it("resetTerminalControllerForTest は、現在何が登録されていても確実にレジストリをクリアする（afterEach からの後始末用）", () => {
    // unregisterTerminalController は「一致する場合のみクリアする」契約のため、
    // 呼び出し元が登録済みインスタンスの参照を持っていない場合（テストの
    // afterEach 等）はクリアできない。resetTerminalControllerForTest は
    // 現在の登録内容を問わず必ず空にする。
    const controller = buildFakeController();
    registerTerminalController(controller);

    resetTerminalControllerForTest();

    prefill("medical", "echo hi");

    expect(controller.prefill).not.toHaveBeenCalled();
  });

  it("登録済みコントローラの addAgent を呼ぶ（Issue #124: agent_update 起点のタブ一覧反映）", () => {
    const controllerAddAgent = vi.fn();
    registerTerminalController(
      buildFakeController({ addAgent: controllerAddAgent }),
    );

    notifyAgentAdded("harness-guardian");

    expect(controllerAddAgent).toHaveBeenCalledWith("harness-guardian");
  });

  it("未登録時に notifyAgentAdded を呼んでも何もしない（例外を投げない）", () => {
    expect(() => {
      notifyAgentAdded("harness-guardian");
    }).not.toThrow();
  });

  it("登録済みコントローラの markPendingNewAgent を呼ぶ（Issue #125: エージェント追加フォーム送信起点の新規マーク）", () => {
    const controllerMark = vi.fn();
    registerTerminalController(
      buildFakeController({ markPendingNewAgent: controllerMark }),
    );

    notifyAgentAddRequested("harness-guardian");

    expect(controllerMark).toHaveBeenCalledWith("harness-guardian");
  });

  it("未登録時に notifyAgentAddRequested を呼んでも何もしない（例外を投げない）", () => {
    expect(() => {
      notifyAgentAddRequested("harness-guardian");
    }).not.toThrow();
  });

  it("登録済みコントローラの clearPendingNewAgent を呼ぶ（Issue #125: 追加失敗時のマーク取り消し）", () => {
    const controllerClear = vi.fn();
    registerTerminalController(
      buildFakeController({ clearPendingNewAgent: controllerClear }),
    );

    notifyAgentAddFailed("harness-guardian");

    expect(controllerClear).toHaveBeenCalledWith("harness-guardian");
  });

  it("未登録時に notifyAgentAddFailed を呼んでも何もしない（例外を投げない）", () => {
    expect(() => {
      notifyAgentAddFailed("harness-guardian");
    }).not.toThrow();
  });
});
