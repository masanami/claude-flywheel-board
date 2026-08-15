import * as fs from "node:fs";
import * as path from "node:path";
import type { FleetEntry } from "../manifest.ts";

export type MdPathValidationResult =
  | { ok: true; resolvedPath: string; kind: PreviewableKind }
  | { ok: false };

/**
 * `GET /api/md/file` 応答の `kind` 語彙（設計 docs/features/file-tree-non-md-support.md
 * §3「API 契約の固定」）。Phase A の時点で 4 値すべてを予約定義し、後続フェーズ
 * （B: 画像 / C: その他ファイルのメタ情報）で契約の後戻りが出ないようにする。
 * Phase A で実際にプロデュースされるのは `markdown | text` の 2 値のみ。
 */
export type PreviewKind = "markdown" | "text" | "image" | "binary";

/**
 * Phase A のアローリスト（`PREVIEWABLE_EXTENSIONS`）が実際に返す kind。
 * 予約語彙 `PreviewKind` の部分集合として定義し、Phase B/C で拡張する際に
 * 語彙側の定義を触らずに済むようにする。
 */
export type PreviewableKind = Extract<PreviewKind, "markdown" | "text">;

/**
 * プレビュー対象として許可する拡張子（厳密一致・大文字小文字区別）とその
 * カテゴリの対応表。`MD_EXTENSION`（`.md` 単独の定数）を置き換えた、拡張子
 * 判定の**単一の正本**（#63 の申し送りを継承。tree.ts〔ツリー走査〕・
 * `resolveMdFileWithinRoot`〔読み取り検証。HTTP と WS `md_subscribe` が共有〕の
 * 3 経路がこの Map だけを参照する。別ファイルに同じ値を複製すると、片方だけ
 * 変更されたときに判定基準が静かにドリフトするため）。
 *
 * 設計 §2.1 の決定に従い、**無制限緩和ではなくアローリスト方式**を維持する:
 * - 鍵・証明書系（`.pem` `.key` 等）は登録しない。
 * - 拡張子なしファイル（`Makefile`・`credentials` 等）は `path.extname` が `""` を
 *   返すため構造的に対象外（`.env` のようなドット始まりファイルはさらに
 *   セグメント除外判定〔§2.2〕でも落ちる）。
 * - 許可拡張子を持つ秘密情報（`credentials.json` 等）はアローリストでは防げず、
 *   既存の脅威モデル（ローカル個人利用・127.0.0.1 バインド・Host/Origin 検証）の
 *   下で残余リスクとして受容する（設計 §2.1 の決定）。
 *
 * 収録範囲は設計 §3 Phase A の案どおりとし、独自の追加はしない（YAGNI。
 * アローリストへの追加は露出面の拡大そのものであり、要望が出てから行う）。
 * `.html` `.svg` `.xml` は**テキストとして表示するだけ**で、ドキュメントとして
 * 解釈させる経路（Content-Type 付きのバイナリ応答）は Phase A では作らない。
 */
export const PREVIEWABLE_EXTENSIONS: ReadonlyMap<string, PreviewableKind> =
  new Map<string, PreviewableKind>([
    [".md", "markdown"],
    [".ts", "text"],
    [".tsx", "text"],
    [".js", "text"],
    [".jsx", "text"],
    [".json", "text"],
    [".jsonc", "text"],
    [".yaml", "text"],
    [".yml", "text"],
    [".toml", "text"],
    [".tsv", "text"],
    [".csv", "text"],
    [".txt", "text"],
    [".log", "text"],
    [".sh", "text"],
    [".py", "text"],
    [".css", "text"],
    [".html", "text"],
    [".svg", "text"],
    [".xml", "text"],
  ]);

/** 走査・読み取りとも対象外にするディレクトリ名（設計 §2.2）。 */
const NODE_MODULES_SEGMENT = "node_modules";

/**
 * repo 相対パスをセグメントへ分解する際の区切り文字。POSIX ではバックスラッシュ
 * は正当なファイル名文字のため `/` のみで分割し、Windows でのみ `\` も区切りと
 * して扱う（過剰な拒否を持ち込まない）。
 */
const SEGMENT_SEPARATOR_PATTERN = path.sep === "\\" ? /[/\\]/ : /\//;

/**
 * 単一のパスセグメントが除外対象かを判定する（設計 §2.2 の除外ルール）。
 *
 * - `.` 始まり: ディレクトリ（`.git` 等）だけでなく**ファイル名も対象**とする
 *   （設計 §2.2「`.` 始まり判定の統一」の決定。`.hidden.md` は列挙・読み取りとも
 *   対象外になる＝現行実装からの挙動変更）。`.` `..` 自身もこの条件で落ちるため、
 *   要求パス側で求められる `..` の拒否もここに含まれる。
 * - `node_modules`: ディレクトリ名としての完全一致。
 */
export function isExcludedSegment(segment: string): boolean {
  return segment.startsWith(".") || segment === NODE_MODULES_SEGMENT;
}

/**
 * repo 相対パスに除外セグメントが 1 つでも含まれるかを判定する（設計 §2.2）。
 *
 * **正規化（`path.join`・realpath）より前の生のセグメント列**に対して呼ぶこと。
 * 正規化後の検査では `node_modules/../public.md` や `.hidden/../public.md` の
 * ように除外セグメントが `..` の解決で消える要求を検出できない。
 */
export function hasExcludedSegment(relativePath: string): boolean {
  return relativePath.split(SEGMENT_SEPARATOR_PATTERN).some(isExcludedSegment);
}

/**
 * 「realpath 済みの repo ルート」＋「(まだ realpath していない) 絶対パス候補」を
 * 受け取り、以下をすべて満たす場合のみ解決済み絶対パスと種別（kind）を返す。
 *
 * 1. パス候補が実在し、realpath で解決できる（シンボリックリンクは実体まで
 *    辿った上で判定する）
 * 2. 解決後パスが repo ルート配下である（realpath 済みルートでの封じ込め判定）
 * 3. 解決後の「repo ルートからの相対パス」に除外セグメント（`.` 始まり・
 *    `node_modules`）を含まない（設計 §2.2 の**解決後パス側**の検査。通常名の
 *    symlink で除外ディレクトリ配下の実体へ潜る抜け道を塞ぐ。判定は repo
 *    ルートからの相対パスに対して行う＝repo ルート自体がドット始まりの
 *    ディレクトリ配下にあっても影響しない）
 * 4. 拡張子が `PREVIEWABLE_EXTENSIONS` に登録済みである（判定はリンク名ではなく
 *    解決後の実体パスに対して行う。symlink 経由の場合、リンク名の拡張子と
 *    リンク先実体の拡張子が異なりうるため、常に実体側で判定することで
 *    tree.ts（ツリー列挙）と本モジュール（読み取り検証）の「一覧に出る＝
 *    読み取れる」の一致を保つ。設計 §2.2 の決定どおり、要求パスの basename に
 *    対する拡張子検査は行わない）
 * 5. 実体が通常ファイルである（許可拡張子で終わるディレクトリを拒否する）
 *
 * `validateMdPath`（repo 名解決を含む読み取り API 向け）と `listMdTree`
 * （ツリー走査。repo ルートは呼び出し側で既に確定済み）の両方から使う
 * 共通ロジックとして切り出す（重複定義による判定基準のドリフト防止）。
 *
 * なお**要求パス側**（正規化前の生セグメント）の除外判定は、呼び出し側が
 * 持つ（読み取り API は `validateMdPath`、ツリー走査は tree.ts の走査ループ）。
 * 本関数は「まだ realpath していない絶対パス候補」しか受け取らず、repo 相対の
 * 要求表現をここでは復元できないため。
 */
export function resolveMdFileWithinRoot(
  resolvedRoot: string,
  absPathCandidate: string,
): MdPathValidationResult {
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(absPathCandidate);
  } catch {
    return { ok: false };
  }

  const isWithinRoot =
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(resolvedRoot + path.sep);
  if (!isWithinRoot) {
    return { ok: false };
  }

  if (hasExcludedSegment(path.relative(resolvedRoot, resolvedPath))) {
    return { ok: false };
  }

  const kind = PREVIEWABLE_EXTENSIONS.get(path.extname(resolvedPath));
  if (!kind) {
    return { ok: false };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return { ok: false };
  }
  if (!stat.isFile()) {
    return { ok: false };
  }

  return { ok: true, resolvedPath, kind };
}

/**
 * repo 名＋repo 相対パスを受け取り、以下をすべて満たす場合のみ解決済み絶対パスと
 * 種別（kind）を返す。
 *
 * 1. 要求された repo 相対パスが、**正規化前の生セグメント列**に除外セグメント
 *    （`.` 始まり・`node_modules`。`..` `.` 自身も `.` 始まりとして落ちる）を
 *    含まない（設計 §2.2 の**要求パス側**の検査。正規化後にしか検査しないと
 *    `node_modules/../public.md` のように除外セグメントが `..` の解決で消える
 *    要求を検出できず、また `.hidden.md` → `public.md` のような symlink alias で
 *    ドット始まり除外を回避されるため）
 * 2. manifest（fleetEntries）に repo 名が存在する
 * 3. repo ルート（manifest 記載パス）が実在し、realpath で解決できる
 * 4. repo ルートと repo 相対パスを結合したパスが実在し、realpath で解決できる
 *    （シンボリックリンクは実体まで辿った上で判定する）
 * 5. 解決後パスが repo ルート配下である（realpath 済みルートでの封じ込め判定）
 * 6. 解決後の repo 相対パスにも除外セグメントを含まない
 * 7. 拡張子が `PREVIEWABLE_EXTENSIONS` に登録済みである
 * 8. 実体が通常ファイルである（許可拡張子で終わるディレクトリを拒否する）
 *
 * 検証失敗の理由（repo 名不明・パス脱出・存在しない・除外セグメント・
 * 拡張子不一致・ディレクトリである 等）は問わず、すべて同一の `{ ok: false }` を
 * 返す。呼び出し側は理由を種類分けせず一律で 404 に変換できる
 * （存在有無を漏らさないための戻り値設計）。
 */
export function validateMdPath(
  fleetEntries: readonly FleetEntry[],
  repoName: string,
  repoRelativePath: string,
): MdPathValidationResult {
  // 生セグメント列を検査する前に型を確かめる（`repoRelativePath` は宣言上
  // string だが、クエリパラメータ由来の呼び出しでは非文字列が渡りうる。
  // 下の path.join と同様、検証失敗の理由を問わず一律 ok:false にする契約を
  // ここでも守る）。
  if (typeof repoRelativePath !== "string") {
    return { ok: false };
  }
  if (hasExcludedSegment(repoRelativePath)) {
    return { ok: false };
  }

  const entry = fleetEntries.find((e) => e.name === repoName);
  if (!entry) {
    return { ok: false };
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(entry.path);
  } catch {
    return { ok: false };
  }

  // path.join は repoRelativePath が非文字列の場合に TypeError を投げうるため、
  // 検証失敗の理由を問わず一律 ok:false にするための契約を守るべく、ここで
  // 個別に吸収する。
  let joinedPath: string;
  try {
    joinedPath = path.join(resolvedRoot, repoRelativePath);
  } catch {
    return { ok: false };
  }

  return resolveMdFileWithinRoot(resolvedRoot, joinedPath);
}
