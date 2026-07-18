import type { JournalEntry, LogEntry } from "./parsers/journal.ts";
import { deriveLogEntries } from "./parsers/journal.ts";
import type { Challenge, ParseError } from "./parsers/ledger.ts";
import type { MatchedRun, Run } from "./parsers/runs.ts";
import {
  deriveRunLogEntries,
  deriveRuns,
  mergeLogEntries,
  resolveStaleMinutes,
} from "./parsers/runs.ts";

// 読み取り専用の索引（NFR-04）。fs には一切依存せず、破棄しても正本
// （challenge-ledger.md / journal / runs.jsonl）から再構築できることを唯一の
// 必須性質とする。実装は本ファイルに閉じ、呼び出し側（api.ts 等）は
// BoardCache インターフェースにのみ依存する（§3.3 SQLite 移行トリガー対応）。

export type AgentCycleStatus = "running" | "idle" | "stale";

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
   * （startStaleReevaluation）や API 呼び出しのたびに正しい経過時間で導出される。
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

function deriveCycleStatus(runs: Run[]): AgentCycleStatus {
  const openCycles = runs.filter(
    (run) => run.kind === "cycle" && run.endedAt === undefined,
  );
  if (openCycles.length === 0) {
    return "idle";
  }
  return openCycles.some((run) => run.stale) ? "stale" : "running";
}

function deriveRunningRuns(runs: Run[]): Run[] {
  return runs.filter(
    (run) => run.kind !== "cycle" && run.endedAt === undefined,
  );
}

export function createMemoryBoardCache(
  options: MemoryBoardCacheOptions = {},
): BoardCache {
  const staleMinutes = options.staleMinutes ?? resolveStaleMinutes();
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

export type StaleReevaluationTimer = { close(): void };

export type StaleReevaluationOptions = {
  /** 再評価間隔（ミリ秒）。既定 60_000（1分）。 */
  intervalMs?: number;
  /** 現在時刻を返す関数。既定 () => new Date()（テストで時刻を Mock するための DI）。 */
  now?: () => Date;
  /** setInterval の DI 用。既定 global setInterval。 */
  setIntervalFn?: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  /** clearInterval の DI 用。既定 global clearInterval。 */
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
};

/**
 * cycleStatus + runningRuns（の stale 値等）の変化を検知するための署名。
 * 変化検知に十分な情報（kind/key/endedAt/stale の組み合わせ）だけを比較対象にする。
 */
function computeAgentSignature(agent: AgentBoard): string {
  return JSON.stringify({
    cycleStatus: agent.cycleStatus,
    runningRuns: (agent.runningRuns ?? []).map((run) => ({
      kind: run.kind,
      key: run.key,
      endedAt: run.endedAt,
      stale: run.stale,
    })),
  });
}

const DEFAULT_STALE_REEVALUATION_INTERVAL_MS = 60_000;

/**
 * intervalMs（既定1分）ごとに cache.getSnapshot(now) を再計算し、前回 push した
 * cycleStatus/runningRuns から変化があったエージェントのみ onAgentUpdate を呼ぶ
 * （無変化なら push せず、無駄な WS broadcast を避ける）。fs イベントも API 呼び出しも
 * 起きない間に stale へ変わったことへ誰も気づけない問題を解消するための定期タイマー。
 */
export function startStaleReevaluation(
  cache: BoardCache,
  onAgentUpdate: (agent: AgentBoard) => void,
  options: StaleReevaluationOptions = {},
): StaleReevaluationTimer {
  const intervalMs =
    options.intervalMs ?? DEFAULT_STALE_REEVALUATION_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  const lastSignatureByAgent = new Map<string, string>();
  // 起動時点のスナップショットを基準にしておく（初回 tick で無変化なら push しない）。
  for (const agent of cache.getSnapshot(now()).agents) {
    lastSignatureByAgent.set(agent.name, computeAgentSignature(agent));
  }

  const timer = setIntervalFn(() => {
    const snapshot = cache.getSnapshot(now());
    for (const agent of snapshot.agents) {
      const signature = computeAgentSignature(agent);
      if (lastSignatureByAgent.get(agent.name) !== signature) {
        lastSignatureByAgent.set(agent.name, signature);
        onAgentUpdate(agent);
      }
    }
  }, intervalMs);

  // board 停止（プロセス終了）をタイマーが妨げないようにする（watcher.ts の
  // rescanInterval.unref() と同様）。DI 注入されたテストダブルには unref が
  // 無い可能性があるため、存在チェックしてから呼ぶ。
  const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") {
    maybeUnref.call(timer);
  }

  return {
    close() {
      clearIntervalFn(timer);
    },
  };
}
