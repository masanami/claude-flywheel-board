import * as fs from "node:fs";
import type { ParseError } from "./types.ts";

// 後方互換のための re-export（既存の import 元 `./ledger.ts` からの参照を維持する）。
// 単一定義は ./types.ts（セルフレビュー指摘対応: ParseError 三重定義の解消）。
export type { ParseError } from "./types.ts";

/**
 * 台帳のステータス語彙（正本は claude-flywheel 側・NFR-05）。board は**消費者**として
 * 追随するだけで、独自に語彙を足さない。**型と実行時の集合はここ 1 箇所から導出する**
 * （union と Set を別々に書くと必ずずれる）。
 *
 * `人間対応待ち` は「親エージェントが人間へ問いを上げて保留中」を表す側道の状態
 * （上流 `docs/human-hold-representation.md` 案 A。masanami/claude-flywheel#116）。
 * **board が先に受理できるようになっている必要がある**——上流が書き始めてから追随すると、
 * 未知ステータスは `ParseError` へ回されて**そのエントリがカードごと消える**（承認導線ごと）。
 */
export const LEDGER_STATUSES = [
  "未分類",
  "分類済",
  "計画承認待ち",
  "着手中",
  "人間対応待ち",
  "検証中",
  "完了確認待ち",
  "完了",
] as const;

export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

const VALID_STATUSES: ReadonlySet<string> = new Set<LedgerStatus>(
  LEDGER_STATUSES,
);

/**
 * 🔔承認待ち（`needsHuman`）として集約するステータス。
 *
 * `人間対応待ち` を含めるのは人間の決定（上流 `docs/human-hold-representation.md` §7 Q2）。
 * 含めないと「人間の入力を待っている」課題が承認待ちフィルタに出ず、運用者が保留に
 * 気付けない。FR-04 の「承認待ちの集約」はチェックボックス承認に限らず
 * **人間の入力待ち**を集める面として読む。
 */
const NEEDS_HUMAN_STATUSES: ReadonlySet<LedgerStatus> = new Set<LedgerStatus>([
  "計画承認待ち",
  "人間対応待ち",
  "完了確認待ち",
]);

/**
 * 参照フィールド（関連リポジトリ・関連Issue・関連PR）の1値。
 *
 * 台帳には URL ではなく `<owner>/<repo>` / `<owner>/<repo>#<番号>`（Issue・PR は
 * `<repo>#<番号>` の短縮形も可）という短い参照が書かれ、**リンク化は消費側（board）の
 * 責務**（challenge-ledger-format.md §関連リポジトリ・関連Issue・関連PR）。
 *
 * owner を解決できた値だけリンク化できるよう、`owner` / `repo` / `number` は
 * **解決できたときのみ**設定する（短縮形の owner 解決は同エントリの `関連リポジトリ` に
 * 同名 `<repo>` があればその owner を使い、無ければ owner 不明としてリンク化しない）。
 * 解決可否によらず `raw`（台帳の記載どおりの文字列）は必ず保持し、規定から外れた
 * 自由記述もテキストとして表示できるようにする。
 */
export type ChallengeRef = {
  /** 台帳に書かれた元の文字列。表示テキストとして常にこれを使う */
  raw: string;
  /** owner。`repo` と同時に設定され、undefined ならリンク化しない */
  owner?: string;
  /** repo 名。`owner` と同時に設定される */
  repo?: string;
  /** Issue / PR 番号。関連リポジトリでは常に undefined */
  number?: number;
};

export type Challenge = {
  id: string;
  title: string;
  status: LedgerStatus;
  priority?: string;
  position?: string;
  needsHuman: boolean;
  summary?: string;
  /** 説明（背景・困りごと・期待する状態）。ラベル "説明" に完全一致するフィールドから抽出 */
  description?: string;
  /**
   * 完了条件。ラベルが "完了条件" で始まるフィールドから前方一致で抽出する
   * （テンプレート表記揺れ: "完了条件（任意）" / "完了条件（任意・分かれば）" 等）。
   */
  completionCriteria?: string;
  /** タスク案。ラベル "タスク案" に完全一致するフィールドから抽出 */
  taskPlan?: string;
  /** 関連リポジトリ（作業対象）。値が無い場合は undefined */
  relatedRepos?: ChallengeRef[];
  /** 関連Issue。値が無い場合は undefined */
  relatedIssues?: ChallengeRef[];
  /** 関連PR。値が無い場合は undefined */
  relatedPrs?: ChallengeRef[];
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
// 継続行（challenge-ledger-format.md §消費側（board 等）の読み取り規則 2）。フィールド値は
// 「フィールド行の値＋直下に連続する継続行」を結合したもので、継続行は次の2種類:
//   - インデント行（スペース1個以上で始まる行）＝複数行形式のネスト項目（形 A・D）
//   - 引用行（行頭が `>`）＝ ingest-challenges が外部 Issue 本文を転記するブロック引用
// インデント行の判定に `\S` を要求することで、空白のみの行は継続行にならず（＝空行と同じ）
// 規定 3 の終端条件に合流する。
const INDENT_CONTINUATION_PATTERN = /^\s+\S/;
const QUOTE_CONTINUATION_PATTERN = /^>/;
// 規定が定めるネスト項目のインデント幅（半角スペース2個。§複数行フィールドの記入形式）。
// 継続行はこの幅ぶんだけ取り除いて結合し、さらに深い子項目（スペース4個）の相対的な
// 階層は残す。
const NEST_INDENT_WIDTH = 2;
// 参照フィールドの値の形（§関連リポジトリ・関連Issue・関連PR）。
// 関連リポジトリは `<owner>/<repo>`、関連Issue・関連PR は `<owner>/<repo>#<番号>`
// （`<repo>#<番号>` の短縮形も可）。
const REPO_REF_PATTERN = /^([\w.-]+)\/([\w.-]+)$/;
const ISSUE_REF_PATTERN = /^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/;
// 課題ID: "C-<数字>" を基本形とし、"C-002-4" のような枝番（ハイフン区切りの追加数字）も
// 許可する（claude-flywheel 側 journal サンプルに階層課題IDの実例が存在するため）。
const CHALLENGE_ID_PATTERN = /^C-\d+(?:-\d+)*$/;

// 完了条件フィールドのラベル前方一致に使う接頭辞。
// FR-B4: テンプレート/実運用台帳で括弧内の注記が揺れる（"完了条件（任意）" /
// "完了条件（任意・分かれば）" 等）ため、注記を無視して "完了条件" で始まるラベルを一致とみなす。
const COMPLETION_CRITERIA_LABEL_PREFIX = "完了条件";
const DESCRIPTION_LABEL = "説明";
const TASK_PLAN_LABEL = "タスク案";

/**
 * 継続行を収集する（＝値が複数行になりうる）フィールドかを判定する。
 *
 * 規定が複数行の値を定義しているのは次の3フィールドだけ:
 * - `タスク案` / `完了条件`: §複数行フィールドの記入形式（節タイトルがこの2つに限定）。
 *   フィールド行の値を空にし、直下に2スペースインデントの箇条書きを続ける（形 A・D）。
 * - `説明`: §消費側の読み取り規則 2 の引用行。ingest-challenges が
 *   `- 説明:（原文引用）` の直下にブロック引用で外部 Issue 本文を転記する。
 *
 * それ以外のフィールドを収集対象から外すのは、規定が単一行の値しか定義していない
 * ことに加え、**語彙・列挙で検証される制御フィールド（ステータス・優先度・担当ポジション）
 * を複数行化すると正常なエントリを失う**ため（`- ステータス: 着手中` の直下に注記が
 * インデントされているだけで語彙照合を外し、エントリがカードから消えて承認導線ごと
 * 失われる）。参照フィールドも §関連リポジトリ・関連Issue・関連PR が値の形を
 * 「カンマ区切り」と定めており、複数行形式は定義していない。
 *
 * この限定により、本フィールド以外の読み取り結果は複数行対応の前と完全に一致する。
 */
function isMultilineFieldLabel(label: string): boolean {
  return (
    label === DESCRIPTION_LABEL ||
    label === TASK_PLAN_LABEL ||
    label.startsWith(COMPLETION_CRITERIA_LABEL_PREFIX)
  );
}

/**
 * フィールド1件分の行。先頭要素はフィールド行の値（空のこともある）、以降は
 * 直下に連続した継続行（規定 §消費側の読み取り規則 2）。
 */
type FieldLines = string[];

type PendingEntry = {
  line: number;
  raw: string;
  idRaw: string;
  title: string;
  fields: Map<string, FieldLines>;
};

/**
 * 継続行から、規定のネスト幅（スペース2個）ぶんの先頭インデントを取り除く。
 * さらに深い子項目（スペース4個）は 2 個分が残り、相対的な階層が保たれる。
 * 引用行（行頭 `>`）は先頭が空白ではないためそのまま残る。
 */
function dedentContinuation(line: string): string {
  return line.trimEnd().replace(new RegExp(`^ {1,${NEST_INDENT_WIDTH}}`), "");
}

/**
 * フィールド行の値と継続行を結合し、1つの値にする（規定 §消費側の読み取り規則 2）。
 * 値の無いフィールド行（形 A: `- タスク案:` のみ）では先頭要素が空文字になるため
 * 取り除き、先頭の空行が入らないようにする。
 */
function joinFieldLines(lines: FieldLines): string {
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * fields から指定ラベルに完全一致するフィールドの値（継続行を結合済み）を返す。
 * 値が空、またはフィールドが無い場合は undefined。
 */
function getField(
  fields: Map<string, FieldLines>,
  label: string,
): string | undefined {
  const lines = fields.get(label);
  return lines ? joinFieldLines(lines) || undefined : undefined;
}

/**
 * fields から、ラベルが指定した接頭辞で始まるフィールドのうち、値が空でない最初の
 * 一致を返す（前方一致検索）。テンプレート由来の空欄ラベルが先に残り、後から人間が
 * 別の注記付きラベルで値を追記するケースで、空値に埋もれて後続の値が無視されるのを
 * 防ぐ。一致が無い、または一致がすべて空値の場合は undefined を返す
 * （フィールドが無いエントリはエラーにせず省略扱い。呼び出し側の `|| undefined` と
 * 合わせて空文字と未設定を同一に扱うため、空値の一致自体を区別して保持する必要はない）。
 */
function findFieldByPrefix(
  fields: Map<string, FieldLines>,
  labelPrefix: string,
): string | undefined {
  for (const [key, lines] of fields) {
    if (!key.startsWith(labelPrefix)) {
      continue;
    }
    const value = joinFieldLines(lines);
    if (value !== "") {
      return value;
    }
  }
  return undefined;
}

/**
 * 参照フィールドの値を個々の参照へ分割する。区切りはカンマのみ
 * （§関連リポジトリ・関連Issue・関連PR が定める値の形。複数行形式は定義されていない
 * ため、参照フィールドは継続行を収集しない＝ isMultilineFieldLabel 参照）。
 */
function splitRefValues(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

/**
 * `関連リポジトリ` をパースする。`<owner>/<repo>` に一致しない値（自由記述・URL 等）は
 * raw のみ保持し、リンク化の対象にしない。
 */
function parseRepoRefs(value: string | undefined): ChallengeRef[] {
  return splitRefValues(value).map((raw) => {
    const match = raw.match(REPO_REF_PATTERN);
    if (!match) {
      return { raw };
    }
    return { raw, owner: match[1], repo: match[2] };
  });
}

/**
 * `関連Issue` / `関連PR` をパースする。短縮形（`<repo>#<番号>`）の owner は
 * **同エントリの `関連リポジトリ` に同名 `<repo>` があればその owner** を使い、
 * 無ければ owner 不明として raw のみ保持する（規定どおり。ワークスペースの
 * repos.tsv を board が読める前提は置かない）。
 */
function parseIssueRefs(
  value: string | undefined,
  repos: ChallengeRef[],
): ChallengeRef[] {
  return splitRefValues(value).map((raw) => {
    const match = raw.match(ISSUE_REF_PATTERN);
    if (!match) {
      return { raw };
    }
    const repo = match[2] as string;
    const owner =
      match[1] ?? repos.find((candidate) => candidate.repo === repo)?.owner;
    if (owner === undefined) {
      return { raw };
    }
    return { raw, owner, repo, number: Number(match[3]) };
  });
}

/** 参照が1件も無いフィールドは他の任意フィールドと同じく undefined（未設定）に寄せる。 */
function refsOrUndefined(refs: ChallengeRef[]): ChallengeRef[] | undefined {
  return refs.length > 0 ? refs : undefined;
}

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
  // 継続行の追記先（直前に読んだフィールド行の FieldLines）。フィールド行でも
  // 継続行でもない行に達したら null に戻す＝値の終端（規定 §消費側の読み取り規則 3）。
  let openField: FieldLines | null = null;

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

    const statusRaw = getField(entry.fields, "ステータス");
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
    const priority = getField(entry.fields, "優先度");
    const position = getField(entry.fields, "担当ポジション");
    const description = getField(entry.fields, "説明");
    const completionCriteria = findFieldByPrefix(
      entry.fields,
      COMPLETION_CRITERIA_LABEL_PREFIX,
    );
    const taskPlan = getField(entry.fields, "タスク案");
    // 参照フィールド（§関連リポジトリ・関連Issue・関連PR）。短縮形の owner 解決に
    // 同エントリの関連リポジトリを使うため、先に関連リポジトリをパースする。
    const relatedRepos = parseRepoRefs(
      getField(entry.fields, "関連リポジトリ"),
    );
    const relatedIssues = parseIssueRefs(
      getField(entry.fields, "関連Issue"),
      relatedRepos,
    );
    const relatedPrs = parseIssueRefs(
      getField(entry.fields, "関連PR"),
      relatedRepos,
    );

    challenges.push({
      id: entry.idRaw.trim(),
      title: entry.title,
      status,
      priority,
      position,
      needsHuman: NEEDS_HUMAN_STATUSES.has(status),
      summary: undefined,
      description,
      completionCriteria,
      taskPlan,
      relatedRepos: refsOrUndefined(relatedRepos),
      relatedIssues: refsOrUndefined(relatedIssues),
      relatedPrs: refsOrUndefined(relatedPrs),
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

    // フェンス・複数行 HTML コメントの中身は台帳データではない（規定 §消費側の
    // 読み取り規則 5）。**値を終端させず、中身も値に含めずに読み飛ばす**——ブロックが
    // 閉じたあとに続く継続行は同じフィールドの値へ戻る。GitHub の Issue テンプレートは
    // 複数行コメントを含み、ingest-challenges 由来の説明（ブロック引用）の途中に
    // 現れうるため、ここで終端すると説明が黙って打ち切られる（PRレビュー指摘対応）。
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
      // 見出しは値の終端（規定 §消費側の読み取り規則 3）。flush() が値を結合済みの
      // Challenge にしてから current を捨てるため、この代入を落としても現在の
      // 実装では出力が変わらない（＝テストでは殺せない防御的な後始末）。
      // 収集途中の配列を次のエントリまたぎで持ち越さない不変条件をここで明示する。
      openField = null;
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

    // 継続行（規定 §消費側の読み取り規則 2）: 直前のフィールド行の値に連結する。
    // openField は複数行フィールド（isMultilineFieldLabel）でのみ開くため、
    // 承認チェックボックス（`- 承認（人間がチェック）:` 直下の専用構造。同規則 4）が
    // 値に混ざることはない。逆に、完了条件・タスク案をタスクリスト記法で書いた場合の
    // `- [ ] …` は値として保持する（規則 4 は承認フィールド直下の構造を指しており、
    // 行の形だけで捨てると条件が黙って一部欠落するため。PRレビュー指摘対応）。
    if (
      openField &&
      (INDENT_CONTINUATION_PATTERN.test(line) ||
        QUOTE_CONTINUATION_PATTERN.test(line))
    ) {
      openField.push(dedentContinuation(line));
      continue;
    }

    const fieldMatch = line.match(FIELD_LINE_PATTERN);
    if (fieldMatch) {
      const key = (fieldMatch[1] ?? "").trim();
      const value = (fieldMatch[2] ?? "").trim();
      const existing = current.fields.get(key);
      if (existing === undefined) {
        const lines: FieldLines = [value];
        current.fields.set(key, lines);
        // 継続行を収集するのは複数行フィールドだけ。それ以外のフィールドの
        // 直下にインデント行があっても、複数行対応の前と同じく無視する。
        openField = isMultilineFieldLabel(key) ? lines : null;
      } else {
        // 同一ラベルの重複は先勝ち（既存挙動）。重複側の継続行も取り込まない。
        openField = null;
      }
      continue;
    }

    // フィールド行でも継続行でもない行（空行・`**分類欄**` 見出し・区切り線など）は
    // 開いているフィールド値の終端（規定 §消費側の読み取り規則 3）。
    openField = null;
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
