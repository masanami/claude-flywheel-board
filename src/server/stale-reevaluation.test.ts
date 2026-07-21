import { describe, expect, it, vi } from "vitest";
import type { AgentBoard } from "./cache.ts";
import { startStaleReevaluation } from "./stale-reevaluation.ts";

describe("startStaleReevaluation", () => {
  function agentBoard(overrides: Partial<AgentBoard> = {}): AgentBoard {
    return {
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [],
      parseErrors: [],
      cycleStatus: "idle",
      runningRuns: [],
      archivedChallenges: [],
      ...overrides,
    };
  }

  function fakeCache(snapshots: () => AgentBoard[]): {
    replaceAgent: () => void;
    replaceJournal: () => void;
    replaceRuns: () => void;
    getChallenge: () => undefined;
    getLog: () => [];
    getSnapshot: () => { agents: AgentBoard[] };
  } {
    return {
      replaceAgent: () => undefined,
      replaceJournal: () => undefined,
      replaceRuns: () => undefined,
      getChallenge: () => undefined,
      getLog: () => [],
      getSnapshot: () => ({ agents: snapshots() }),
    };
  }

  it("intervalMs ごとに cache.getSnapshot(now) を呼び、cycleStatus/runningRuns の変化があるエージェントのみ onAgentUpdate を呼ぶ", () => {
    let tick = 0;
    const cache = fakeCache(() => {
      tick += 1;
      if (tick === 1) {
        return [agentBoard({ name: "medical", cycleStatus: "idle" })];
      }
      return [agentBoard({ name: "medical", cycleStatus: "running" })];
    });
    const onAgentUpdate = vi.fn();

    let scheduled: (() => void) | undefined;
    const setIntervalFn = vi.fn((handler: () => void) => {
      scheduled = handler;
      return 1 as unknown as NodeJS.Timeout;
    });
    const clearIntervalFn = vi.fn();

    const timer = startStaleReevaluation(cache, onAgentUpdate, {
      setIntervalFn,
      clearIntervalFn,
    });

    // 初回スナップショット取得直後（コンストラクション時点）はまだ push しない。
    expect(onAgentUpdate).not.toHaveBeenCalled();

    scheduled?.();

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "medical", cycleStatus: "running" }),
    );

    timer.close();
  });

  it("変化が無いエージェントは onAgentUpdate を呼ばない", () => {
    const cache = fakeCache(() => [
      agentBoard({ name: "medical", cycleStatus: "idle" }),
    ]);
    const onAgentUpdate = vi.fn();

    let scheduled: (() => void) | undefined;
    const setIntervalFn = vi.fn((handler: () => void) => {
      scheduled = handler;
      return 1 as unknown as NodeJS.Timeout;
    });
    const clearIntervalFn = vi.fn();

    const timer = startStaleReevaluation(cache, onAgentUpdate, {
      setIntervalFn,
      clearIntervalFn,
    });

    scheduled?.();
    scheduled?.();

    expect(onAgentUpdate).not.toHaveBeenCalled();

    timer.close();
  });

  it("実行中 run があるエージェントは分が進むごとに push される（経過時間表示の更新前提。UI はクライアント側タイマーを持たない）", () => {
    const startedAt = "2026-07-18T10:00:00+09:00";
    const cache = fakeCache(() => [
      agentBoard({
        name: "medical",
        cycleStatus: "running",
        runningRuns: [
          {
            kind: "delegate",
            key: "session-1",
            challenge: "C-044",
            repo: "net-config",
            startedAt,
            stale: false,
          },
        ],
      }),
      agentBoard({ name: "idle-agent", cycleStatus: "idle" }),
    ]);
    const onAgentUpdate = vi.fn();

    let nowMs = Date.parse(startedAt);
    let scheduled: (() => void) | undefined;
    const setIntervalFn = vi.fn((handler: () => void) => {
      scheduled = handler;
      return 1 as unknown as NodeJS.Timeout;
    });

    const timer = startStaleReevaluation(cache, onAgentUpdate, {
      now: () => new Date(nowMs),
      setIntervalFn,
      clearIntervalFn: vi.fn(),
    });

    // 1 分経過 → 経過分バケットが変わり、実行中 run を持つエージェントだけ push
    nowMs += 60_000;
    scheduled?.();
    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "medical" }),
    );

    // さらに 1 分 → もう一度 push（毎分更新される）
    nowMs += 60_000;
    scheduled?.();
    expect(onAgentUpdate).toHaveBeenCalledTimes(2);

    // 同一分内の再評価では push しない
    nowMs += 1_000;
    scheduled?.();
    expect(onAgentUpdate).toHaveBeenCalledTimes(2);

    timer.close();
  });

  it("close() で clearIntervalFn が呼ばれる", () => {
    const cache = fakeCache(() => [agentBoard()]);
    const onAgentUpdate = vi.fn();

    const handle = {};
    const setIntervalFn = vi.fn(() => handle as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();

    const timer = startStaleReevaluation(cache, onAgentUpdate, {
      setIntervalFn,
      clearIntervalFn,
    });
    timer.close();

    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
  });

  it("既定の intervalMs は 60000ms", () => {
    const cache = fakeCache(() => [agentBoard()]);
    const onAgentUpdate = vi.fn();

    const setIntervalFn = vi.fn(() => 1 as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();

    const timer = startStaleReevaluation(cache, onAgentUpdate, {
      setIntervalFn,
      clearIntervalFn,
    });

    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 60_000);

    timer.close();
  });
});
