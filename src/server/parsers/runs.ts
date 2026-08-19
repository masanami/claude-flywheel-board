import { readFile } from "node:fs/promises";
import { isExistingCalendarDate } from "./calendar-date.ts";
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

// parseRuns が実ファイルから読み取った際に付与する由来情報。
// optional のため、テストコード等で RunEvent を手動構築する場合は省略可
// （省略時は matchRuns 側で provenance を付与しない＝後方互換）。
//
// file の実値（セルフレビュー指摘対応）: parseRuns の provenanceFile 引数が
// そのまま入る（省略時は読み取りに使った filePath）。呼び出し元（watcher.ts）は
// 「repo ルートからの相対パス」（例: ".flywheel/runs.jsonl"。RunProvenance.file の
// 設計意図・FR-A2 の表示例）を明示的に渡すことを想定しており、省略した場合の
// 既定値（filePath そのまま）は通常フルパスになる点に注意（parseRuns 自身は
// repo ルートを知らないため、相対化はできない）。
type EventOrigin = {
  /** 導出元ファイル（parseRuns の provenanceFile 引数。省略時は filePath がそのまま入る） */
  file?: string;
  /** 生 JSON 1行（parseRuns が読み取った元の行文字列がそのまま入る） */
  raw?: string;
};

export type CycleStartEvent = EventOrigin & {
  ts: string;
  event: "cycle_start";
  cycle: string;
};

export type CycleEndEvent = EventOrigin & {
  ts: string;
  event: "cycle_end";
  cycle: string;
  result: "completed" | "abandoned";
};

export type DelegateStartEvent = EventOrigin & {
  ts: string;
  event: "delegate_start";
  challenge: string;
  repo: string;
  session_id: string;
};

export type DelegateEndEvent = EventOrigin & {
  ts: string;
  event: "delegate_end";
  challenge: string;
  repo: string;
  session_id: string;
  result: string;
};

export type AdhocStartEvent = EventOrigin & {
  ts: string;
  event: "adhoc_start";
  id: string;
  title: string;
  challenge?: string;
  repo?: string;
};

export type AdhocEndEvent = EventOrigin & {
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

/**
 * parseRuns が返す events の要素型（セルフレビュー指摘対応: 「provenance は
 * パーサ発生源で付与する」という設計意図を型でも保証する）。file/raw が
 * EventOrigin では optional（テストコード等での手動構築を許容するため）
 * なのに対し、parseRuns を経由した events は必ず両方を持つことを
 * required で表現する。RunEvent の各ユニオン member との構造的な互換性は
 * 保ったまま（file/raw を狭めるだけ）なので、matchRuns(events: RunEvent[])
 * へそのまま渡せる（SourcedRunEvent は RunEvent のサブタイプ）。
 */
export type SourcedRunEvent = RunEvent & { file: string; raw: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ts の先頭が YYYY-MM-DD の形をしているかの判定（暦日の実在検証を掛ける対象の絞り込み）。
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  // Date.parse は "2026-02-31T10:00:00+09:00" を 2026-03-03 へ繰り上げて受理する。
  // 検証を Date.parse だけに委ねると、存在しない日時が**別の実在時刻にすり替わった
  // まま**経過時間・並び順・stale 判定に流れる（値の取り違えであって、単なる緩さでは
  // ない）。上流契約が pattern＋format: date-time の二層で拒否している型のため、
  // 先頭が YYYY-MM-DD の形なら暦日として実在することまで検証する
  // （正本: claude-flywheel 側 contracts/schemas/runs.schema.json）。
  if (
    ISO_DATE_PREFIX.test(value) &&
    !isExistingCalendarDate(value.slice(0, 10))
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
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
    return "ts は暦日として実在する Date.parse 可能な ISO 8601 文字列である必要があります";
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
 *
 * @param filePath 実際にファイルを読み取るパス（ParseError.file にもそのまま使う。
 *   診断用途のため呼び出し元がファイルシステム上で特定できる実パスを渡す）。
 * @param provenanceFile 返す events の file（≒ RunProvenance.file）に使う表示用パス。
 *   省略時は filePath がそのまま入る（parseRuns 自身は repo ルートを知らないため
 *   相対化できない）。呼び出し元（watcher.ts）は repo ルートからの相対パス
 *   （例: ".flywheel/runs.jsonl"）を渡すことを想定する（セルフレビュー指摘対応:
 *   RunProvenance.file の設計意図「repo ルートからの相対パス」と実値の乖離を解消）。
 */
export async function parseRuns(
  filePath: string,
  provenanceFile: string = filePath,
): Promise<{ events: SourcedRunEvent[]; errors: ParseError[] }> {
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

  const events: SourcedRunEvent[] = [];
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

    // provenance の発生源: パース時に読み取った provenanceFile・生の行文字列
    // （rawLine そのまま）を保持する。後段（matchRuns）で JSON.stringify 等
    // により復元すると元のフォーマット（キー順・空白）が失われるため、
    // ここで一度読んだ生行を素材として引き継ぐ（機能仕様の設計決定）。
    //
    // メモリ保持についての既知のトレードオフ（セルフレビュー指摘対応・対応は
    // 見送り＝YAGNI）: rawLine は content.split("\n") のスライスであり、V8 の
    // 実装次第では元の content 文字列全体への参照を保持し得る。長期間
    // キャッシュされるのは MatchedRun.provenance.raw（delegate_start/
    // adhoc_start の Run のみ。cache.replaceRuns が repo 単位で全量置き換え
    // する度に古い参照は破棄される）であり、runs.jsonl は現状の運用規模
    // （エージェントあたり数〜数十イベント）では実害が無い想定。ファイルが
    // 大きく育つ環境で問題化したら対処する。
    //
    // スプレッド→上書きの順序は意図的（セルフレビュー指摘対応）: 現行の
    // runs.jsonl 正本スキーマ（claude-flywheel 側）は file/raw というフィールド
    // 名を使わないため validateRunEvent を通過した parsed に file/raw が
    // 含まれることは無い想定だが、万一将来スキーマが同名フィールドを追加した
    // 場合でも、ここで明示的に上書きすることで provenance の file/raw は
    // 常に「parseRuns が読み取った実際の値」になる（正本データを黙って
    // 欠落させるのではなく、provenance という別の関心事のフィールドとして
    // 決定的に上書きする）契約をコメントで明示しておく。
    events.push({
      ...(parsed as RunEvent),
      file: provenanceFile,
      raw: rawLine,
    } as SourcedRunEvent);
  }

  return { events, errors };
}

/**
 * run 由来のタスク行の取得元（provenance。Issue #85 / #96）。
 * kind: "delegate" / "adhoc" の MatchedRun にのみ付与し、kind: "cycle" では
 * 常に undefined のまま（cycle はスコープ外の決定を型レベルでも反映するため
 * event はリテラルユニオンで cycle_start を除外している）。
 * 位置情報（行番号）は含めない（追記型 jsonl では行番号がすぐ古びるため、
 * レコードキーを正とする設計決定。FR-A5）。
 */
export type RunProvenance = {
  /**
   * 導出元ファイル（repo ルートからの相対パス。例: ".flywheel/runs.jsonl"）。
   * 実値は parseRuns の provenanceFile 引数がそのまま入る（セルフレビュー
   * 指摘対応: 呼び出し元が repo ルートからの相対パスを明示的に渡す契約。
   * 引数省略時は読み取りに使った filePath がそのまま入るため、その場合は
   * 相対パスにならない点に注意）。
   */
  file: string;
  /** 開始イベント種別（cycle はスコープ外のためリテラルユニオンで型レベルでも除外） */
  event: "delegate_start" | "adhoc_start";
  /** 開始イベントの ts（ISO 8601） */
  ts: string;
  /** レコードキー（delegate: session_id / adhoc: id） */
  key: string;
  /** 開始イベントの生 JSON 1行（そのまま） */
  raw: string;
  /** 対応する end イベントが存在するか */
  hasEnd: boolean;
};

export type MatchedRun = {
  kind: "cycle" | "delegate" | "adhoc";
  key: string; // cycle 名 | session_id | adhoc id
  challenge?: string;
  repo?: string;
  title?: string; // adhoc のみ
  startedAt: string; // ISO 8601（start イベントの ts）
  endedAt?: string; // 対応する end があれば ISO 8601
  result?: string; // end の result
  /** 取得元（delegate/adhoc のみ付与。cycle は常に undefined） */
  provenance?: RunProvenance;
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
  /**
   * kind: "cycle" かつ未終了（endedAt 未設定）の Run にのみ付与する「最終活動時刻」
   * （heartbeat。Issue #154）。cycle の stale 判定はこの時刻からの経過で行う
   * （開始からの経過ではない）。それ以外の Run では常に undefined。
   *
   * 算出は matchRuns の責務（deriveRuns ではない。codex 指摘対応）: heartbeat の
   * 定義は「サイクル開始以降の最新**イベント** ts」（architecture.md §3.3）であり、
   * MatchedRun[] は start とペアになった end しか保持しないため素材として不足する
   * （start 行が壊れて ParseError になった場合、後続の valid な delegate_end /
   * adhoc_end / cycle_end は closeLatestOpenRun が閉じる相手を見つけられず ts ごと
   * 落ちる）。イベント列を持つ matchRuns で算出することで、その取りこぼしを無くす。
   * 時刻非依存の純粋な導出のため matchRuns 側に置いても stale 判定（時刻依存）の
   * テスト容易性は損なわれない。
   */
  lastActivityAt?: string;
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
 *
 * 不変条件（セルフレビュー指摘対応）: run.endedAt と run.provenance.hasEnd は
 * 論理的に同じ事実（対応する end が来たか）を指す。endedAt を設定する経路は
 * このコード（closeLatestOpenRun）だけに一本化されているため、両者は常に
 * このブロック内で同時に更新すること。将来 endedAt を設定する別経路を
 * 追加する場合は、hasEnd の更新漏れが FR-A4「対応する end なし」表示の
 * 誤りに直結する点に注意。
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
      if (run.provenance) {
        run.provenance = { ...run.provenance, hasEnd: true };
      }
      return;
    }
  }
}

/**
 * delegate_start / adhoc_start イベントから RunProvenance を組み立てる。
 * イベントに file/raw が両方揃っている場合のみ組み立て、どちらか欠ける場合
 * （テストコード等で RunEvent を手動構築し parseRuns を経由していない場合）は
 * undefined を返す（後方互換: provenance を付与しない）。
 */
function buildProvenance(
  event: DelegateStartEvent | AdhocStartEvent,
  key: string,
): RunProvenance | undefined {
  if (event.file === undefined || event.raw === undefined) {
    return undefined;
  }
  return {
    file: event.file,
    event: event.event,
    ts: event.ts,
    key,
    raw: event.raw,
    hasEnd: false,
  };
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
 * 未終了の cycle Run に「最終活動時刻」（heartbeat。MatchedRun.lastActivityAt）を
 * 付与する。cycle の startedAt 以降に記録された**全イベント**の ts のうち最新の
 * ものを採り、該当が無ければ cycle 自身の startedAt（＝サイクル開始が最後の活動）
 * を入れるため、値は常に定義される。
 *
 * 素材が MatchedRun[] ではなく RunEvent[] であることが本質（codex 指摘対応）:
 * matched は start とペアになった end しか保持しないため、start 行が壊れて
 * ParseError になったケースの end（valid な delegate_end / adhoc_end / cycle_end）は
 * matched から復元できず、直近に活動があってもサイクルが stale のまま残ってしまう。
 *
 * 終了済み cycle には付けない（stale 対象外のため不要。FR 上も表示しない）。
 */
function assignCycleHeartbeats(runs: MatchedRun[], events: RunEvent[]): void {
  for (const run of runs) {
    if (run.kind !== "cycle" || run.endedAt !== undefined) continue;
    const cycleStartMs = Date.parse(run.startedAt);
    let latestAt = run.startedAt;
    let latestMs = cycleStartMs;
    for (const event of events) {
      const tsMs = Date.parse(event.ts);
      if (tsMs >= cycleStartMs && tsMs > latestMs) {
        latestAt = event.ts;
        latestMs = tsMs;
      }
    }
    run.lastActivityAt = latestAt;
  }
}

/**
 * start/end のマッチングと、未終了 cycle の heartbeat 付与を行う（いずれも
 * 時刻非依存の純粋関数。stale 判定＝時刻との比較は deriveRuns の責務）。
 * 対応付けキーはイベント種別ごと（cycle→cycle / delegate→session_id / adhoc→id）。
 * resume 規則（同一キーの最新の未終了 start に end を対応付ける）は cycle/adhoc にも
 * 同じロジックを一般化して適用する。
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
          provenance: buildProvenance(event, event.session_id),
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
          provenance: buildProvenance(event, event.id),
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

  // 全イベントを走査し終えてから付与する（cycle が後続の cycle_end で閉じられる
  // ケースがあるため、ループ内では「未終了かどうか」が確定しない）。
  assignCycleHeartbeats(order, events);

  return order;
}

// lastActivityAt（heartbeat）は MatchedRun 側に持つ（matchRuns が付与する）ため、
// Run は stale を足すだけ。消費側から見た Run の形は従来どおり
// （kind: "cycle" かつ未終了なら lastActivityAt を持つ）。
export type Run = MatchedRun & {
  stale: boolean;
};

/**
 * startedAt（ISO 8601）から nowMs 時点までの経過ミリ秒を計算する共有ヘルパー。
 * stale 判定（deriveRuns）と実行中シグネチャの経過分バケット計算
 * （stale-reevaluation.ts の computeAgentSignature）の両方が「now - Date.parse(startedAt)」
 * を個別に計算していたのを集約する（Issue #36 項目2）。
 */
export function computeElapsedMs(startedAt: string, nowMs: number): number {
  return nowMs - Date.parse(startedAt);
}

/**
 * stale を付与する純粋関数。now を引数で受け取ることでテストが時刻を Mock
 * できるようにする。判定の起点は kind によって異なる（Issue #154）:
 *
 * - delegate / adhoc: 実行中（endedAt 未設定）かつ **開始からの経過** がしきい値超過。
 *   委譲・差し込みは「開始したまま終了記録が来ない」ことが異常のサインであり、
 *   従来どおりの判定を維持する。
 * - cycle: 実行中かつ **最終活動（heartbeat）からの経過** がしきい値超過、かつ
 *   実行中の非 stale な delegate/adhoc が 1 つも無いとき。run-cycle の 1 周は
 *   委譲を含めると数時間に及ぶのが正常であり、開始からの経過で判定すると
 *   正常稼働中のエージェントが恒常的に stale になるため（誤検知の解消）。
 *
 * heartbeat 自体の算出は matchRuns の責務（時刻非依存のため。詳細は
 * MatchedRun.lastActivityAt / assignCycleHeartbeats のコメント）。ここは
 * 付与済みの値を now と比較するだけに徹する。
 */
export function deriveRuns(
  matched: MatchedRun[],
  now: Date,
  staleMinutes: number,
): Run[] {
  const nowMs = now.getTime();
  const thresholdMs = staleMinutes * 60_000;

  const isOpenAndStale = (run: MatchedRun): boolean =>
    run.endedAt === undefined &&
    computeElapsedMs(run.startedAt, nowMs) > thresholdMs;

  // 実行中（かつ supersede されていない）非 stale な delegate/adhoc が 1 つでも
  // あれば、少なくとも子の見込み時間内はエージェントが生きているとみなし、
  // cycle を stale にしない（Issue #154 の対応方針）。
  //
  // 現行のしきい値共有（cycle と delegate/adhoc が同じ staleMinutes）の下では、
  // このガードは heartbeat 判定に含意されており単独では発火しない
  // （子の startedAt は heartbeat の候補に入るので heartbeat >= 子の開始 →
  // 「子が非 stale」なら必ず「heartbeat からの経過もしきい値以下」になる）。
  // それでも明示的に残すのは、#154 の人間指示で挙がっている「kind 別しきい値の
  // 分離」（例: delegate だけ 180 分）を入れた瞬間にこの条件が効き始める
  // ＝長時間の委譲中にサイクルを緑のまま保つ役割を担うため。意図した規則を
  // コード上に残しておく。
  const hasLiveChildRun = matched.some(
    (run) =>
      run.kind !== "cycle" &&
      run.endedAt === undefined &&
      !run.superseded &&
      !isOpenAndStale(run),
  );

  return matched.map((run) => {
    if (run.endedAt !== undefined) {
      return { ...run, stale: false };
    }
    if (run.kind !== "cycle") {
      return { ...run, stale: isOpenAndStale(run) };
    }
    // heartbeat は matchRuns が付与済み（イベント列が素材）。未設定になるのは
    // matchRuns を経由せず MatchedRun を手組みした場合だけで、その際は
    // 「サイクル開始が最後の活動」＝従来どおり開始起点の判定にフォールバックする。
    const lastActivityAt = run.lastActivityAt ?? run.startedAt;
    const stale =
      !hasLiveChildRun && computeElapsedMs(lastActivityAt, nowMs) > thresholdMs;
    return { ...run, stale, lastActivityAt };
  });
}

export type AgentCycleStatus = "running" | "idle" | "stale";

/**
 * runs.jsonl 由来の Run[] から、エージェントの現在の cycle 状態を導出する
 * 純粋関数（cache.ts から移設。Issue #36 項目2: parser は素材・cache は格納
 * という役割分担に合わせ、deriveRuns 等の仲間として同居させる）。
 */
export function deriveCycleStatus(runs: Run[]): AgentCycleStatus {
  const openCycles = runs.filter(
    (run) =>
      run.kind === "cycle" && run.endedAt === undefined && !run.superseded,
  );
  if (openCycles.length === 0) {
    return "idle";
  }
  return openCycles.some((run) => run.stale) ? "stale" : "running";
}

/**
 * 実行中（open）な cycle Run の最終活動時刻（heartbeat。Issue #154）を返す。
 * cycleStatus が "stale" のときの経過時間表示（UI のカラムヘッダ）に使う。
 * 実行中の cycle が無ければ undefined。複数ある（通常は supersede されるため
 * 起きない）場合は最も新しい最終活動時刻を返す。
 */
export function deriveCycleLastActivityAt(runs: Run[]): string | undefined {
  let latestAt: string | undefined;
  for (const run of runs) {
    if (run.kind !== "cycle" || run.endedAt !== undefined || run.superseded) {
      continue;
    }
    if (run.lastActivityAt === undefined) continue;
    if (
      latestAt === undefined ||
      Date.parse(run.lastActivityAt) > Date.parse(latestAt)
    ) {
      latestAt = run.lastActivityAt;
    }
  }
  return latestAt;
}

/**
 * runs.jsonl 由来の Run[] から、実行中の delegate/adhoc Run のみを導出する
 * 純粋関数（cache.ts から移設。cycle は cycleStatus 側で表現するため除外）。
 */
export function deriveRunningRuns(runs: Run[]): Run[] {
  return runs.filter(
    (run) =>
      run.kind !== "cycle" && run.endedAt === undefined && !run.superseded,
  );
}

// 既定 60 分（Issue #154 の人間指示。従来 30 分）。cycle は heartbeat 起点・
// delegate/adhoc は開始起点と判定の起点が異なるが、しきい値は 1 つを共有する
// （kind 別 override は運用実績が出るまで持たない＝YAGNI。必要になったら
// resolveStaleMinutes に kind 引数を足す形で拡張できる）。
export const DEFAULT_STALE_MINUTES = 60;
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
 * （数値としてパース。不正値は無視してデフォルトへ fallback） → デフォルト60分
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
