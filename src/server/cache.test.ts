import { describe, expect, it } from "vitest";
import { createMemoryBoardCache, sortChallenges } from "./cache.ts";
import type { JournalEntry } from "./parsers/journal.ts";
import type { Challenge } from "./parsers/ledger.ts";
import type { MatchedRun, RunEvent } from "./parsers/runs.ts";
import { matchRuns } from "./parsers/runs.ts";

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

function matchedRun(
  overrides: Partial<MatchedRun> &
    Pick<MatchedRun, "kind" | "key" | "startedAt">,
): MatchedRun {
  return { ...overrides };
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

  it("getLog は replaceRuns した内容から該当 challenge の runs 由来ログも統合して返す（journal→runs のソートキー順）", () => {
    const cache = createMemoryBoardCache();

    cache.replaceJournal("medical", [
      journalEntry({
        date: "2026-07-16",
        touched_issues: [{ id: "C-044", from: "未着手", to: "着手中" }],
      }),
    ]);
    cache.replaceRuns("medical", [
      matchedRun({
        kind: "delegate",
        key: "550e8400-e29b-41d4-a716-446655440000",
        challenge: "C-044",
        repo: "net-config",
        startedAt: "2026-07-16T10:05:12+09:00",
        endedAt: "2026-07-16T10:42:30+09:00",
        result: "実装完了",
      }),
    ]);

    const log = cache.getLog("medical", "C-044");

    expect(log).toHaveLength(3);
    expect(log.map((e) => e.source)).toEqual(["journal", "runs", "runs"]);
  });

  it("getLog は runs の challenge が一致しない Run は含めない（他課題への委譲と混線しない）", () => {
    const cache = createMemoryBoardCache();

    cache.replaceRuns("medical", [
      matchedRun({
        kind: "delegate",
        key: "s1",
        challenge: "C-999",
        repo: "net-config",
        startedAt: "2026-07-16T10:05:12+09:00",
      }),
    ]);

    expect(cache.getLog("medical", "C-044")).toEqual([]);
  });

  describe("replaceRuns / getSnapshot（cycleStatus・runningRuns の導出）", () => {
    it("実行中の cycle Run が無ければ cycleStatus は idle", () => {
      const cache = createMemoryBoardCache();
      cache.replaceAgent({
        name: "medical",
        path: "/agents/medical-agent",
        challenges: [],
        parseErrors: [],
      });

      const snapshot = cache.getSnapshot(new Date("2026-07-16T10:00:00Z"));

      expect(snapshot.agents[0]?.cycleStatus).toBe("idle");
      expect(snapshot.agents[0]?.runningRuns).toEqual([]);
    });

    it("実行中の cycle Run があり経過がしきい値以下なら cycleStatus は running", () => {
      const cache = createMemoryBoardCache({ staleMinutes: 30 });
      cache.replaceAgent({
        name: "medical",
        path: "/agents/medical-agent",
        challenges: [],
        parseErrors: [],
      });
      cache.replaceRuns("medical", [
        matchedRun({
          kind: "cycle",
          key: "2026-07-16-cycle",
          startedAt: "2026-07-16T10:00:00+09:00",
        }),
      ]);

      const snapshot = cache.getSnapshot(new Date("2026-07-16T10:05:00+09:00"));

      expect(snapshot.agents[0]?.cycleStatus).toBe("running");
    });

    it("実行中の cycle Run があり経過がしきい値超過なら cycleStatus は stale", () => {
      const cache = createMemoryBoardCache({ staleMinutes: 30 });
      cache.replaceAgent({
        name: "medical",
        path: "/agents/medical-agent",
        challenges: [],
        parseErrors: [],
      });
      cache.replaceRuns("medical", [
        matchedRun({
          kind: "cycle",
          key: "2026-07-16-cycle",
          startedAt: "2026-07-16T10:00:00+09:00",
        }),
      ]);

      const snapshot = cache.getSnapshot(new Date("2026-07-16T10:31:00+09:00"));

      expect(snapshot.agents[0]?.cycleStatus).toBe("stale");
    });

    it("runningRuns には delegate/adhoc の実行中 Run のみ含み、cycle は含めない", () => {
      const cache = createMemoryBoardCache({ staleMinutes: 30 });
      cache.replaceAgent({
        name: "medical",
        path: "/agents/medical-agent",
        challenges: [],
        parseErrors: [],
      });
      cache.replaceRuns("medical", [
        matchedRun({
          kind: "cycle",
          key: "2026-07-16-cycle",
          startedAt: "2026-07-16T10:00:00+09:00",
        }),
        matchedRun({
          kind: "delegate",
          key: "s1",
          challenge: "C-044",
          repo: "net-config",
          startedAt: "2026-07-16T10:05:00+09:00",
        }),
        matchedRun({
          kind: "adhoc",
          key: "adhoc-1",
          title: "調査",
          startedAt: "2026-07-16T10:06:00+09:00",
        }),
        matchedRun({
          kind: "delegate",
          key: "s2",
          challenge: "C-045",
          repo: "net-config",
          startedAt: "2026-07-16T09:00:00+09:00",
          endedAt: "2026-07-16T09:10:00+09:00",
          result: "done",
        }),
      ]);

      const snapshot = cache.getSnapshot(new Date("2026-07-16T10:10:00+09:00"));

      const runningRuns = snapshot.agents[0]?.runningRuns ?? [];
      expect(runningRuns.map((r) => r.kind).sort()).toEqual([
        "adhoc",
        "delegate",
      ]);
      expect(runningRuns.every((r) => r.endedAt === undefined)).toBe(true);
    });

    it("superseded な delegate Run（同一 key の新しい start による）は runningRuns から除外される", () => {
      const cache = createMemoryBoardCache({ staleMinutes: 30 });
      cache.replaceAgent({
        name: "medical",
        path: "/agents/medical-agent",
        challenges: [],
        parseErrors: [],
      });
      cache.replaceRuns("medical", [
        matchedRun({
          kind: "delegate",
          key: "s1",
          challenge: "C-044",
          repo: "net-config",
          startedAt: "2026-07-16T10:00:00+09:00",
          superseded: true,
        }),
        matchedRun({
          kind: "delegate",
          key: "s1",
          challenge: "C-044",
          repo: "net-config",
          startedAt: "2026-07-17T09:00:00+09:00",
        }),
      ]);

      const snapshot = cache.getSnapshot(new Date("2026-07-17T09:05:00+09:00"));

      const runningRuns = snapshot.agents[0]?.runningRuns ?? [];
      expect(runningRuns).toHaveLength(1);
      expect(runningRuns[0]?.startedAt).toBe("2026-07-17T09:00:00+09:00");
    });

    it("superseded な cycle Run（古い stale なもの）は cycleStatus 判定から除外され、現行 cycle の状態のみで判定される", () => {
      const cache = createMemoryBoardCache({ staleMinutes: 30 });
      cache.replaceAgent({
        name: "medical",
        path: "/agents/medical-agent",
        challenges: [],
        parseErrors: [],
      });
      cache.replaceRuns("medical", [
        matchedRun({
          kind: "cycle",
          key: "same-cycle-name",
          startedAt: "2026-07-01T00:00:00+09:00", // 大幅に経過（superseded でなければ stale）
          superseded: true,
        }),
        matchedRun({
          kind: "cycle",
          key: "same-cycle-name",
          startedAt: "2026-07-17T09:00:00+09:00",
        }),
      ]);

      const snapshot = cache.getSnapshot(new Date("2026-07-17T09:05:00+09:00"));

      expect(snapshot.agents[0]?.cycleStatus).toBe("running");
    });

    it("結合シナリオ: cycle1 で delegate_start・cycle1 abandoned・cycle2 で同一 session_id の delegate_start→end という並びでは、実行中（cycleStatus/runningRuns）がゼロになる（Issue #36 項目1のシナリオ回帰確認）", () => {
      const events: RunEvent[] = [
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "cycle_start",
          cycle: "cycle1",
        },
        {
          ts: "2026-07-16T10:05:00+09:00",
          event: "delegate_start",
          challenge: "C-044",
          repo: "net-config",
          session_id: "s1",
        },
        {
          ts: "2026-07-16T10:45:00+09:00",
          event: "cycle_end",
          cycle: "cycle1",
          result: "abandoned",
        },
        {
          ts: "2026-07-17T09:00:00+09:00",
          event: "cycle_start",
          cycle: "cycle2",
        },
        {
          ts: "2026-07-17T09:01:00+09:00",
          event: "delegate_start",
          challenge: "C-044",
          repo: "net-config",
          session_id: "s1",
        },
        {
          ts: "2026-07-17T09:30:00+09:00",
          event: "delegate_end",
          challenge: "C-044",
          repo: "net-config",
          session_id: "s1",
          result: "実装完了・PR起票（照合済み）",
        },
        {
          ts: "2026-07-17T09:35:00+09:00",
          event: "cycle_end",
          cycle: "cycle2",
          result: "completed",
        },
      ];

      const cache = createMemoryBoardCache({ staleMinutes: 30 });
      cache.replaceAgent({
        name: "medical",
        path: "/agents/medical-agent",
        challenges: [],
        parseErrors: [],
      });
      cache.replaceRuns("medical", matchRuns(events));

      const snapshot = cache.getSnapshot(new Date("2026-07-17T10:00:00+09:00"));

      expect(snapshot.agents[0]?.cycleStatus).toBe("idle");
      expect(snapshot.agents[0]?.runningRuns).toEqual([]);
    });

    it("createMemoryBoardCache({ staleMinutes }) が既定30分を上書きする", () => {
      const cache = createMemoryBoardCache({ staleMinutes: 5 });
      cache.replaceAgent({
        name: "medical",
        path: "/agents/medical-agent",
        challenges: [],
        parseErrors: [],
      });
      cache.replaceRuns("medical", [
        matchedRun({
          kind: "cycle",
          key: "2026-07-16-cycle",
          startedAt: "2026-07-16T10:00:00+09:00",
        }),
      ]);

      // 10分経過: 既定30分なら running のはずだが staleMinutes: 5 のため stale になる
      const snapshot = cache.getSnapshot(new Date("2026-07-16T10:10:00+09:00"));

      expect(snapshot.agents[0]?.cycleStatus).toBe("stale");
    });

    it.each([
      ["0", 0],
      ["負数", -5],
      ["NaN", Number.NaN],
    ])(
      "createMemoryBoardCache({ staleMinutes: 不正値（%s） }) は既定30分にフォールバックする",
      (_label, invalidStaleMinutes) => {
        const cache = createMemoryBoardCache({
          staleMinutes: invalidStaleMinutes,
        });
        cache.replaceAgent({
          name: "medical",
          path: "/agents/medical-agent",
          challenges: [],
          parseErrors: [],
        });
        cache.replaceRuns("medical", [
          matchedRun({
            kind: "cycle",
            key: "2026-07-16-cycle",
            startedAt: "2026-07-16T10:00:00+09:00",
          }),
        ]);

        // 10分経過: 不正値は既定30分にフォールバックされるはずなので running のまま
        const snapshot = cache.getSnapshot(
          new Date("2026-07-16T10:10:00+09:00"),
        );

        expect(snapshot.agents[0]?.cycleStatus).toBe("running");
      },
    );
  });
});
