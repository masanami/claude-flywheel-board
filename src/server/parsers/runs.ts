import { readFile } from "node:fs/promises";
import type { LogEntry } from "./journal.ts";

// .flywheel/runs.jsonl のスキーマ（正本: claude-flywheel 側
// templates/runtime/README.md「実行イベントログ（runs.jsonl）」PR #45 確定版）。
// board は消費者に徹し、フィールド名・構造は正本仕様通りとする（NFR-05）。
// 実装パターンは journal.ts の parseJournal と揃える（行ごとの JSON.parse →
// バリデーション → ParseError 蓄積。壊れた行だけを積み、正常な行は活かす）。

export type ParseError = {
  file: string;
  line?: number;
  message: string;
  raw: string;
};

export type CycleStartEvent = {
  ts: string;
  event: "cycle_start";
  cycle: string;
};

export type CycleEndEvent = {
  ts: string;
  event: "cycle_end";
  cycle: string;
  result: "completed" | "abandoned";
};

export type DelegateStartEvent = {
  ts: string;
  event: "delegate_start";
  challenge: string;
  repo: string;
  session_id: string;
};

export type DelegateEndEvent = {
  ts: string;
  event: "delegate_end";
  challenge: string;
  repo: string;
  session_id: string;
  result: string;
};

export type AdhocStartEvent = {
  ts: string;
  event: "adhoc_start";
  id: string;
  title: string;
  challenge?: string;
  repo?: string;
};

export type AdhocEndEvent = {
  ts: string;
  event: "adhoc_end";
  id: string;
  result: string;
  challenge?: string;
  repo?: string;
};

export type RunEvent =
  | CycleStartEvent
  | CycleEndEvent
  | DelegateStartEvent
  | DelegateEndEvent
  | AdhocStartEvent
  | AdhocEndEvent;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

const EVENT_TYPES = [
  "cycle_start",
  "cycle_end",
  "delegate_start",
  "delegate_end",
  "adhoc_start",
  "adhoc_end",
] as const;

type EventType = (typeof EVENT_TYPES)[number];

function isEventType(value: unknown): value is EventType {
  return (
    typeof value === "string" &&
    (EVENT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * runs.jsonl の 1 行分（パース済み JSON）を検証する。妥当なら undefined を、
 * 不正ならエラーメッセージを返す（journal.ts の validateJournalEntry と同じ設計）。
 */
function validateRunEvent(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "runs エントリは JSON オブジェクトである必要があります";
  }
  const record = value;

  if (!isValidTimestamp(record.ts)) {
    return "ts は Date.parse 可能な ISO 8601 文字列である必要があります";
  }
  if (!isEventType(record.event)) {
    return `event は ${EVENT_TYPES.join(" | ")} のいずれかである必要があります`;
  }

  switch (record.event) {
    case "cycle_start":
      if (typeof record.cycle !== "string") {
        return "cycle_start には cycle (string) が必要です";
      }
      return undefined;
    case "cycle_end":
      if (typeof record.cycle !== "string") {
        return "cycle_end には cycle (string) が必要です";
      }
      if (record.result !== "completed" && record.result !== "abandoned") {
        return "cycle_end の result は completed | abandoned である必要があります";
      }
      return undefined;
    case "delegate_start":
      if (typeof record.challenge !== "string") {
        return "delegate_start には challenge (string) が必要です";
      }
      if (typeof record.repo !== "string") {
        return "delegate_start には repo (string) が必要です";
      }
      if (typeof record.session_id !== "string") {
        return "delegate_start には session_id (string) が必要です";
      }
      return undefined;
    case "delegate_end":
      if (typeof record.challenge !== "string") {
        return "delegate_end には challenge (string) が必要です";
      }
      if (typeof record.repo !== "string") {
        return "delegate_end には repo (string) が必要です";
      }
      if (typeof record.session_id !== "string") {
        return "delegate_end には session_id (string) が必要です";
      }
      if (typeof record.result !== "string") {
        return "delegate_end には result (string) が必要です";
      }
      return undefined;
    case "adhoc_start":
      if (typeof record.id !== "string") {
        return "adhoc_start には id (string) が必要です";
      }
      if (typeof record.title !== "string") {
        return "adhoc_start には title (string) が必要です";
      }
      if (
        !isOptionalString(record.challenge) ||
        !isOptionalString(record.repo)
      ) {
        return "adhoc_start の challenge / repo は string である必要があります（任意フィールド）";
      }
      return undefined;
    case "adhoc_end":
      if (typeof record.id !== "string") {
        return "adhoc_end には id (string) が必要です";
      }
      if (typeof record.result !== "string") {
        return "adhoc_end には result (string) が必要です";
      }
      if (
        !isOptionalString(record.challenge) ||
        !isOptionalString(record.repo)
      ) {
        return "adhoc_end の challenge / repo は string である必要があります（任意フィールド）";
      }
      return undefined;
  }
}

/**
 * .flywheel/runs.jsonl（append-only JSONL）を行ごとにパースする。
 * マッチング（start/end 対応付け）は行わない（matchRuns の責務）。
 */
export async function parseRuns(
  filePath: string,
): Promise<{ events: RunEvent[]; errors: ParseError[] }> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");

  const events: RunEvent[] = [];
  const errors: ParseError[] = [];

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    if (rawLine.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      errors.push({
        file: filePath,
        line: lineNumber,
        message: error instanceof Error ? error.message : String(error),
        raw: rawLine,
      });
      continue;
    }

    const validationError = validateRunEvent(parsed);
    if (validationError) {
      errors.push({
        file: filePath,
        line: lineNumber,
        message: validationError,
        raw: rawLine,
      });
      continue;
    }

    events.push(parsed as RunEvent);
  }

  return { events, errors };
}

export type MatchedRun = {
  kind: "cycle" | "delegate" | "adhoc";
  key: string; // cycle 名 | session_id | adhoc id
  challenge?: string;
  repo?: string;
  title?: string; // adhoc のみ
  startedAt: string; // ISO 8601（start イベントの ts）
  endedAt?: string; // 対応する end があれば ISO 8601
  result?: string; // end の result
};

// MatchedRun は agent フィールドを持たない（意図的な逸脱）: 既存の Challenge 型が
// agent を持たず、BoardCache が (agent, ...) の外側でエージェント名を管理する
// 既存パターンに合わせるため。エージェントスコープを Run 側でも二重管理しない。

function bucketKey(kind: MatchedRun["kind"], key: string): string {
  return `${kind}:${key}`;
}

/**
 * 同一キーのバケツを末尾から走査し、endedAt === undefined の最初の要素
 * （＝最新の未終了 start）を end で閉じる。対応する未終了 start が無ければ
 * 何もしない（ファイルローテーション等で start が欠落したケースは無視する。
 * 正本仕様に明記が無いため最小実装＝YAGNI）。
 */
function closeLatestOpenRun(
  bucket: MatchedRun[],
  endedAt: string,
  result: string,
): void {
  for (let i = bucket.length - 1; i >= 0; i--) {
    const run = bucket[i];
    if (run && run.endedAt === undefined) {
      run.endedAt = endedAt;
      run.result = result;
      return;
    }
  }
}

/**
 * start/end のマッチングのみを行う（時刻非依存の純粋関数。stale 判定は
 * deriveRuns の責務）。対応付けキーはイベント種別ごと（cycle→cycle /
 * delegate→session_id / adhoc→id）。resume 規則（同一キーの最新の未終了 start
 * に end を対応付ける）は cycle/adhoc にも同じロジックを一般化して適用する。
 */
export function matchRuns(events: RunEvent[]): MatchedRun[] {
  const buckets = new Map<string, MatchedRun[]>();
  const order: MatchedRun[] = [];

  function bucketFor(kind: MatchedRun["kind"], key: string): MatchedRun[] {
    const bucketId = bucketKey(kind, key);
    let bucket = buckets.get(bucketId);
    if (!bucket) {
      bucket = [];
      buckets.set(bucketId, bucket);
    }
    return bucket;
  }

  for (const event of events) {
    switch (event.event) {
      case "cycle_start": {
        const run: MatchedRun = {
          kind: "cycle",
          key: event.cycle,
          startedAt: event.ts,
        };
        bucketFor("cycle", event.cycle).push(run);
        order.push(run);
        break;
      }
      case "cycle_end": {
        closeLatestOpenRun(
          bucketFor("cycle", event.cycle),
          event.ts,
          event.result,
        );
        break;
      }
      case "delegate_start": {
        const run: MatchedRun = {
          kind: "delegate",
          key: event.session_id,
          challenge: event.challenge,
          repo: event.repo,
          startedAt: event.ts,
        };
        bucketFor("delegate", event.session_id).push(run);
        order.push(run);
        break;
      }
      case "delegate_end": {
        closeLatestOpenRun(
          bucketFor("delegate", event.session_id),
          event.ts,
          event.result,
        );
        break;
      }
      case "adhoc_start": {
        const run: MatchedRun = {
          kind: "adhoc",
          key: event.id,
          challenge: event.challenge,
          repo: event.repo,
          title: event.title,
          startedAt: event.ts,
        };
        bucketFor("adhoc", event.id).push(run);
        order.push(run);
        break;
      }
      case "adhoc_end": {
        closeLatestOpenRun(
          bucketFor("adhoc", event.id),
          event.ts,
          event.result,
        );
        break;
      }
    }
  }

  return order;
}

export type Run = MatchedRun & { stale: boolean };

/**
 * stale を付与する純粋関数。now を引数で受け取ることでテストが時刻を Mock
 * できるようにする（実行中 かつ 経過時間 > しきい値 なら stale）。
 */
export function deriveRuns(
  matched: MatchedRun[],
  now: Date,
  staleMinutes: number,
): Run[] {
  return matched.map((run) => {
    if (run.endedAt !== undefined) {
      return { ...run, stale: false };
    }
    const elapsedMs = now.getTime() - Date.parse(run.startedAt);
    return { ...run, stale: elapsedMs > staleMinutes * 60_000 };
  });
}

export const DEFAULT_STALE_MINUTES = 30;
const STALE_MINUTES_ENV_KEY = "FLYWHEEL_BOARD_STALE_MINUTES";

/**
 * しきい値（分）の解決順: 引数優先 → 環境変数 FLYWHEEL_BOARD_STALE_MINUTES
 * （数値としてパース。不正値は無視してデフォルトへ fallback） → デフォルト30分
 * （manifest.ts の resolveFleetManifestPath と同じパターン）。
 * 0 以下（空文字・負値含む）も「不正値」として扱いデフォルトへ fallback する
 * （しきい値0以下だと実行中 Run が即 stale 化してしまうため。セルフレビュー指摘対応）。
 */
export function resolveStaleMinutes(overrideMinutes?: number): number {
  if (overrideMinutes !== undefined) {
    return overrideMinutes;
  }
  const fromEnv = process.env[STALE_MINUTES_ENV_KEY];
  if (fromEnv !== undefined) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_STALE_MINUTES;
}

function describeRunSubject(run: MatchedRun): string {
  switch (run.kind) {
    case "cycle":
      return `サイクル ${run.key}`;
    case "delegate":
      return `delegate ${run.challenge ?? run.key} → ${run.repo ?? "?"}`;
    case "adhoc":
      return `差し込み「${run.title ?? run.key}」`;
  }
}

/**
 * runs.jsonl 由来の LogEntry（source: "runs"）を作る。各 MatchedRun の start に
 * ついて1件、end があれば追加で1件生成する（カード詳細の作業ログタイムラインへ
 * journal と統合するための素材。マージは mergeLogEntries の責務）。
 */
export function deriveRunLogEntries(matched: MatchedRun[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const run of matched) {
    entries.push({
      ts: run.startedAt,
      source: "runs",
      text: `実行開始: ${describeRunSubject(run)}`,
    });
    if (run.endedAt !== undefined) {
      entries.push({
        ts: run.endedAt,
        source: "runs",
        text: `実行終了: ${describeRunSubject(run)}（${run.result ?? "unknown"}）`,
      });
    }
  }
  return entries;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ログの時系列統合のためのソートキー正規化。journal 由来の ts は
 * "YYYY-MM-DD"（日付のみ）、runs 由来の ts はフル ISO。日付のみはその日の
 * 00:00 として扱うことで、同日内では runs イベントより先に来る一貫したルールにする。
 */
export function logEntrySortKey(entry: LogEntry): number {
  if (DATE_ONLY_PATTERN.test(entry.ts)) {
    return Date.parse(`${entry.ts}T00:00:00.000Z`);
  }
  return Date.parse(entry.ts);
}

/**
 * journal 由来・runs 由来の LogEntry[] をソートキー順に安定マージする。
 * Array.prototype.sort は安定ソートのため、同一ソートキー同士は
 * 引数リストに渡した順序（journal→runs）・各リスト内の元の順序を維持する。
 */
export function mergeLogEntries(...entryLists: LogEntry[][]): LogEntry[] {
  return entryLists
    .flat()
    .sort((a, b) => logEntrySortKey(a) - logEntrySortKey(b));
}
