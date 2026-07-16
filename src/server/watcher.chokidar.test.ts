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

beforeEach(() => {
  vi.mocked(watch).mockReset();
});

describe("startFleetWatcher", () => {
  it("chokidar.watch を全 repo の challenge-ledger.md / journal/index.jsonl パスで呼び出す", () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    const fleetWatcher = startFleetWatcher(
      [agentA, agentB],
      cache,
      onAgentUpdate,
    );

    expect(watch).toHaveBeenCalledTimes(1);
    const [watchedPaths] = vi.mocked(watch).mock.calls[0] ?? [];
    expect(watchedPaths).toEqual([
      path.join(agentA.path, "challenge-ledger.md"),
      path.join(agentA.path, "journal", "index.jsonl"),
      path.join(agentB.path, "challenge-ledger.md"),
      path.join(agentB.path, "journal", "index.jsonl"),
    ]);

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
