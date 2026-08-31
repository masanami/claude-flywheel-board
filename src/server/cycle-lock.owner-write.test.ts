import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 所有者メタデータの書き込み失敗（上流 cycle-lock.sh の exit 4）だけを検証する
// ため、この 1 観点を専用ファイルへ分ける。`node:fs` の ESM 名前空間は
// 再定義できず vi.spyOn が使えないため、モジュール単位のモックが必要になる。
//
// なぜこの経路を固定するのか: メタデータの無いロックが残ると、以後の acquire は
// board も run-cycle も「所有者不明・mtime 2 時間以内」の分岐へ落ち、**最長 2 時間
// ブロックされる**。ロックを取れたが owner を書けなかったときに必ず解除することが、
// このプロトコルで最も落としてはいけない後始末である。
const state = { failWrite: false, removed: [] as string[] };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (state.failWrite) {
        throw new Error("EACCES: permission denied, open 'owner'");
      }
      return actual.writeFileSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      state.removed.push(String(args[0]));
      return actual.rmSync(...args);
    },
  };
});

const { acquireCycleLock, cycleLockPathFor } = await import("./cycle-lock.ts");
const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
const os = await import("node:os");

let workspace: string;

beforeEach(() => {
  state.failWrite = false;
  state.removed = [];
  workspace = fsActual.mkdtempSync(
    path.join(os.tmpdir(), "board-cycle-lock-owner-"),
  );
});

afterEach(() => {
  fsActual.rmSync(workspace, { recursive: true, force: true });
});

describe("acquireCycleLock（所有者メタデータの書き込み失敗）", () => {
  it("owner を書けなかったらロックを解除して中止する（メタ無しロックを残さない）", () => {
    state.failWrite = true;

    const result = acquireCycleLock(workspace, { sessionId: "s-1" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ロックを解除して中止");
    }
    expect(state.removed).toContain(cycleLockPathFor(workspace));
    expect(fsActual.existsSync(cycleLockPathFor(workspace))).toBe(false);
  });

  it("owner を書けた場合はロックが残る（対照）", () => {
    const result = acquireCycleLock(workspace, { sessionId: "s-1" });

    expect(result.ok).toBe(true);
    expect(fsActual.existsSync(cycleLockPathFor(workspace))).toBe(true);
  });
});
