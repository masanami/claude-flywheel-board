import * as fs from "node:fs";
import * as path from "node:path";
import { watch } from "chokidar";
import type { AgentBoard, BoardCache } from "./cache.ts";
import type { FleetEntry } from "./manifest.ts";
import type { JournalEntry } from "./parsers/journal.ts";
import { deriveSummary, parseJournal } from "./parsers/journal.ts";
import type { Challenge } from "./parsers/ledger.ts";
import { parseLedgerFile } from "./parsers/ledger.ts";
import type { MatchedRun } from "./parsers/runs.ts";
import { matchRuns, parseRuns } from "./parsers/runs.ts";
import type { ParseError } from "./parsers/types.ts";

// 監視対象ファイル名（P3 で runs.jsonl を追加できるよう、ここに集約する）。
export const LEDGER_FILE_NAME = "challenge-ledger.md";
export const JOURNAL_FILE_NAME = path.join("journal", "index.jsonl");
export const RUNS_FILE_NAME = path.join(".flywheel", "runs.jsonl");
// Issue #50 ①: 台帳のアーカイブ（完了エントリの移動先）。将来の年次分割
// （challenge-archive-2026.md 等）に備え、固定ファイル名ではなく glob で扱う
// （claude-flywheel 側 docs/challenge-ledger-format.md §アーカイブ・
// skills/ingest-challenges/SKILL.md と同じ運用に揃える）。
export const ARCHIVE_GLOB_PATTERN = "challenge-archive*.md";
const ARCHIVE_FILE_NAME_PATTERN = /^challenge-archive.*\.md$/;

export function ledgerPathFor(entry: FleetEntry): string {
  return path.join(entry.path, LEDGER_FILE_NAME);
}

export function journalPathFor(entry: FleetEntry): string {
  return path.join(entry.path, JOURNAL_FILE_NAME);
}

export function runsPathFor(entry: FleetEntry): string {
  return path.join(entry.path, RUNS_FILE_NAME);
}

export function archiveGlobFor(entry: FleetEntry): string {
  return path.join(entry.path, ARCHIVE_GLOB_PATTERN);
}

export type ScanResult = {
  challenges: Challenge[];
  journalEntries: JournalEntry[];
  matchedRuns: MatchedRun[];
  archivedChallenges: Challenge[];
  parseErrors: ParseError[];
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 1 repo 分の challenge-archive*.md（年次分割 glob）を読み込む。
 *
 * クリティカル設計決定（NFR-05）: アーカイブは台帳と同じエントリ形式のため、
 * 新しい独自パーサを書かず既存の parseLedgerFile をそのまま流用する。
 *
 * 空安全（クリティカル設計決定）: アーカイブファイルが1つも無い場合
 * （entry.path 自体が存在しない場合を含む）は fs.globSync が例外を投げず
 * 空配列を返すため、ENOENT を特別扱いする必要なく自然に
 * `{ challenges: [], errors: [] }` になる（runs.jsonl の ENOENT 寛容処理と
 * 同じ帰結）。列挙後の個別ファイル読み込みで生じた非ENOENTエラー（権限不足等）
 * のみ ParseError として可視化する。
 */
function scanArchive(entry: FleetEntry): {
  challenges: Challenge[];
  errors: ParseError[];
} {
  const challenges: Challenge[] = [];
  const errors: ParseError[] = [];

  // fs.globSync は Node 22 で追加された比較的新しい API（package.json の
  // engines: node>=22.18.0 で前提を満たす）。空安全の判定（存在しない cwd で
  // 例外を投げず空配列を返す）はこの API の実装依存の挙動であり、
  // watcher.test.ts の「repo パスが存在しない」ケースで固定して回帰検知する
  // （セルフレビュー指摘対応: 将来の Node バージョンで挙動が変わった場合も
  // このテストが最初に失敗する）。
  let fileNames: string[];
  try {
    fileNames = fs.globSync(ARCHIVE_GLOB_PATTERN, { cwd: entry.path });
  } catch (error) {
    errors.push({
      file: archiveGlobFor(entry),
      message: `challenge-archive*.md の列挙に失敗しました: ${toErrorMessage(error)}`,
      raw: "",
    });
    return { challenges, errors };
  }

  // 年次分割時も決定的な順序で連結するため、ファイル名の昇順で処理する。
  for (const fileName of [...fileNames].sort()) {
    const archivePath = path.join(entry.path, fileName);
    try {
      const result = parseLedgerFile(archivePath);
      challenges.push(...result.challenges);
      errors.push(...result.errors);
    } catch (error) {
      errors.push({
        file: archivePath,
        message: `${fileName} の読み込みに失敗しました: ${toErrorMessage(error)}`,
        raw: "",
      });
    }
  }

  return { challenges, errors };
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
  let matchedRuns: MatchedRun[] = [];

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

  // runs.jsonl は ledger/journal と異なり、ファイル不在（ENOENT）を parseRuns
  // 内部で正常状態として吸収する（遅延生成・新規/未稼働エージェントの通常状態のため）。
  // そのため ledger/journal と違い、ここで catch されるのは ENOENT 以外の
  // 読み込み失敗（権限不足等）のみになる（parser 層と scanAgent 層で
  // 責務が非対称になっている点は意図した設計判断。詳細は parseRuns 側コメント）。
  const runsPath = runsPathFor(entry);
  try {
    const result = await parseRuns(runsPath);
    matchedRuns = matchRuns(result.events);
    parseErrors.push(...result.errors);
  } catch (error) {
    parseErrors.push({
      file: runsPath,
      message: `.flywheel/runs.jsonl の読み込みに失敗しました: ${toErrorMessage(error)}`,
      raw: "",
    });
  }

  // Issue #50 ①: 台帳のアーカイブ（完了チケットを見る唯一の手段）。
  const archiveResult = scanArchive(entry);
  parseErrors.push(...archiveResult.errors);

  return {
    challenges,
    journalEntries,
    matchedRuns,
    archivedChallenges: archiveResult.challenges,
    parseErrors,
  };
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
  const {
    challenges,
    journalEntries,
    matchedRuns,
    archivedChallenges,
    parseErrors,
  } = await scanAgent(entry);

  // ホバー要約（FR-08）: journal の該当課題への言及から導出して challenge に載せる。
  // 導出の責務はこの合流点に一本化する（parser は素材、cache は格納に徹する）。
  // アーカイブ課題は表示粒度をミニマル（id/title/status）に留める設計判断のため、
  // summary 導出は行わない（Issue #50 ①）。
  const challengesWithSummary = challenges.map((challenge) => ({
    ...challenge,
    summary: deriveSummary(journalEntries, challenge.id),
  }));

  cache.replaceAgent({
    name: entry.name,
    path: entry.path,
    challenges: challengesWithSummary,
    archivedChallenges,
    parseErrors,
  });
  cache.replaceJournal(entry.name, journalEntries);
  cache.replaceRuns(entry.name, matchedRuns);

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
  // Issue #50 ①: challenge-archive*.md は年次分割で新規ファイルが後から
  // 現れうるため、ledger/journal/runs のような固定パスの Map には載せられない。
  // 代わりに repo ディレクトリ単位で解決する（entry.path 配下かつファイル名が
  // アーカイブ glob に一致すれば当該 repo とみなす）。
  //
  // 注意（セルフレビュー指摘対応）: 当初 `archiveGlobFor(entry)`（glob文字列
  // "challenge-archive*.md"）をそのまま watch() に渡していたが、本プロジェクトが
  // 使用する chokidar は v5（v4 で glob サポートが撤廃済み。node_modules/chokidar
  // の README 参照）のため、glob 文字列はリテラルパスとして扱われ実ファイルに
  // マッチせず、アーカイブの add/change/unlink は本番で一切発火しない no-op に
  // なっていた（実 chokidar で検証し確認済み）。代わりに repo ディレクトリ
  // （entry.path）自体を depth: 0（直下のみ・再帰しない）で watch することで、
  // 「entry.path 直下の challenge-archive*.md」という設計要求を満たしつつ、
  // repo 全体を再帰監視するコストは避ける。
  const entryByDir = new Map<string, FleetEntry>();
  const watchedPaths: string[] = [];
  for (const entry of entries) {
    const ledgerPath = ledgerPathFor(entry);
    const journalPath = journalPathFor(entry);
    const runsPath = runsPathFor(entry);
    entryByWatchedPath.set(path.resolve(ledgerPath), entry);
    entryByWatchedPath.set(path.resolve(journalPath), entry);
    entryByWatchedPath.set(path.resolve(runsPath), entry);
    entryByDir.set(path.resolve(entry.path), entry);
    watchedPaths.push(ledgerPath, journalPath, runsPath, entry.path);
  }

  // アーカイブ glob 経由のイベント（changedPath は実ファイルの具体パス）を
  // 対応する repo（entry）へ解決する。ledger/journal/runs と同様、
  // 対応が見つからない（未知の repo・パターン不一致）場合は undefined。
  function resolveArchiveEntry(resolvedPath: string): FleetEntry | undefined {
    if (!ARCHIVE_FILE_NAME_PATTERN.test(path.basename(resolvedPath))) {
      return undefined;
    }
    return entryByDir.get(path.dirname(resolvedPath));
  }

  const debounceTimers = new Map<string, NodeJS.Timeout>();

  // エージェント単位の直列化キュー: debounce 再スキャン・低頻度フル再スキャン・
  // ready 後の整合スキャンが同一エージェントに対して並行実行されると、
  // 先に始まった（が遅く終わる）古いスキャンの結果が後発の新しいスキャンの結果を
  // 上書きしてしまう恐れがある。エージェント名ごとに Promise チェーンを保持し、
  // 常に「前のスキャンが完了してから次のスキャンを開始する」ことで直列化する。
  const scanQueues = new Map<string, Promise<void>>();

  function enqueueScan(entry: FleetEntry): Promise<void> {
    const previous = scanQueues.get(entry.name) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // 前段の失敗はここで握り潰し、キューを止めない（下の catch で必ずログ済み）。
      })
      .then(() => scanAndUpdateAgent(entry, cache, onAgentUpdate))
      .catch((error: unknown) => {
        console.error(
          `[watcher] ${entry.name} のスキャンに失敗しました:`,
          error,
        );
      });
    scanQueues.set(entry.name, next);
    return next;
  }

  function scheduleRescan(entry: FleetEntry): void {
    const existingTimer = debounceTimers.get(entry.name);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(entry.name);
      void enqueueScan(entry);
    }, debounceMs);
    debounceTimers.set(entry.name, timer);
  }

  function handleFsEvent(changedPath: string): void {
    const resolved = path.resolve(changedPath);
    const entry =
      entryByWatchedPath.get(resolved) ?? resolveArchiveEntry(resolved);
    if (entry) {
      scheduleRescan(entry);
    }
  }

  // depth: 0 は entry.path（repo ディレクトリ）の直下のみを watch し、
  // サブディレクトリ（journal/ 等）へは再帰しない（Issue #50 ①のアーカイブ
  // ディレクトリ watch のためだけに repo 全体を再帰監視してしまわないようにする
  // ガード。ledger/journal/runs のような個別ファイルパスの watch には影響しない）。
  const chokidarWatcher = watch(watchedPaths, {
    ignoreInitial: true,
    depth: 0,
  });
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
  // chokidar は ignoreInitial: true のため、起動〜ready までに生じた変更が
  // 見逃される可能性がある（ready 到達までのイベントは初期化中として扱われる）。
  // ready 後に全 repo を1回スキャンし、見逃しがあっても整合させる。
  chokidarWatcher.on("ready", () => {
    for (const entry of entries) {
      void enqueueScan(entry);
    }
  });

  const rescanInterval = setInterval(() => {
    for (const entry of entries) {
      void enqueueScan(entry);
    }
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
      // 実行中（キュー待ち含む）のスキャンがすべて完了してから resolve する。
      await Promise.all(scanQueues.values());
    },
  };
}
