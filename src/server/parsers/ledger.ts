import * as fs from "node:fs";
import type { ParseError } from "./types.ts";

// 後方互換のための re-export（既存の import 元 `./ledger.ts` からの参照を維持する）。
// 単一定義は ./types.ts（セルフレビュー指摘対応: ParseError 三重定義の解消）。
export type { ParseError } from "./types.ts";

export type LedgerStatus =
  | "未分類"
  | "分類済"
  | "計画承認待ち"
  | "着手中"
  | "検証中"
  | "完了確認待ち"
  | "完了";

const VALID_STATUSES: ReadonlySet<string> = new Set<LedgerStatus>([
  "未分類",
  "分類済",
  "計画承認待ち",
  "着手中",
  "検証中",
  "完了確認待ち",
  "完了",
]);

export type Challenge = {
  id: string;
  title: string;
  status: LedgerStatus;
  priority?: string;
  position?: string;
  needsHuman: boolean;
  summary?: string;
};

const HEADER_PATTERN = /^###\s*\[([^\]]*)\]\s*(.*)$/;
// フェンス開始/終了行の判定に使う: バッククォート3連以上、または波ダッシュ3連以上。
// キャプチャした文字列の先頭文字（記号）と長さから、閉じ判定（同じ記号・開始以上の長さ）を行う。
const FENCE_LINE_PATTERN = /^\s*(`{3,}|~{3,})/;
const HTML_COMMENT_OPEN = "<!--";
const HTML_COMMENT_CLOSE = "-->";
// 分類欄フィールド行: 行頭 `- key: value`（インデントなし）。
// 承認チェックボックス行（`  - [ ] ...`）は2階層インデントのため、この正規表現には一致しない。
const FIELD_LINE_PATTERN = /^- ([^:]+): ?(.*)$/;
// 課題ID: "C-<数字>" を基本形とし、"C-002-4" のような枝番（ハイフン区切りの追加数字）も
// 許可する（claude-flywheel 側 journal サンプルに階層課題IDの実例が存在するため）。
const CHALLENGE_ID_PATTERN = /^C-\d+(?:-\d+)*$/;

type PendingEntry = {
  line: number;
  raw: string;
  idRaw: string;
  title: string;
  fields: Map<string, string>;
};

/**
 * 行内の `<!--` / `-->` マーカーを順に走査し、行末時点で HTML コメント中かどうかを返す。
 *
 * 1行内で開いて閉じるインラインコメント（例: フィールド行末尾の `<!-- fp:... -->`）は
 * 状態を変化させない（呼び出し側の startInComment / 戻り値がともに false のままになる）。
 * 一方、閉じマーカーの無い `<!--` が残る場合は true を返し、複数行コメントの開始として扱う。
 */
function scanCommentState(line: string, startInComment: boolean): boolean {
  let inComment = startInComment;
  let pos = 0;
  while (true) {
    if (inComment) {
      const closeIdx = line.indexOf(HTML_COMMENT_CLOSE, pos);
      if (closeIdx === -1) {
        return true;
      }
      inComment = false;
      pos = closeIdx + HTML_COMMENT_CLOSE.length;
    } else {
      const openIdx = line.indexOf(HTML_COMMENT_OPEN, pos);
      if (openIdx === -1) {
        return false;
      }
      inComment = true;
      pos = openIdx + HTML_COMMENT_OPEN.length;
    }
  }
}

/**
 * challenge-ledger.md の内容をパースする純粋関数（fs に依存しない）。
 *
 * NFR-05: フォーマットの解釈は claude-flywheel 側 challenge-ledger-format.md を正とし、
 * 独自解釈を持ち込まない。フェンスコードブロック（```）内、および HTML コメント
 * （`<!-- ... -->`）内の記入例はエントリとして解釈しない（CommonMark 仕様上コメントは
 * 文書内容でないため。雛形ファイルの誤検出防止）。フェンスとコメントは互いに排他的に扱い、
 * フェンス中はコメント判定を行わず、コメント中はフェンス判定を行わない。
 *
 * 壊れたエントリは他のエントリのパースに影響しない: 1エントリのヘッダー/ステータス等が
 * 不正な場合はそのエントリのみ ParseError として返し、他の正常なエントリは
 * challenges にそのまま含める。
 */
export function parseLedger(
  content: string,
  file: string,
): { challenges: Challenge[]; errors: ParseError[] } {
  const challenges: Challenge[] = [];
  const errors: ParseError[] = [];
  const lines = content.split(/\r?\n/);

  // 現在開いているフェンスの記号（`か~）と長さ。null なら非フェンス中。
  let fence: { char: string; length: number } | null = null;
  // 複数行 HTML コメント中かどうか。インラインで閉じるコメントはこの状態を変化させない。
  let inComment = false;
  let current: PendingEntry | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const entry = current;
    current = null;

    const issues: string[] = [];

    if (!CHALLENGE_ID_PATTERN.test(entry.idRaw.trim())) {
      issues.push(
        `id が不正です（"C-<数字>" 形式である必要があります）: "${entry.idRaw}"`,
      );
    }
    if (entry.title.length === 0) {
      issues.push("タイトルが空です");
    }

    const statusRaw = entry.fields.get("ステータス");
    if (statusRaw === undefined || statusRaw === "") {
      issues.push("ステータス フィールドが見つかりません");
    } else if (!VALID_STATUSES.has(statusRaw)) {
      issues.push(`ステータス が仕様外の値です: "${statusRaw}"`);
    }

    if (issues.length > 0) {
      errors.push({
        file,
        line: entry.line,
        message: issues.join("; "),
        raw: entry.raw,
      });
      return;
    }

    const status = statusRaw as LedgerStatus;
    const priority = entry.fields.get("優先度") || undefined;
    const position = entry.fields.get("担当ポジション") || undefined;

    challenges.push({
      id: entry.idRaw.trim(),
      title: entry.title,
      status,
      priority,
      position,
      needsHuman: status === "計画承認待ち" || status === "完了確認待ち",
      summary: undefined,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    if (fence) {
      // フェンス中: 同じ記号かつ開始以上の長さのフェンス行だけが閉じフェンスとして扱われる。
      // それ以外（別記号・より短い入れ子フェンス・通常行、`<!--` 等）はすべてフェンス内容として
      // 無視する（クリティカル設計決定: フェンス優先。コメント判定はここに到達させない）。
      const fenceMatch = line.match(FENCE_LINE_PATTERN);
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fence.char &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    // 複数行 HTML コメント中（フェンスが非活性の場合のみ判定）: コメント優先で、
    // コメント中に現れる ``` 等はフェンス開始として扱わない。
    // コメント開始行〜終了行まではエントリ内容として一切解釈せず丸ごとスキップする。
    if (inComment) {
      inComment = scanCommentState(line, true);
      continue;
    }

    const fenceMatch = line.match(FENCE_LINE_PATTERN);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      fence = { char: marker[0] ?? "`", length: marker.length };
      continue;
    }

    // HTML コメント開始判定: 1行内で開いて閉じるインラインコメント（例:
    // フィールド行末尾の `<!-- fp:... -->`）は状態遷移させず、行の内容はそのまま
    // 通常のフィールド行パースに渡す。閉じマーカーの無い `<!--` が残る場合のみ
    // 複数行コメントの開始として扱い、この行自体もスキップする。
    if (scanCommentState(line, false)) {
      inComment = true;
      continue;
    }

    const headerMatch = line.match(HEADER_PATTERN);
    if (headerMatch) {
      flush();
      current = {
        line: lineNo,
        raw: line,
        idRaw: headerMatch[1] ?? "",
        title: (headerMatch[2] ?? "").trim(),
        fields: new Map(),
      };
      continue;
    }

    if (!current) {
      // 最初のエントリより前の行（見出しコメント等）は無視する。
      continue;
    }

    // 承認チェックボックス行など2階層以上インデントされたネスト項目は
    // フィールド行として扱わない（今回のパース対象外）。
    if (/^\s{2,}\S/.test(line)) {
      continue;
    }

    const fieldMatch = line.match(FIELD_LINE_PATTERN);
    if (fieldMatch) {
      const key = (fieldMatch[1] ?? "").trim();
      const value = (fieldMatch[2] ?? "").trim();
      if (!current.fields.has(key)) {
        current.fields.set(key, value);
      }
    }
  }
  flush();

  return { challenges, errors };
}

/**
 * challenge-ledger.md を実ファイルから読み込み parseLedger に委譲する。
 * NFR-01: 読み取り専用（fs.readFileSync のみを使用し、書き込みは行わない）。
 */
export function parseLedgerFile(filePath: string): {
  challenges: Challenge[];
  errors: ParseError[];
} {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseLedger(content, filePath);
}
