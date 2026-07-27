import * as fs from "node:fs";
import * as path from "node:path";
import type { FleetEntry } from "../manifest.ts";

export type MdPathValidationResult =
  | { ok: true; resolvedPath: string }
  | { ok: false };

const MD_EXTENSION = ".md";

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
  // realpath の解決と合わせて同じ try 内で吸収する（検証失敗の理由を問わず
  // 一律 ok:false にするための契約を守る）。
  let resolvedPath: string;
  try {
    const joinedPath = path.join(resolvedRoot, repoRelativePath);
    resolvedPath = fs.realpathSync(joinedPath);
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
