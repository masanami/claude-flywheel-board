import { EventEmitter } from "node:events";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FSWatcher } from "chokidar";
import { watch } from "chokidar";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryBoardCache } from "./cache.ts";
import type { FleetEntry } from "./manifest.ts";
import { startFleetWatcher } from "./watcher.ts";

vi.mock("chokidar", () => ({ watch: vi.fn() }));

const FIXTURES_ROOT = fileURLToPath(
  new URL("../../tests/fixtures/watcher/", import.meta.url),
);

class FakeFSWatcher extends EventEmitter {
  close = vi.fn().mockResolvedValue(undefined);
  add = vi.fn();
}

function mockChokidarWatch(): FakeFSWatcher {
  const fake = new FakeFSWatcher();
  vi.mocked(watch).mockReturnValue(fake as unknown as FSWatcher);
  return fake;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * condition が true になるまでポーリングする。固定 sleep 時間に依存した
 * デバウンス系テストの flaky 化を避けるため（CI の負荷に応じて実行時間が
 * ばらついても、条件成立を待てば十分な時間マージンを確保できる）。
 */
async function waitUntil(
  condition: () => boolean,
  { timeoutMs = 3000, intervalMs = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitUntil: タイムアウトしました（${timeoutMs}ms）`);
}

const agentA: FleetEntry = { name: "agent-a", path: `${FIXTURES_ROOT}agent-a` };
const agentB: FleetEntry = { name: "agent-b", path: `${FIXTURES_ROOT}agent-b` };
// Issue #121: 動的追加（addAgentWatch）のテスト専用に、起動時 entries には
// 含めない新規エージェント役の fixture を用意する。
const agentC: FleetEntry = { name: "agent-c", path: `${FIXTURES_ROOT}agent-c` };

beforeEach(() => {
  vi.mocked(watch).mockReset();
});

describe("startFleetWatcher", () => {
  it("chokidar.watch を全 repo の challenge-ledger.md / journal/index.jsonl / .flywheel/runs.jsonl / repo ディレクトリ自体（アーカイブ監視用）のパスで呼び出す（Issue #50 ①）", () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher(
      [agentA, agentB],
      cache,
      onAgentUpdate,
    );

    expect(watch).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = vi.mocked(watch).mock.calls[0] ?? [];
    expect(watchedPaths).toEqual([
      path.join(agentA.path, "challenge-ledger.md"),
      path.join(agentA.path, "journal", "index.jsonl"),
      path.join(agentA.path, ".flywheel", "runs.jsonl"),
      agentA.path,
      path.join(agentB.path, "challenge-ledger.md"),
      path.join(agentB.path, "journal", "index.jsonl"),
      path.join(agentB.path, ".flywheel", "runs.jsonl"),
      agentB.path,
    ]);
    // アーカイブ監視のため repo ディレクトリ自体を watch 対象に含めるが、
    // chokidar v5 は glob 非対応（v4 で撤廃済み）なので glob 文字列ではなく
    // 実ディレクトリパスを渡し、depth: 0 で再帰監視を防ぐ（repo 全体を
    // 監視してしまう regression を避ける）。
    expect(options).toMatchObject({ depth: 0 });

    void fleetWatcher.close();
    expect(fake.close).toHaveBeenCalled();
  });

  it("change イベント発火後、debounceMs 経過で該当 repo のみ再スキャンし onAgentUpdate を呼ぶ", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher(
      [agentA, agentB],
      cache,
      onAgentUpdate,
      { debounceMs: 30, fullRescanIntervalMs: 10 * 60 * 1000 },
    );

    fake.emit("change", path.join(agentA.path, "challenge-ledger.md"));

    // debounce 中はまだ再スキャンされない
    expect(onAgentUpdate).not.toHaveBeenCalled();

    await waitUntil(() => onAgentUpdate.mock.calls.length > 0);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate.mock.calls[0]?.[0]?.name).toBe("agent-a");
    // agent-b は変更されていないので再スキャンされない
    expect(cache.getSnapshot().agents.map((a) => a.name)).toEqual(["agent-a"]);

    await fleetWatcher.close();
  });

  it("unlink イベント（ファイル削除）でも該当 repo が再スキャンされる", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 30,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    fake.emit("unlink", path.join(agentA.path, "journal", "index.jsonl"));

    await waitUntil(() => onAgentUpdate.mock.calls.length > 0);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate.mock.calls[0]?.[0]?.name).toBe("agent-a");

    await fleetWatcher.close();
  });

  it("challenge-archive*.md の add イベント（新規アーカイブファイルの出現）で該当 repo が再スキャンされる（Issue #50 ①）", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 30,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    // 年次分割ファイル名でも、entry.path 直下であれば同一 repo として解決される。
    fake.emit("add", path.join(agentA.path, "challenge-archive-2026.md"));

    await waitUntil(() => onAgentUpdate.mock.calls.length > 0);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate.mock.calls[0]?.[0]?.name).toBe("agent-a");

    await fleetWatcher.close();
  });

  it("challenge-archive*.md の unlink イベントでも該当 repo が再スキャンされる（Issue #50 ①）", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 30,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    fake.emit("unlink", path.join(agentA.path, "challenge-archive.md"));

    await waitUntil(() => onAgentUpdate.mock.calls.length > 0);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate.mock.calls[0]?.[0]?.name).toBe("agent-a");

    await fleetWatcher.close();
  });

  it("debounce 時間内の連続変更は 1 回だけ再スキャンする", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 60,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    const ledgerPath = path.join(agentA.path, "challenge-ledger.md");
    fake.emit("change", ledgerPath);
    await sleep(20);
    fake.emit("change", ledgerPath);
    await sleep(20);
    fake.emit("change", ledgerPath);

    await waitUntil(() => onAgentUpdate.mock.calls.length > 0);
    // デバウンス後にさらに追加で呼ばれていないことを確認する猶予を取る。
    await sleep(100);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);

    await fleetWatcher.close();
  });

  it("fullRescanIntervalMs 経過ごとに全 repo をフル再スキャンする", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher(
      [agentA, agentB],
      cache,
      onAgentUpdate,
      { debounceMs: 10, fullRescanIntervalMs: 50 },
    );

    await waitUntil(() => onAgentUpdate.mock.calls.length >= 2);

    expect(onAgentUpdate.mock.calls.map((call) => call[0]?.name)).toEqual(
      expect.arrayContaining(["agent-a", "agent-b"]),
    );
    expect(
      cache
        .getSnapshot()
        .agents.map((a) => a.name)
        .sort(),
    ).toEqual(["agent-a", "agent-b"]);

    await fleetWatcher.close();
  });

  it("close() で chokidar watcher の close・低頻度フル再スキャンの interval・debounce タイマーが停止する", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 30,
      fullRescanIntervalMs: 40,
    });

    fake.emit("change", path.join(agentA.path, "challenge-ledger.md"));
    await fleetWatcher.close();

    expect(fake.close).toHaveBeenCalledTimes(1);

    onAgentUpdate.mockClear();
    // close 後は、デバウンス再スキャンもフル再スキャンの interval も発火しない
    await sleep(150);
    expect(onAgentUpdate).not.toHaveBeenCalled();
  });

  it("ready イベント発火後、全 repo を1回スキャンする（ignoreInitial による起動直後の変更漏れの整合対策）", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher(
      [agentA, agentB],
      cache,
      onAgentUpdate,
      { debounceMs: 10, fullRescanIntervalMs: 10 * 60 * 1000 },
    );

    expect(onAgentUpdate).not.toHaveBeenCalled();

    fake.emit("ready");

    await waitUntil(() => onAgentUpdate.mock.calls.length >= 2);

    expect(
      onAgentUpdate.mock.calls.map((call) => call[0]?.name).sort(),
    ).toEqual(["agent-a", "agent-b"]);
    expect(
      cache
        .getSnapshot()
        .agents.map((a) => a.name)
        .sort(),
    ).toEqual(["agent-a", "agent-b"]);

    await fleetWatcher.close();
  });

  it("chokidar の error イベントを受けても例外を投げない（監視失敗が起動全体を止めない）", () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate);

    expect(() =>
      fake.emit("error", new Error("permission denied")),
    ).not.toThrow();

    void fleetWatcher.close();
  });
});

describe("startFleetWatcher().addAgentWatch（Issue #121: 稼働中の watcher への動的追加）", () => {
  it("addAgentWatch 呼び出し後も chokidar.watch() は再呼び出しされない（既存監視ハンドルを再生成しない）", async () => {
    mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate);
    expect(watch).toHaveBeenCalledTimes(1);

    await fleetWatcher.addAgentWatch(agentC);

    expect(watch).toHaveBeenCalledTimes(1);

    await fleetWatcher.close();
  });

  it("addAgentWatch が chokidarWatcher.add() を新規 entry の ledger/journal/runs パス＋repo ディレクトリで呼ぶ", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate);

    await fleetWatcher.addAgentWatch(agentC);

    expect(fake.add).toHaveBeenCalledTimes(1);
    expect(fake.add).toHaveBeenCalledWith([
      path.join(agentC.path, "challenge-ledger.md"),
      path.join(agentC.path, "journal", "index.jsonl"),
      path.join(agentC.path, ".flywheel", "runs.jsonl"),
      agentC.path,
    ]);

    await fleetWatcher.close();
  });

  it("addAgentWatch 完了時点で新規 entry のみ初回スキャンされ onAgentUpdate が呼ばれる（既存 entry は再スキャンされない）", async () => {
    mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 10,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });
    onAgentUpdate.mockClear();

    await fleetWatcher.addAgentWatch(agentC);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate.mock.calls[0]?.[0]?.name).toBe("agent-c");
    expect(onAgentUpdate.mock.calls.map((call) => call[0]?.name)).not.toContain(
      "agent-a",
    );

    await fleetWatcher.close();
  });

  it("addAgentWatch 後、新規 entry の監視パスへの change イベントが該当 entry を再スキャンする", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 30,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    await fleetWatcher.addAgentWatch(agentC);
    onAgentUpdate.mockClear();

    fake.emit("change", path.join(agentC.path, "challenge-ledger.md"));

    await waitUntil(() => onAgentUpdate.mock.calls.length > 0);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate.mock.calls[0]?.[0]?.name).toBe("agent-c");

    await fleetWatcher.close();
  });

  it("close() 済みの watcher に addAgentWatch を呼ぶと拒否され、chokidar watcher は復活しない（close() 契約の維持）", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate);
    await fleetWatcher.close();

    await expect(fleetWatcher.addAgentWatch(agentC)).rejects.toThrow();
    expect(fake.add).not.toHaveBeenCalled();
  });

  it("addAgentWatch 後、新規 entry の repo ディレクトリ直下への challenge-archive*.md の add イベントが該当 entry を再スキャンする（entryByDir 経路。Issue #50 ①のアーカイブ検知が動的追加でも機能することの確認）", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 30,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    await fleetWatcher.addAgentWatch(agentC);
    onAgentUpdate.mockClear();

    fake.emit("add", path.join(agentC.path, "challenge-archive-2026.md"));

    await waitUntil(() => onAgentUpdate.mock.calls.length > 0);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate.mock.calls[0]?.[0]?.name).toBe("agent-c");

    await fleetWatcher.close();
  });

  it("addAgentWatch で追加した entry も低頻度フル再スキャンの対象に含まれる", async () => {
    mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 10,
      fullRescanIntervalMs: 50,
    });

    await fleetWatcher.addAgentWatch(agentC);
    onAgentUpdate.mockClear();

    await waitUntil(
      () =>
        onAgentUpdate.mock.calls.some((call) => call[0]?.name === "agent-a") &&
        onAgentUpdate.mock.calls.some((call) => call[0]?.name === "agent-c"),
    );

    await fleetWatcher.close();
  });
});
