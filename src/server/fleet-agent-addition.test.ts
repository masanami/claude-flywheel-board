import { describe, expect, it, vi } from "vitest";
import { addFleetEntry } from "./fleet-agent-addition.ts";
import type { FleetEntry, GetFleetEntries } from "./manifest.ts";
import type { FleetWatcher } from "./watcher.ts";

// Issue #121: HTTP/WS/pty/watcher の4系統が共有する fleetEntries 配列へ新規
// entry を追加し、稼働中の fleetWatcher にも動的追加する「再構築機構」。
// loadFleetManifest() を再度呼び出さないことが不変条件（本テストでは
// fleetWatcher をモックで差し替えるため実 chokidar には触れない）。
//
// 配置場所（Issue #122 セルフレビュー指摘対応）: 実装が index.ts から
// fleet-agent-addition.ts へ切り出された（api.ts からも再利用するため）のに
// 合わせ、テストもここへ移す（元は index.test.ts。ファイル名とテスト対象の
// 対応を保つ）。
describe("addFleetEntry（Issue #121: fleetEntries 共有配列への動的追加）", () => {
  function createFakeFleetWatcher(): FleetWatcher & {
    addAgentWatch: ReturnType<typeof vi.fn>;
  } {
    return {
      addAgentWatch: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("fleetEntries 配列へ新規 entry を push する", async () => {
    const fleetEntries: FleetEntry[] = [{ name: "agent-a", path: "/repos/a" }];
    const fleetWatcher = createFakeFleetWatcher();
    const newEntry: FleetEntry = { name: "agent-b", path: "/repos/b" };

    await addFleetEntry(fleetEntries, fleetWatcher, newEntry);

    expect(fleetEntries).toEqual([
      { name: "agent-a", path: "/repos/a" },
      { name: "agent-b", path: "/repos/b" },
    ]);
  });

  it("fleetWatcher.addAgentWatch を新規 entry で呼ぶ", async () => {
    const fleetEntries: FleetEntry[] = [];
    const fleetWatcher = createFakeFleetWatcher();
    const newEntry: FleetEntry = { name: "agent-b", path: "/repos/b" };

    await addFleetEntry(fleetEntries, fleetWatcher, newEntry);

    expect(fleetWatcher.addAgentWatch).toHaveBeenCalledTimes(1);
    expect(fleetWatcher.addAgentWatch).toHaveBeenCalledWith(newEntry);
  });

  // 注意（セルフレビュー指摘対応）: このテストは addFleetEntry と同じ配列
  // 参照を返すクロージャ（`() => fleetEntries`。Issue #62 の getFleetEntries と
  // 同型）が push 後に新 entry を含むことを確認するものであり、本番の
  // HTTP/WS/pty 経路の配線そのもの（isMainModule ブロック内・テストから
  // 到達不可）を検証するものではない。「fleetEntries 配列へ push する」テスト
  // と条件は同一だが、getFleetEntries と同型のクロージャ越しに見ても取りこぼしが
  // 無いこと（同一配列参照であること）を明示的に確認する。
  it("push 後、fleetEntries と同一配列参照を返す getFleetEntries 型クロージャ経由でも新 entry が見える（同一参照であることの確認）", async () => {
    const fleetEntries: FleetEntry[] = [{ name: "agent-a", path: "/repos/a" }];
    const getFleetEntries: GetFleetEntries = () => fleetEntries;
    const fleetWatcher = createFakeFleetWatcher();
    const newEntry: FleetEntry = { name: "agent-b", path: "/repos/b" };

    expect(getFleetEntries()).toEqual([{ name: "agent-a", path: "/repos/a" }]);

    await addFleetEntry(fleetEntries, fleetWatcher, newEntry);

    expect(getFleetEntries()).toEqual([
      { name: "agent-a", path: "/repos/a" },
      { name: "agent-b", path: "/repos/b" },
    ]);
  });
});
