import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createMemoryBoardCache } from "./cache.ts";
import { fullScan, scanAgent, scanAndUpdateAgent } from "./watcher.ts";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../../tests/fixtures/watcher/", import.meta.url),
);

describe("scanAgent", () => {
  it("正常な repo をスキャンすると challenges / journalEntries が得られ parseErrors は空", async () => {
    const result = await scanAgent({
      name: "agent-a",
      path: `${FIXTURES_ROOT}agent-a`,
    });

    expect(result.parseErrors).toEqual([]);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]?.id).toBe("C-100");
    expect(result.journalEntries).toHaveLength(1);
    expect(result.journalEntries[0]?.touched_issues[0]?.id).toBe("C-100");
  });

  it("repo パスが存在しない場合は例外を投げず、ledger/journal 両方の ParseError を返す（監視失敗の可視化）", async () => {
    const result = await scanAgent({
      name: "missing-agent",
      path: `${FIXTURES_ROOT}does-not-exist`,
    });

    expect(result.challenges).toEqual([]);
    expect(result.journalEntries).toEqual([]);
    expect(result.parseErrors).toHaveLength(2);
    expect(result.parseErrors[0]?.file).toContain("challenge-ledger.md");
    expect(result.parseErrors[1]?.file).toContain(
      `journal${path.sep}index.jsonl`,
    );
  });
});

describe("scanAndUpdateAgent", () => {
  it("cache.replaceAgent / replaceJournal を反映し、onAgentUpdate に更新後の AgentBoard を渡す", async () => {
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();
    const entry = { name: "agent-a", path: `${FIXTURES_ROOT}agent-a` };

    await scanAndUpdateAgent(entry, cache, onAgentUpdate);

    expect(cache.getSnapshot().agents).toHaveLength(1);
    expect(cache.getSnapshot().agents[0]?.name).toBe("agent-a");
    expect(cache.getLog("agent-a", "C-100")).toEqual([
      { ts: "2026-07-01", source: "journal", text: "未着手 → 着手中" },
    ]);

    expect(onAgentUpdate).toHaveBeenCalledTimes(1);
    expect(onAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent-a", path: entry.path }),
    );
  });

  it("journal に言及がある課題は snapshot の challenge.summary に直近の要約が載る（FR-08 ホバー要約の結線）", async () => {
    const cache = createMemoryBoardCache();
    const entry = { name: "agent-a", path: `${FIXTURES_ROOT}agent-a` };

    await scanAndUpdateAgent(entry, cache);

    const challenge = cache.getChallenge("agent-a", "C-100");
    expect(challenge?.summary).toBe("未着手 → 着手中");
  });

  it("journal に言及がない課題の summary は undefined のまま", async () => {
    const cache = createMemoryBoardCache();
    const entry = { name: "agent-c", path: `${FIXTURES_ROOT}agent-c` };

    await scanAndUpdateAgent(entry, cache);

    const challenge = cache.getChallenge("agent-c", "C-300");
    expect(challenge).toBeDefined();
    expect(challenge?.summary).toBeUndefined();
  });
});

describe("fullScan", () => {
  it("複数 repo を全てスキャンし、1 repo の失敗が他 repo の反映を止めない（監視失敗の可視化）", async () => {
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();
    const entries = [
      { name: "agent-a", path: `${FIXTURES_ROOT}agent-a` },
      { name: "missing-agent", path: `${FIXTURES_ROOT}does-not-exist` },
    ];

    await fullScan(entries, cache, onAgentUpdate);

    const snapshot = cache.getSnapshot();
    expect(snapshot.agents.map((a) => a.name).sort()).toEqual([
      "agent-a",
      "missing-agent",
    ]);
    const missing = snapshot.agents.find((a) => a.name === "missing-agent");
    expect(missing?.challenges).toEqual([]);
    expect(missing?.parseErrors).toHaveLength(2);
    expect(onAgentUpdate).toHaveBeenCalledTimes(2);
  });
});
