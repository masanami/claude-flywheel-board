import { describe, expect, it } from "vitest";
import type { FleetEntry } from "../manifest.ts";
import { resolveAgentEntry, terminalSessionName } from "./session.ts";

describe("terminalSessionName", () => {
  it("flywheel-<name> を返す", () => {
    expect(terminalSessionName("medical")).toBe("flywheel-medical");
  });

  it("エージェント名をそのまま埋め込む（サニタイズはしない仕様）", () => {
    expect(terminalSessionName("legal-agent")).toBe("flywheel-legal-agent");
  });

  it("kind 省略時は agent 扱いで従来どおりの名前を返す（後方互換）", () => {
    expect(terminalSessionName("medical")).toBe(
      terminalSessionName("medical", "agent"),
    );
  });

  it("kind: 'shell' を指定すると -shell サフィックス付きの名前を返す（#57 手動シェル用セッション）", () => {
    expect(terminalSessionName("medical", "shell")).toBe(
      "flywheel-medical-shell",
    );
  });
});

describe("resolveAgentEntry", () => {
  const entries: FleetEntry[] = [
    { name: "medical", path: "/repos/medical-agent" },
    { name: "legal", path: "/repos/legal-agent" },
  ];

  it("マニフェストに登録された name に一致する entry を返す", () => {
    expect(resolveAgentEntry(entries, "medical")).toEqual({
      name: "medical",
      path: "/repos/medical-agent",
    });
  });

  it("未登録の name は undefined を返す（任意パスでのセッション生成不可）", () => {
    expect(resolveAgentEntry(entries, "unknown-agent")).toBeUndefined();
  });

  it("agent クエリが null の場合は undefined を返す", () => {
    expect(resolveAgentEntry(entries, null)).toBeUndefined();
  });

  it("agent クエリが空文字の場合は undefined を返す", () => {
    expect(resolveAgentEntry(entries, "")).toBeUndefined();
  });
});
