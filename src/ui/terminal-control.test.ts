import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prefill,
  registerTerminalController,
  unregisterTerminalController,
} from "./terminal-control.ts";

afterEach(() => {
  // モジュールスコープのレジストリをテスト間で汚染しないよう明示的にクリアする。
  unregisterTerminalController({ prefill: () => {} });
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
});
