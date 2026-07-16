import * as path from "node:path";
import { watch } from "chokidar";
import type { AgentBoard, BoardCache } from "./cache.ts";
import type { FleetEntry } from "./manifest.ts";
import type { JournalEntry } from "./parsers/journal.ts";
import { deriveSummary, parseJournal } from "./parsers/journal.ts";
import type { Challenge, ParseError } from "./parsers/ledger.ts";
import { parseLedgerFile } from "./parsers/ledger.ts";

// 監視対象ファイル名（P3 で runs.jsonl を追加できるよう、ここに集約する）。
export const LEDGER_FILE_NAME = "challenge-ledger.md";
export const JOURNAL_FILE_NAME = path.join("journal", "index.jsonl");

export function ledgerPathFor(entry: FleetEntry): string {
  return path.join(entry.path, LEDGER_FILE_NAME);
}

export function journalPathFor(entry: FleetEntry): string {
  return path.join(entry.path, JOURNAL_FILE_NAME);
}

export type ScanResult = {
  challenges: Challenge[];
  journalEntries: JournalEntry[];
  parseErrors: ParseError[];
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 1 repo 分の challenge-ledger.md / journal/index.jsonl を読み込む。
 *
 * NFR-01: 読み取り専用（fs への書き込みは一切行わない）。
 * repo パス不存在・読み込み権限なし等は例外を投げず ParseError として返す
 * （クリティカル設計決定: 監視失敗は起動を止めず、該当エージェントのエラーとして可視化する）。
 */
export async function scanAgent(entry: FleetEntry): Promise<ScanResult> {
  const parseErrors: ParseError[] = [];
  let challenges: Challenge[] = [];
  let journalEntries: JournalEntry[] = [];

  const ledgerPath = ledgerPathFor(entry);
  try {
    const result = parseLedgerFile(ledgerPath);
    challenges = result.challenges;
    parseErrors.push(...result.errors);
  } catch (error) {
    parseErrors.push({
      file: ledgerPath,
      message: `challenge-ledger.md の読み込みに失敗しました: ${toErrorMessage(error)}`,
      raw: "",
    });
  }

  const journalPath = journalPathFor(entry);
  try {
    const result = await parseJournal(journalPath);
    journalEntries = result.entries;
    parseErrors.push(...result.errors);
  } catch (error) {
    parseErrors.push({
      file: journalPath,
      message: `journal/index.jsonl の読み込みに失敗しました: ${toErrorMessage(error)}`,
      raw: "",
    });
  }

  return { challenges, journalEntries, parseErrors };
}

/**
 * 1 repo をスキャンし cache へ反映（repo 単位の全量置き換え）した上で、
 * onAgentUpdate に更新後の AgentBoard を渡す（WS agent_update 配信への橋渡し）。
 */
export async function scanAndUpdateAgent(
  entry: FleetEntry,
  cache: BoardCache,
  onAgentUpdate?: (agent: AgentBoard) => void,
): Promise<void> {
  const { challenges, journalEntries, parseErrors } = await scanAgent(entry);

  // ホバー要約（FR-08）: journal の該当課題への言及から導出して challenge に載せる。
  // 導出の責務はこの合流点に一本化する（parser は素材、cache は格納に徹する）
  const challengesWithSummary = challenges.map((challenge) => ({
    ...challenge,
    summary: deriveSummary(journalEntries, challenge.id),
  }));

  cache.replaceAgent({
    name: entry.name,
    path: entry.path,
    challenges: challengesWithSummary,
    parseErrors,
  });
  cache.replaceJournal(entry.name, journalEntries);

  if (!onAgentUpdate) {
    return;
  }
  const updated = cache
    .getSnapshot()
    .agents.find((agent) => agent.name === entry.name);
  if (updated) {
    onAgentUpdate(updated);
  }
}

/**
 * 全 repo をスキャンする（起動時フルスキャン・低頻度フル再スキャンの両方から使う）。
 */
export async function fullScan(
  entries: FleetEntry[],
  cache: BoardCache,
  onAgentUpdate?: (agent: AgentBoard) => void,
): Promise<void> {
  for (const entry of entries) {
    await scanAndUpdateAgent(entry, cache, onAgentUpdate);
  }
}

// デバウンス・低頻度フル再スキャンのデフォルト値（チケットに具体値の指定はなく、
// 実装判断として設定）。エージェントの連続書き込み（1 サイクルで複数回 write する
// ことが多い）を吸収しつつ体感の遅延が出ない値として 500ms、
// ウォッチ漏れ対策のフル再スキャンは「数分間隔」の下限として 5 分を採用する。
// いずれも WatcherOptions で上書き可能。
export const DEFAULT_DEBOUNCE_MS = 500;
export const DEFAULT_FULL_RESCAN_INTERVAL_MS = 5 * 60 * 1000;

export type WatcherOptions = {
  /** 同一 repo への連続変更をまとめる時間（ミリ秒）。既定 {@link DEFAULT_DEBOUNCE_MS}。 */
  debounceMs?: number;
  /** ウォッチ漏れ対策の低頻度フル再スキャン間隔（ミリ秒）。既定 {@link DEFAULT_FULL_RESCAN_INTERVAL_MS}。 */
  fullRescanIntervalMs?: number;
};

export type FleetWatcher = {
  /** chokidar watcher・debounce タイマー・フル再スキャン interval をすべて停止する。 */
  close(): Promise<void>;
};

/**
 * fleet マニフェストの各 repo の challenge-ledger.md / journal/index.jsonl を
 * chokidar で監視し、変更検知 → 該当 repo のみ再パース → cache 反映 →
 * onAgentUpdate（WS agent_update 配信）を行う。ウォッチ漏れ対策として
 * fullRescanIntervalMs 間隔で全 repo のフル再スキャンも併用する。
 *
 * 監視対象ファイルへは一切書き込まない（NFR-01）。repo パス不存在などの監視失敗は
 * scanAgent 側で ParseError 化され起動全体を止めない（クリティカル設計決定）。
 */
export function startFleetWatcher(
  entries: FleetEntry[],
  cache: BoardCache,
  onAgentUpdate: (agent: AgentBoard) => void,
  options: WatcherOptions = {},
): FleetWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const fullRescanIntervalMs =
    options.fullRescanIntervalMs ?? DEFAULT_FULL_RESCAN_INTERVAL_MS;

  const entryByWatchedPath = new Map<string, FleetEntry>();
  const watchedPaths: string[] = [];
  for (const entry of entries) {
    const ledgerPath = ledgerPathFor(entry);
    const journalPath = journalPathFor(entry);
    entryByWatchedPath.set(path.resolve(ledgerPath), entry);
    entryByWatchedPath.set(path.resolve(journalPath), entry);
    watchedPaths.push(ledgerPath, journalPath);
  }

  const debounceTimers = new Map<string, NodeJS.Timeout>();

  function scheduleRescan(entry: FleetEntry): void {
    const existingTimer = debounceTimers.get(entry.name);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(entry.name);
      void scanAndUpdateAgent(entry, cache, onAgentUpdate);
    }, debounceMs);
    debounceTimers.set(entry.name, timer);
  }

  function handleFsEvent(changedPath: string): void {
    const entry = entryByWatchedPath.get(path.resolve(changedPath));
    if (entry) {
      scheduleRescan(entry);
    }
  }

  const chokidarWatcher = watch(watchedPaths, { ignoreInitial: true });
  // 監視失敗（権限不足等）で watcher プロセス全体が落ちないよう、
  // 'error' イベントには必ずハンドラを付ける（EventEmitter は未処理の
  // 'error' で throw する）。個別ファイルの読込失敗は scanAgent 側で
  // ParseError として可視化されるため、ここではログ出力のみに留める。
  chokidarWatcher.on("error", (error: unknown) => {
    console.error("[watcher] chokidar でエラーが発生しました:", error);
  });
  chokidarWatcher.on("add", handleFsEvent);
  chokidarWatcher.on("change", handleFsEvent);
  chokidarWatcher.on("unlink", handleFsEvent);

  const rescanInterval = setInterval(() => {
    void fullScan(entries, cache, onAgentUpdate);
  }, fullRescanIntervalMs);
  // board 停止（プロセス終了）を interval が妨げないようにする。
  rescanInterval.unref();

  return {
    async close(): Promise<void> {
      clearInterval(rescanInterval);
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      await chokidarWatcher.close();
    },
  };
}
