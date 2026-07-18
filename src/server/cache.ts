import type { JournalEntry } from "./parsers/journal.ts";
import { deriveLogEntries } from "./parsers/journal.ts";
import type { Challenge } from "./parsers/ledger.ts";
import type { AgentCycleStatus, MatchedRun, Run } from "./parsers/runs.ts";
import {
  deriveCycleStatus,
  deriveRunLogEntries,
  deriveRunningRuns,
  deriveRuns,
  mergeLogEntries,
  resolveStaleMinutes,
} from "./parsers/runs.ts";
// ParseError/LogEntry の単一定義は parsers/types.ts（セルフレビュー指摘対応:
// 三重定義の解消）。ledger.ts/journal.ts 経由の re-export ではなく、正本の
// types.ts を直接参照する（watcher.ts・ui/board-types.ts と揃える）。
import type { LogEntry, ParseError } from "./parsers/types.ts";

// 読み取り専用の索引（NFR-04）。fs には一切依存せず、破棄しても正本
// （challenge-ledger.md / journal / runs.jsonl）から再構築できることを唯一の
// 必須性質とする。実装は本ファイルに閉じ、呼び出し側（api.ts 等）は
// BoardCache インターフェースにのみ依存する（§3.3 SQLite 移行トリガー対応）。

// AgentCycleStatus の単一定義は parsers/runs.ts（deriveCycleStatus の戻り値型
// として自然な置き場所のため。Issue #36 項目2）。board-types.ts の既存 import
// パス（`../server/cache.ts` から取得できること）を壊さないよう re-export する。
export type { AgentCycleStatus } from "./parsers/runs.ts";

export type AgentBoard = {
  name: string;
  path: string;
  challenges: Challenge[];
  parseErrors: ParseError[];
  // P3: runs.jsonl から導出するサイクル状態・実行中セッション（getSnapshot が
  // 呼び出しのたびに算出して埋める）。#30 で UI 側テストヘルパー
  // （Board.test.tsx / AgentColumn.test.tsx / ws.test.ts の agentBoard()）に
  // デフォルト値を追加したため、必須フィールドとして扱えるようになった
  // （実行時は getSnapshot が必ず両方とも埋めて返す。型と実態を一致させる）。
  cycleStatus: AgentCycleStatus;
  /** kind: "delegate" | "adhoc" の実行中 Run のみ（cycle は cycleStatus 側で表現するため除外）。 */
  runningRuns: Run[];
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
  /** 指定エージェントの runs.jsonl 由来 MatchedRun を丸ごと入れ替える。 */
  replaceRuns(agentName: string, matched: MatchedRun[]): void;
  /** (agent, challengeId) の複合キーで課題を取得する。未登録なら undefined。 */
  getChallenge(agentName: string, challengeId: string): Challenge | undefined;
  /** (agent, challengeId) の複合キーで journal + runs 由来のログを導出する。未登録なら空配列。 */
  getLog(agentName: string, challengeId: string): LogEntry[];
  /**
   * 全エージェントのスナップショットを返す。cycleStatus/runningRuns は now 時点で
   * 都度再計算する（先に stale を確定させて保存しない）ため、定期再評価
   * （stale-reevaluation.ts の startStaleReevaluation）や API 呼び出しのたびに
   * 正しい経過時間で導出される。
   */
  getSnapshot(now?: Date): BoardSnapshot;
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

export type MemoryBoardCacheOptions = {
  /** stale しきい値（分）。省略時は {@link resolveStaleMinutes}() を使う。 */
  staleMinutes?: number;
};

// getSnapshot の内部保持用。cycleStatus/runningRuns は都度算出するため保持しない。
type StoredAgentBoard = Omit<AgentBoard, "cycleStatus" | "runningRuns">;

export function createMemoryBoardCache(
  options: MemoryBoardCacheOptions = {},
): BoardCache {
  // resolveStaleMinutes に検証を一任する（0・負数・NaN は不正値としてデフォルトへ
  // フォールバック。従来は `options.staleMinutes ?? resolveStaleMinutes()` で
  // override の正数チェックが漏れていた。CodeRabbit 指摘対応）。
  const staleMinutes = resolveStaleMinutes(options.staleMinutes);
  const agents = new Map<string, StoredAgentBoard>();
  const journalByAgent = new Map<string, JournalEntry[]>();
  const runsByAgent = new Map<string, MatchedRun[]>();

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

    replaceRuns(agentName, matched) {
      runsByAgent.set(agentName, matched);
    },

    getChallenge(agentName, challengeId) {
      const agent = agents.get(agentName);
      return agent?.challenges.find((c) => c.id === challengeId);
    },

    getLog(agentName, challengeId) {
      const journalEntries = journalByAgent.get(agentName);
      const journalLog = journalEntries
        ? deriveLogEntries(journalEntries, challengeId)
        : [];

      const matchedRuns = runsByAgent.get(agentName) ?? [];
      const relevantRuns = matchedRuns.filter(
        (run) => run.challenge === challengeId,
      );
      const runsLog = deriveRunLogEntries(relevantRuns);

      return mergeLogEntries(journalLog, runsLog);
    },

    getSnapshot(now = new Date()) {
      return {
        agents: Array.from(agents.values()).map((agent) => {
          const matched = runsByAgent.get(agent.name) ?? [];
          const derived = deriveRuns(matched, now, staleMinutes);
          return {
            ...agent,
            cycleStatus: deriveCycleStatus(derived),
            runningRuns: deriveRunningRuns(derived),
          };
        }),
      };
    },
  };
}
