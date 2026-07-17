import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prefill,
  registerTerminalController,
  resetTerminalControllerForTest,
  unregisterTerminalController,
} from "./terminal-control.ts";

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

describe("terminal-control", () => {
  it("登録済みコントローラの prefill を呼ぶ", () => {
    const controllerPrefill = vi.fn();
    registerTerminalController({ prefill: controllerPrefill });

    prefill("medical", "echo hi");

    expect(controllerPrefill).toHaveBeenCalledWith("medical", "echo hi");
  });

  it("未登録時は何もしない（例外を投げない）", () => {
    expect(() => {
      prefill("medical", "echo hi");
    }).not.toThrow();
  });

  it("unregisterTerminalController は現在登録中のものと一致する場合のみクリアする", () => {
    const controllerA = { prefill: vi.fn() };
    const controllerB = { prefill: vi.fn() };

    registerTerminalController(controllerA);
    // B は現在登録されていないため、unregister しても A は残る。
    unregisterTerminalController(controllerB);

    prefill("medical", "echo hi");

    expect(controllerA.prefill).toHaveBeenCalledWith("medical", "echo hi");
    expect(controllerB.prefill).not.toHaveBeenCalled();
  });

  it("登録中のコントローラを unregister すると以後 prefill は何もしない", () => {
    const controller = { prefill: vi.fn() };
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
    const controller = { prefill: vi.fn() };
    registerTerminalController(controller);

    resetTerminalControllerForTest();

    prefill("medical", "echo hi");

    expect(controller.prefill).not.toHaveBeenCalled();
  });
});
