import type { JournalEntry, LogEntry } from "./parsers/journal.ts";
import { deriveLogEntries } from "./parsers/journal.ts";
import type { Challenge, ParseError } from "./parsers/ledger.ts";

// 読み取り専用の索引（NFR-04）。fs には一切依存せず、破棄しても正本
// （challenge-ledger.md / journal / runs.jsonl）から再構築できることを唯一の
// 必須性質とする。実装は本ファイルに閉じ、呼び出し側（api.ts 等）は
// BoardCache インターフェースにのみ依存する（§3.3 SQLite 移行トリガー対応）。

export type AgentBoard = {
  name: string;
  path: string;
  challenges: Challenge[];
  parseErrors: ParseError[];
};

export type BoardSnapshot = {
  agents: AgentBoard[];
};

export type ReplaceAgentInput = {
  name: string;
  path: string;
  challenges: Challenge[];
  parseErrors: ParseError[];
};

export interface BoardCache {
  /** 指定エージェントの challenges / parseErrors を丸ごと入れ替える（差分計算はしない）。 */
  replaceAgent(input: ReplaceAgentInput): void;
  /** 指定エージェントの journal エントリを丸ごと入れ替える。 */
  replaceJournal(agentName: string, entries: JournalEntry[]): void;
  /** (agent, challengeId) の複合キーで課題を取得する。未登録なら undefined。 */
  getChallenge(agentName: string, challengeId: string): Challenge | undefined;
  /** (agent, challengeId) の複合キーで journal 由来のログを導出する。未登録なら空配列。 */
  getLog(agentName: string, challengeId: string): LogEntry[];
  /** 全エージェントのスナップショットを返す。 */
  getSnapshot(): BoardSnapshot;
}

const PRIORITY_GROUP_WITH_PRIORITY = 0;
const PRIORITY_GROUP_WITHOUT_PRIORITY = 1;
const NEEDS_HUMAN_GROUP = 0;
const NOT_NEEDS_HUMAN_GROUP = 1;

/**
 * 🔔承認待ち（needsHuman）グループを先頭に、各グループ内は priority 昇順
 * （値が無いものは末尾）でソートする。同優先度・優先度なし同士は元の配列順を
 * 維持する（Array.prototype.sort は安定ソート）。
 */
export function sortChallenges(challenges: Challenge[]): Challenge[] {
  return [...challenges].sort((a, b) => {
    const groupA = a.needsHuman ? NEEDS_HUMAN_GROUP : NOT_NEEDS_HUMAN_GROUP;
    const groupB = b.needsHuman ? NEEDS_HUMAN_GROUP : NOT_NEEDS_HUMAN_GROUP;
    if (groupA !== groupB) {
      return groupA - groupB;
    }

    const priorityGroupA =
      a.priority === undefined
        ? PRIORITY_GROUP_WITHOUT_PRIORITY
        : PRIORITY_GROUP_WITH_PRIORITY;
    const priorityGroupB =
      b.priority === undefined
        ? PRIORITY_GROUP_WITHOUT_PRIORITY
        : PRIORITY_GROUP_WITH_PRIORITY;
    if (priorityGroupA !== priorityGroupB) {
      return priorityGroupA - priorityGroupB;
    }

    if (a.priority !== undefined && b.priority !== undefined) {
      if (a.priority < b.priority) return -1;
      if (a.priority > b.priority) return 1;
    }
    return 0;
  });
}

export function createMemoryBoardCache(): BoardCache {
  const agents = new Map<string, AgentBoard>();
  const journalByAgent = new Map<string, JournalEntry[]>();

  return {
    replaceAgent(input) {
      agents.set(input.name, {
        name: input.name,
        path: input.path,
        challenges: sortChallenges(input.challenges),
        parseErrors: input.parseErrors,
      });
    },

    replaceJournal(agentName, entries) {
      journalByAgent.set(agentName, entries);
    },

    getChallenge(agentName, challengeId) {
      const agent = agents.get(agentName);
      return agent?.challenges.find((c) => c.id === challengeId);
    },

    getLog(agentName, challengeId) {
      const entries = journalByAgent.get(agentName);
      if (!entries) {
        return [];
      }
      return deriveLogEntries(entries, challengeId);
    },

    getSnapshot() {
      return { agents: Array.from(agents.values()) };
    },
  };
}
