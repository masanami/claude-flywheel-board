import * as fs from "node:fs";
import * as path from "node:path";
import type { FleetEntry } from "../manifest.ts";

export type MdPathValidationResult =
  | { ok: true; resolvedPath: string }
  | { ok: false };

/**
 * `.md` 拡張子の判定基準（厳密一致・大文字小文字区別）。tree.ts（ツリー走査の
 * 拡張子フィルタ）もこの定数を import して同一基準に揃える（#63 の申し送り。
 * 別ファイルに同じ値を複製すると、片方だけ変更されたときに判定基準が
 * 静かにドリフトするため、単一の正本をここに置く）。
 */
export const MD_EXTENSION = ".md";

/**
 * 「realpath 済みの repo ルート」＋「(まだ realpath していない) 絶対パス候補」を
 * 受け取り、以下をすべて満たす場合のみ解決済み絶対パスを返す。
 *
 * 1. パス候補が実在し、realpath で解決できる（シンボリックリンクは実体まで
 *    辿った上で判定する）
 * 2. 解決後パスが repo ルート配下である（realpath 済みルートでの封じ込め判定）
 * 3. 拡張子が `.md` である（判定はリンク名ではなく解決後の実体パスに対して行う。
 *    symlink 経由の場合、リンク名の拡張子とリンク先実体の拡張子が異なりうる
 *    ため、常に実体側で判定することで tree.ts（ツリー列挙）と本モジュール
 *    （読み取り検証）の「一覧に出る＝読み取れる」の一致を保つ）
 * 4. 実体が通常ファイルである（`.md` で終わるディレクトリを拒否する）
 *
 * `validateMdPath`（repo 名解決を含む読み取り API 向け）と `listMdTree`
 * （ツリー走査。repo ルートは呼び出し側で既に確定済み）の両方から使う
 * 共通ロジックとして切り出す（重複定義による判定基準のドリフト防止）。
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

  if (path.extname(resolvedPath) !== MD_EXTENSION) {
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

  return { ok: true, resolvedPath };
}

/**
 * repo 名＋repo 相対パスを受け取り、以下をすべて満たす場合のみ解決済み絶対パスを返す。
 *
 * 1. manifest（fleetEntries）に repo 名が存在する
 * 2. repo ルート（manifest 記載パス）が実在し、realpath で解決できる
 * 3. repo ルートと repo 相対パスを結合したパスが実在し、realpath で解決できる
 *    （シンボリックリンクは実体まで辿った上で判定する）
 * 4. 解決後パスが repo ルート配下である（realpath 済みルートでの封じ込め判定）
 * 5. 拡張子が `.md` である
 * 6. 実体が通常ファイルである（`.md` で終わるディレクトリを拒否する）
 *
 * 検証失敗の理由（repo 名不明・パス脱出・存在しない・拡張子不一致・
 * ディレクトリである 等）は問わず、すべて同一の `{ ok: false }` を返す。
 * 呼び出し側は理由を種類分けせず一律で 404 に変換できる
 * （存在有無を漏らさないための戻り値設計）。
 */
export function validateMdPath(
  fleetEntries: readonly FleetEntry[],
  repoName: string,
  repoRelativePath: string,
): MdPathValidationResult {
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
