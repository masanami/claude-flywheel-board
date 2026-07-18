import { readFile } from "node:fs/promises";
import type { LogEntry, ParseError } from "./types.ts";

// .flywheel/runs.jsonl のスキーマ（正本: claude-flywheel 側
// templates/runtime/README.md「実行イベントログ（runs.jsonl）」PR #45 確定版）。
// board は消費者に徹し、フィールド名・構造は正本仕様通りとする（NFR-05）。
// 実装パターンは journal.ts の parseJournal と揃える（行ごとの JSON.parse →
// バリデーション → ParseError 蓄積。壊れた行だけを積み、正常な行は活かす）。
//
// runs.jsonl は journal/index.jsonl と異なり**遅延生成**される（claude-flywheel
// 側で初回 append 時に mkdir -p .flywheel）かつ .gitignore 対象。journal は
// テンプレートで scaffold され常に存在する前提だが、runs.jsonl は
// 新規/未稼働エージェントでは存在しないのが正常状態（parseRuns の ENOENT
// ハンドリング参照）。

// 後方互換のための re-export（既存の import 元 `./runs.ts` からの参照を維持する）。
// 単一定義は ./types.ts（セルフレビュー指摘対応: ParseError 三重定義の解消）。
export type { ParseError } from "./types.ts";

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

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * .flywheel/runs.jsonl（append-only JSONL）を行ごとにパースする。
 * マッチング（start/end 対応付け）は行わない（matchRuns の責務）。
 */
export async function parseRuns(
  filePath: string,
): Promise<{ events: RunEvent[]; errors: ParseError[] }> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    // runs.jsonl は遅延生成（claude-flywheel 側の初回 append 時に mkdir -p .flywheel）
    // かつ .gitignore 対象（正本仕様）。journal/index.jsonl のようにテンプレートで
    // scaffold されるファイルとは異なり、新規/未稼働エージェントでは存在しないのが
    // 正常状態のため、ENOENT はエラーカード化せず「イベント 0 件」として扱う。
    // 権限エラー等 ENOENT 以外は従来どおり呼び出し元（scanAgent）で ParseError 化
    // されるよう、ここでは再送出する。
    if (isEnoent(error)) {
      return { events: [], errors: [] };
    }
    throw error;
  }
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
  /**
   * 同一 kind+key で新しい start が来た時点で、この Run（旧 start）が
   * supersede されたことを示す。合成の endedAt は作らない（実在しない終了
   * イベントを作らないため）。deriveRuns は superseded な Run にも通常どおり
   * stale を計算するが、実行中導出の消費側（deriveRunningRuns /
   * deriveCycleStatus。ひいては resumable 判定 isResumableDelegateRun）は
   * superseded な Run を除外してから stale を参照するため、実行中扱いには
   * ならない。ログ導出（deriveRunLogEntries）は実在した start イベントとして
   * 表示を維持する（除外対象外）。
   */
  superseded?: boolean;
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
 * 同一キーのバケツ内にある未終了（endedAt === undefined）かつ未 supersede
 * の Run をすべて superseded: true にする。新しい start が来た時点で
 * 呼び出す（1 つの key につき未終了 Run は常に高々 1 つになる導出規則）。
 * 合成の endedAt は作らない（実在しない終了イベントを作らないため）。
 */
function supersedeOpenRuns(bucket: MatchedRun[]): void {
  for (const run of bucket) {
    if (run.endedAt === undefined && !run.superseded) {
      run.superseded = true;
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
        const bucket = bucketFor("cycle", event.cycle);
        supersedeOpenRuns(bucket);
        const run: MatchedRun = {
          kind: "cycle",
          key: event.cycle,
          startedAt: event.ts,
        };
        bucket.push(run);
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
        const bucket = bucketFor("delegate", event.session_id);
        supersedeOpenRuns(bucket);
        const run: MatchedRun = {
          kind: "delegate",
          key: event.session_id,
          challenge: event.challenge,
          repo: event.repo,
          startedAt: event.ts,
        };
        bucket.push(run);
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
        const bucket = bucketFor("adhoc", event.id);
        supersedeOpenRuns(bucket);
        const run: MatchedRun = {
          kind: "adhoc",
          key: event.id,
          challenge: event.challenge,
          repo: event.repo,
          title: event.title,
          startedAt: event.ts,
        };
        bucket.push(run);
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
 * 正の有限数かどうか（しきい値として使える値かどうか）を判定する。
 * 0 以下（負値・0含む）・NaN・Infinity は「不正値」として扱う
 * （しきい値0以下だと実行中 Run が即 stale 化してしまうため。セルフレビュー指摘対応）。
 * 環境変数・引数 override の両方の検証に使う共通ロジック（CodeRabbit 指摘対応:
 * 従来は環境変数のみ検証していたが、override も同じ基準で検証する）。
 */
function isPositiveFiniteMinutes(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * しきい値（分）の解決順: 引数優先 → 環境変数 FLYWHEEL_BOARD_STALE_MINUTES
 * （数値としてパース。不正値は無視してデフォルトへ fallback） → デフォルト30分
 * （manifest.ts の resolveFleetManifestPath と同じパターン）。
 * 引数 override・環境変数のどちらも、正の有限数でなければ「不正値」として無視し
 * 次の優先順位（override 不正 → 環境変数 → デフォルト）へフォールバックする。
 */
export function resolveStaleMinutes(overrideMinutes?: number): number {
  if (
    overrideMinutes !== undefined &&
    isPositiveFiniteMinutes(overrideMinutes)
  ) {
    return overrideMinutes;
  }
  const fromEnv = process.env[STALE_MINUTES_ENV_KEY];
  if (fromEnv !== undefined) {
    const parsed = Number(fromEnv);
    if (isPositiveFiniteMinutes(parsed)) {
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

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * ログの時系列統合のためのソートキー正規化。journal 由来の ts は
 * "YYYY-MM-DD"（日付のみ）、runs 由来の ts はフル ISO（オフセット付き）。
 *
 * 日付のみの ts は**ローカル日の深夜**として解釈する（`new Date(y, m-1, d)` は
 * ローカルタイムゾーンで解釈されるコンストラクタ形式）。以前は
 * `Date.parse(`${ts}T00:00:00.000Z`)` で UTC 深夜固定にしていたが、+09:00 環境
 * では同日午前（例: 08:00+09:00 = 前日 23:00Z）の runs イベントが
 * journal の当日マーカー（00:00Z）より前に来てしまい、同日内でも
 * 逆転する不具合があった（TZ境界バグ）。board はローカルマシン上で動く前提
 * （NFR-01・アーキ上の位置づけ）のため、journal/runs 双方をプロセスの
 * ローカルタイムゾーン基準で比較することで、同一暦日内では常に journal の
 * マーカーが runs イベントより先に来る一貫したルールにする。
 */
export function logEntrySortKey(entry: LogEntry): number {
  const match = entry.ts.match(DATE_ONLY_PATTERN);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return new Date(year, month - 1, day).getTime();
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
