import { describe, expect, it } from "vitest";
import type { AgentBoard, Challenge } from "../board-types.ts";
import { findChallengeById } from "./challenge-lookup.ts";

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

function agentBoard(overrides: Partial<AgentBoard> = {}): AgentBoard {
  return {
    name: "medical",
    path: "/agents/medical",
    challenges: [],
    parseErrors: [],
    cycleStatus: "idle",
    runningRuns: [],
    archivedChallenges: [],
    ...overrides,
  };
}

describe("findChallengeById", () => {
  it("challenges にヒットする課題があればそれを返す", () => {
    const target = challenge({ id: "C-042" });
    const agent = agentBoard({
      challenges: [challenge({ id: "C-001" }), target],
    });

    expect(findChallengeById(agent, "C-042")).toBe(target);
  });

  it("challenges に無く archivedChallenges にヒットする場合はそちらを返す（FR-B3 フォールバック）", () => {
    const archived = challenge({ id: "C-042" });
    const agent = agentBoard({
      challenges: [challenge({ id: "C-001" })],
      archivedChallenges: [archived],
    });

    expect(findChallengeById(agent, "C-042")).toBe(archived);
  });

  it("challenges・archivedChallenges どちらにも無ければ undefined を返す", () => {
    const agent = agentBoard({
      challenges: [challenge({ id: "C-001" })],
      archivedChallenges: [challenge({ id: "C-002" })],
    });

    expect(findChallengeById(agent, "C-999")).toBeUndefined();
  });

  it("同一 ID が challenges・archivedChallenges の両方に存在する場合、challenges 側を優先する（探索順序の固定。セルフレビュー指摘対応）", () => {
    const live = challenge({ id: "C-042", title: "台帳の最新版" });
    const archived = challenge({ id: "C-042", title: "アーカイブの旧版" });
    const agent = agentBoard({
      challenges: [live],
      archivedChallenges: [archived],
    });

    expect(findChallengeById(agent, "C-042")).toBe(live);
  });
});
