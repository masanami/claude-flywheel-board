import { describe, expect, it } from "vitest";
import { createMemoryBoardCache, sortChallenges } from "./cache.ts";
import type { JournalEntry } from "./parsers/journal.ts";
import type { Challenge } from "./parsers/ledger.ts";

function challenge(
  overrides: Partial<Challenge> & Pick<Challenge, "id">,
): Challenge {
  return {
    title: `title-${overrides.id}`,
    status: "未分類",
    needsHuman: false,
    ...overrides,
  };
}

function journalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    date: "2026-07-01",
    seq: 1,
    touched_issues: [],
    delegations: [],
    pr_urls: [],
    pending_approvals: [],
    decisions: [],
    ...overrides,
  };
}

describe("sortChallenges", () => {
  it("承認待ち（needsHuman）グループを先頭にする", () => {
    const input = [
      challenge({ id: "C-001", needsHuman: false }),
      challenge({ id: "C-002", needsHuman: true }),
    ];

    const result = sortChallenges(input);

    expect(result.map((c) => c.id)).toEqual(["C-002", "C-001"]);
  });

  it("各グループ内で priority 昇順にソートする", () => {
    const input = [
      challenge({ id: "C-001", priority: "P2" }),
      challenge({ id: "C-002", priority: "P0" }),
      challenge({ id: "C-003", priority: "P1" }),
    ];

    const result = sortChallenges(input);

    expect(result.map((c) => c.id)).toEqual(["C-002", "C-003", "C-001"]);
  });

  it("priority が無いものはグループ末尾に並ぶ", () => {
    const input = [
      challenge({ id: "C-001" }),
      challenge({ id: "C-002", priority: "P1" }),
    ];

    const result = sortChallenges(input);

    expect(result.map((c) => c.id)).toEqual(["C-002", "C-001"]);
  });

  it("同一優先度・優先度なし同士は元の配列順を維持する（安定ソート）", () => {
    const input = [
      challenge({ id: "C-001", priority: "P1" }),
      challenge({ id: "C-002", priority: "P1" }),
      challenge({ id: "C-003" }),
      challenge({ id: "C-004" }),
    ];

    const result = sortChallenges(input);

    expect(result.map((c) => c.id)).toEqual([
      "C-001",
      "C-002",
      "C-003",
      "C-004",
    ]);
  });

  it("承認待ちグループとpriorityソートを組み合わせる", () => {
    const input = [
      challenge({ id: "C-001", needsHuman: false, priority: "P0" }),
      challenge({ id: "C-002", needsHuman: true, priority: "P1" }),
      challenge({ id: "C-003", needsHuman: true, priority: "P0" }),
    ];

    const result = sortChallenges(input);

    expect(result.map((c) => c.id)).toEqual(["C-003", "C-002", "C-001"]);
  });
});

describe("createMemoryBoardCache", () => {
  it("初期状態では agents が空配列の snapshot を返す", () => {
    const cache = createMemoryBoardCache();

    expect(cache.getSnapshot()).toEqual({ agents: [] });
  });

  it("replaceAgent で登録した内容が getSnapshot に反映される（優先度順ソート済み）", () => {
    const cache = createMemoryBoardCache();

    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [
        challenge({ id: "C-001", priority: "P1" }),
        challenge({ id: "C-002", needsHuman: true }),
      ],
      parseErrors: [],
    });

    const snapshot = cache.getSnapshot();

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({
      name: "medical",
      path: "/agents/medical-agent",
      parseErrors: [],
    });
    expect(snapshot.agents[0]?.challenges.map((c) => c.id)).toEqual([
      "C-002",
      "C-001",
    ]);
  });

  it("同名エージェントへの再 replaceAgent は完全に置き換わる（差分ではなく丸ごと入れ替え）", () => {
    const cache = createMemoryBoardCache();

    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [challenge({ id: "C-001" }), challenge({ id: "C-002" })],
      parseErrors: [],
    });

    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [challenge({ id: "C-003" })],
      parseErrors: [
        { file: "challenge-ledger.md", message: "broken", raw: "raw" },
      ],
    });

    const snapshot = cache.getSnapshot();
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.challenges.map((c) => c.id)).toEqual(["C-003"]);
    expect(snapshot.agents[0]?.parseErrors).toHaveLength(1);
  });

  it("(agent, challengeId) 複合キー: 異なるエージェントの同一 challengeId が混線しない", () => {
    const cache = createMemoryBoardCache();

    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [challenge({ id: "C-044", title: "medical の C-044" })],
      parseErrors: [],
    });
    cache.replaceAgent({
      name: "bi",
      path: "/agents/bi-agent",
      challenges: [challenge({ id: "C-044", title: "bi の C-044" })],
      parseErrors: [],
    });

    expect(cache.getChallenge("medical", "C-044")?.title).toBe(
      "medical の C-044",
    );
    expect(cache.getChallenge("bi", "C-044")?.title).toBe("bi の C-044");
  });

  it("getChallenge は未登録のエージェント・課題では undefined を返す", () => {
    const cache = createMemoryBoardCache();

    expect(cache.getChallenge("unknown", "C-001")).toBeUndefined();

    cache.replaceAgent({
      name: "medical",
      path: "/agents/medical-agent",
      challenges: [challenge({ id: "C-001" })],
      parseErrors: [],
    });

    expect(cache.getChallenge("medical", "C-999")).toBeUndefined();
  });

  it("getLog は未登録のエージェントに対して空配列を返す", () => {
    const cache = createMemoryBoardCache();

    expect(cache.getLog("unknown", "C-001")).toEqual([]);
  });

  it("getLog は replaceJournal した内容から deriveLogEntries 相当のログを返す", () => {
    const cache = createMemoryBoardCache();

    cache.replaceJournal("medical", [
      journalEntry({
        date: "2026-07-02",
        seq: 3,
        touched_issues: [{ id: "C-001", from: "着手中", to: "検証中" }],
      }),
    ]);

    const log = cache.getLog("medical", "C-001");

    expect(log).toEqual([
      { ts: "2026-07-02", source: "journal", text: "着手中 → 検証中" },
    ]);
  });

  it("getLog は (agent, challengeId) 複合キーで、他エージェントの journal と混線しない", () => {
    const cache = createMemoryBoardCache();

    cache.replaceJournal("medical", [
      journalEntry({
        touched_issues: [{ id: "C-044", from: "未着手", to: "着手中" }],
      }),
    ]);
    cache.replaceJournal("bi", [
      journalEntry({
        touched_issues: [{ id: "C-044", from: "着手中", to: "検証中" }],
      }),
    ]);

    expect(cache.getLog("medical", "C-044")).toEqual([
      { ts: "2026-07-01", source: "journal", text: "未着手 → 着手中" },
    ]);
    expect(cache.getLog("bi", "C-044")).toEqual([
      { ts: "2026-07-01", source: "journal", text: "着手中 → 検証中" },
    ]);
  });
});
