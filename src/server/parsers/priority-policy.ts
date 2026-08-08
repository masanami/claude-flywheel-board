import * as fs from "node:fs";
import type { ParseError } from "./types.ts";

// priority-policy.md のスキーマ（正本: claude-flywheel 側
// masanami/claude-flywheel#75 / PR #76 templates/priority-policy.md。
// 2026-08-09 時点で未マージのため、マージ前にフォーマットが変わった場合は
// この parser の追従が必要）。board は消費者に徹し、独自解釈を持ち込まない
// （NFR-05）:
//
// - 現在モードの正本は1箇所のみ: "## 現在のモード" 見出し配下の ```text
//   フェンス内の `active: <mode>` 行
// - モード定義は "## モード定義" 見出し配下の `` ### `<mode>` ``（説明）見出し。
//   active 値は見出しのバッククォート内トークンと完全一致でマッチする
//   （全角括弧の説明部はマッチングに使わない）
// - 一致するモード定義が無い場合・ファイル不在の場合は run-cycle 側で
//   エージェント裁量にフォールバックする契約のため、board 側はエラーにせず
//   「未定義モードを指している」ことが分かる状態（status: "undefined-mode"）
//   として表す
//
// 注意（working tree 限定。docs/architecture.md §4.2 に詳細）: このパーサは
// 常に working tree の内容を読む。claude-flywheel 側 run-cycle は「Git
// コミット済み・working tree に差分が無い」場合に限り控えた SHA から読んだ
// 内容を適用し、未コミットの変更がある場合は適用方針モード＝エージェント
// 裁量にフォールバックする契約のため、board のバッジが表示する値と
// run-cycle が実際に適用する値が一致しない期間がありうる（未コミット編集中
// 等）。board はこの Git 状態判定を持たない（#135 のスコープ外。git 実行を
// board サーバへ追加すると、正本フォーマット自体が未マージ PR（上記）で
// まだ流動的な段階での実装コストが見合わず、YAGNI の観点から見送り、UI
// 側の表示文言で限定注記するに留めた）。

export type PriorityPolicyStatus = "defined" | "undefined-mode";

export type PriorityPolicy = {
  /** ```text フェンス内 `active:` 行から抽出した値（trim 済み）。working tree の値であり、run-cycle が実際に適用する値と一致しない場合がある（上記コメント参照）。 */
  active: string;
  /**
   * "defined": active が "## モード定義" 配下のいずれかの見出しトークンと
   * 完全一致した。"undefined-mode": 一致するモード定義が見つからなかった
   * （run-cycle 側でエージェント裁量にフォールバックする状態。board は
   * 独自解釈で補正せず、この状態のまま表示する）。
   */
  status: PriorityPolicyStatus;
};

// セクション見出し（行頭固定・行末までの完全一致）。`##` の他の見出し
// （"## 運用メモ" 等）や、本文中の偶然の部分一致（引用・コード例内の
// 言及）に誤って反応しないよう、`^`/`$`（m フラグ）で行全体を固定する。
const CURRENT_MODE_HEADING_PATTERN = /^## 現在のモード\s*$/m;
const MODE_DEFINITIONS_HEADING_PATTERN = /^## モード定義\s*$/m;
// 次の `##` 見出し（セクションの終端判定用）。
const NEXT_H2_HEADING_PATTERN = /^##\s+/m;

// フェンス（```text ... ```）。非 greedy。
const TEXT_FENCE_PATTERN = /```text\r?\n([\s\S]*?)```/;
// フェンス内で `active: <mode>` 行を探す（行頭固定・値は非空白開始）。
const ACTIVE_LINE_PATTERN = /^active:[ \t]*(\S.*)$/m;
// `active:` 行自体は存在するが値が空（トリム後空文字含む）というケースを
// 「行が見つからない」と区別してメッセージを出すための判定（セルフレビュー
// 指摘対応: 値が空の場合に「行が見つかりません」は誤解を招くため）。
const ACTIVE_KEY_LINE_PATTERN = /^active:.*$/m;
// モード見出し: `` ### `<mode>` ``（直後の説明文は無視）。
const MODE_HEADING_PATTERN = /^###\s*`([^`]+)`/gm;

/**
 * `headingPattern` に一致する見出し行の直後から、次の `##` 見出し（または
 * ファイル末尾）までを切り出す。見出しが見つからない場合は空文字列
 * （セルフレビュー指摘対応: 従来は "## モード定義" のみこの境界を欠き
 * ファイル末尾まで読んでいたため、後続セクションの `### \`token\`` を
 * 誤って拾いうる不具合があった。"## 現在のモード" も同じ境界を適用し、
 * ファイル前方に紛れ込んだ例示用フェンスへの誤マッチも同時に防ぐ）。
 */
function extractSection(content: string, headingPattern: RegExp): string {
  const match = headingPattern.exec(content);
  if (!match) {
    return "";
  }
  const afterHeading = content.slice(match.index + match[0].length);
  const nextHeadingMatch = NEXT_H2_HEADING_PATTERN.exec(afterHeading);
  return nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;
}

function collectDefinedModes(content: string): Set<string> {
  const modes = new Set<string>();
  const section = extractSection(content, MODE_DEFINITIONS_HEADING_PATTERN);
  for (const match of section.matchAll(MODE_HEADING_PATTERN)) {
    const token = match[1];
    if (token) {
      modes.add(token);
    }
  }
  return modes;
}

/**
 * priority-policy.md の内容をパースする純粋関数（fs に依存しない）。
 *
 * 契約を満たさない（"## 現在のモード" 配下の ```text フェンス内に
 * `active: <mode>` 行が無い）場合は独自解釈で救済せず ParseError として
 * 返す（NFR-05）。
 */
export function parsePriorityPolicy(
  content: string,
  file: string,
): { policy: PriorityPolicy | undefined; errors: ParseError[] } {
  const currentModeSection = extractSection(
    content,
    CURRENT_MODE_HEADING_PATTERN,
  );
  const fenceMatch = currentModeSection.match(TEXT_FENCE_PATTERN);
  const fenceContent = fenceMatch?.[1] ?? "";
  const activeMatch = fenceContent.match(ACTIVE_LINE_PATTERN);

  if (!activeMatch) {
    const hasEmptyActiveLine = ACTIVE_KEY_LINE_PATTERN.test(fenceContent);
    return {
      policy: undefined,
      errors: [
        {
          file,
          message: hasEmptyActiveLine
            ? 'active: の値が空です（"## 現在のモード" 配下の ```text フェンス内に <mode> を記載する契約です）'
            : 'active: <mode> 行が見つかりません（"## 現在のモード" 配下の ```text フェンス内に記載する契約です）',
          raw: "",
        },
      ],
    };
  }

  const active = (activeMatch[1] ?? "").trim();
  const definedModes = collectDefinedModes(content);

  return {
    policy: {
      active,
      status: definedModes.has(active) ? "defined" : "undefined-mode",
    },
    errors: [],
  };
}

/**
 * priority-policy.md を実ファイルから読み込み parsePriorityPolicy に委譲する。
 * NFR-01: 読み取り専用（fs.readFileSync のみを使用し、書き込みは行わない）。
 *
 * ファイル不在（ENOENT）はエラーにせず `policy: undefined` を返す
 * （方針ファイルはワークスペースへの任意追加。無いエージェントは
 * 「方針未設定」として後方互換に扱う契約。#135）。
 */
export function parsePriorityPolicyFile(filePath: string): {
  policy: PriorityPolicy | undefined;
  errors: ParseError[];
} {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { policy: undefined, errors: [] };
    }
    return {
      policy: undefined,
      errors: [
        {
          file: filePath,
          message: `priority-policy.md の読み込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          raw: "",
        },
      ],
    };
  }
  return parsePriorityPolicy(content, filePath);
}
