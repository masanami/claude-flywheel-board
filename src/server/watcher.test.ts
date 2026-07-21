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

  it("runs.jsonl がある repo は matchedRuns にマッチング済みの Run が得られる", async () => {
    const result = await scanAgent({
      name: "agent-d",
      path: `${FIXTURES_ROOT}agent-d`,
    });

    expect(result.parseErrors).toEqual([]);
    expect(result.matchedRuns).toHaveLength(2);
    const delegate = result.matchedRuns.find((r) => r.kind === "delegate");
    expect(delegate).toMatchObject({
      challenge: "C-400",
      repo: "net-config",
    });
    expect(delegate?.endedAt).toBeUndefined();
  });

  it("repo パスが存在しない場合は例外を投げず、ledger/journal 2つ分の ParseError を返す（監視失敗の可視化）。runs.jsonl は遅延生成のため repo 不存在時の欠落もエラー化しない", async () => {
    const result = await scanAgent({
      name: "missing-agent",
      path: `${FIXTURES_ROOT}does-not-exist`,
    });

    expect(result.challenges).toEqual([]);
    expect(result.journalEntries).toEqual([]);
    expect(result.matchedRuns).toEqual([]);
    expect(result.parseErrors).toHaveLength(2);
    expect(result.parseErrors[0]?.file).toContain("challenge-ledger.md");
    expect(result.parseErrors[1]?.file).toContain(
      `journal${path.sep}index.jsonl`,
    );
  });

  it("repo はあるが runs.jsonl だけ無い（未稼働エージェントの正常状態）場合、parseErrors は空で matchedRuns も空になる", async () => {
    const result = await scanAgent({
      name: "agent-e",
      path: `${FIXTURES_ROOT}agent-e`,
    });

    expect(result.parseErrors).toEqual([]);
    expect(result.challenges).toHaveLength(1);
    expect(result.matchedRuns).toEqual([]);
  });

  it("challenge-archive*.md が無い repo は archivedChallenges が空配列になり ParseError も増えない（Issue #50 ①・空安全）", async () => {
    const result = await scanAgent({
      name: "agent-a",
      path: `${FIXTURES_ROOT}agent-a`,
    });

    expect(result.archivedChallenges).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it("複数の challenge-archive*.md（年次分割）を glob で読み込み、ファイル名の昇順で決定的に連結する（Issue #50 ①）", async () => {
    const result = await scanAgent({
      name: "agent-archive",
      path: `${FIXTURES_ROOT}agent-archive`,
    });

    expect(result.parseErrors).toEqual([]);
    expect(result.archivedChallenges.map((c) => c.id)).toEqual([
      "C-810",
      "C-820",
    ]);
  });

  it("アーカイブのエントリはステータス=完了で読める（既存 parseLedger をそのまま流用・独自パーサを持たない）", async () => {
    const result = await scanAgent({
      name: "agent-archive",
      path: `${FIXTURES_ROOT}agent-archive`,
    });

    const archived = result.archivedChallenges.find((c) => c.id === "C-820");
    expect(archived).toMatchObject({
      id: "C-820",
      title: "アーカイブの課題",
      status: "完了",
    });
    // 台帳側の現行課題（C-800）は archivedChallenges に混ざらない。
    expect(result.challenges.map((c) => c.id)).toEqual(["C-800"]);
  });

  it("repo パスが存在しない場合も archivedChallenges は空配列になり、parseErrors はledger/journal 2つ分のまま増えない（Issue #50 ①・空安全）", async () => {
    const result = await scanAgent({
      name: "missing-agent",
      path: `${FIXTURES_ROOT}does-not-exist`,
    });

    expect(result.archivedChallenges).toEqual([]);
    expect(result.parseErrors).toHaveLength(2);
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

  it("archivedChallenges を cache.replaceAgent 経由で snapshot まで反映する（Issue #50 ①）", async () => {
    const cache = createMemoryBoardCache();
    const entry = {
      name: "agent-archive",
      path: `${FIXTURES_ROOT}agent-archive`,
    };

    await scanAndUpdateAgent(entry, cache);

    const agent = cache
      .getSnapshot()
      .agents.find((a) => a.name === "agent-archive");
    // cache.replaceAgent は既存 sortChallenges を流用するため、glob 連結順
    // （ファイル名昇順: C-810→C-820）ではなく優先度順（P1のC-820→P2のC-810）になる。
    expect(agent?.archivedChallenges.map((c) => c.id)).toEqual([
      "C-820",
      "C-810",
    ]);
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

  it("runs.jsonl 由来の matchedRuns が cache.replaceRuns 経由で反映され、cycleStatus/runningRuns・getLog に統合される", async () => {
    const cache = createMemoryBoardCache({ staleMinutes: 30 });
    const entry = { name: "agent-d", path: `${FIXTURES_ROOT}agent-d` };

    await scanAndUpdateAgent(entry, cache);

    const snapshot = cache.getSnapshot(new Date("2026-07-16T10:10:00+09:00"));
    const agent = snapshot.agents.find((a) => a.name === "agent-d");
    expect(agent?.cycleStatus).toBe("running");
    expect(agent?.runningRuns).toHaveLength(1);
    expect(agent?.runningRuns?.[0]?.kind).toBe("delegate");

    const log = cache.getLog("agent-d", "C-400");
    expect(log.map((entry) => entry.source)).toEqual(["journal", "runs"]);
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
