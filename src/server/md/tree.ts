import * as fs from "node:fs";
import * as path from "node:path";
import type { FleetEntry } from "../manifest.ts";
import { MD_EXTENSION, resolveMdFileWithinRoot } from "./path-validation.ts";

const NODE_MODULES_DIR = "node_modules";

export type MdTreeRepo = { name: string; files: string[] };
export type MdTreeResponse = { repos: MdTreeRepo[] };

/**
 * repo ルート配下を再帰的に走査し、`.md` ファイルの repo 相対パス一覧を返す。
 *
 * 除外ルール（親 Issue #61 のクリティカル設計決定に従う。機械的判定のみで、
 * 明示リストや .gitignore 解釈は持ち込まない）。完了条件の文言どおり
 * **ディレクトリ**のみを対象とし、同名の通常ファイルは除外しない
 * （例: 直下に `.hidden.md` というファイルがあっても、それは「`.` 始まりの
 * ディレクトリ」ではないため一覧に含める）:
 * - `.` 始まりの全ディレクトリ（`.git` を含む）
 * - `node_modules` ディレクトリ
 *
 * シンボリックリンクは `fs.lstatSync` で判定し、辿らない（再帰しない）。
 * ディレクトリを指す symlink は循環参照で無限再帰になりうるため、実体を
 * 追わずスキップする（この alias パス自体はツリーに現れないが、実体は
 * 別の実パスから通常どおり列挙されるため、到達不能なファイルが生まれる
 * わけではない。ただし alias パスとしては読み取り API 側の方が寛容になり
 * うる非対称は残る。これはディレクトリ symlink を辿らないという要件上の
 * 制約であり許容する）。ファイルを指す symlink は「辿って再帰する」対象では
 * ないため、リンク自体を一覧対象として扱いうるが、その可否は
 * `path-validation.ts` の `resolveMdFileWithinRoot`（realpath 封じ込め判定・
 * 解決後の実体パスでの拡張子判定）に委ねる。読み取り API（`validateMdPath`）
 * と同じ判定基準を使うことで、ファイルを指す symlink について「ツリーに
 * 出るが読めない」「読めるのにツリーに出ない」の非対称を生じさせない。
 *
 * repo ルート自体が存在しない・読み取れない場合は例外を投げず空配列を返す
 * （manifest 記載の path が未整備でもツリー API 全体を失敗させないための
 * 防御的な扱い）。ルート階層の走査失敗（realpath 解決失敗＝存在しない、
 * および realpath は解決できても repo ルート直下の readdir 自体が失敗する
 * 場合＝ディレクトリでない・権限不足等の両方）は `console.warn` で記録する
 * （manifest は path の実在やディレクトリであることを検証しないため、
 * 設定ミスが「.md が0件」と見分けが付かなくなることを避ける。再帰中
 * （非ルート）の個別ディレクトリの失敗（権限不足・走査中の削除等の
 * レース）は黙殺のままで妥当と判断する）。
 */
function listMdFilesForRepo(rootPath: string): string[] {
  const files: string[] = [];

  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(rootPath);
  } catch (err) {
    console.warn(
      `listMdTree: repo ルートの走査に失敗しました（存在しない・権限不足等）: ${rootPath}`,
      err,
    );
    return files;
  }

  walk(resolvedRoot, "", /* isRoot */ true);
  files.sort();
  return files;

  function walk(absDir: string, relDir: string, isRoot: boolean): void {
    let entryNames: string[];
    try {
      entryNames = fs.readdirSync(absDir);
    } catch (err) {
      if (isRoot) {
        // realpathSync は成功しても、repo ルートがディレクトリでない・
        // 直下の読み取り権限が無い等で readdirSync 自体が失敗しうる。
        // このケースも「.md が0件」と区別できるよう記録する。
        console.warn(
          `listMdTree: repo ルート直下の走査に失敗しました（ディレクトリでない・権限不足等）: ${absDir}`,
          err,
        );
      }
      // 非ルートの個別ディレクトリの失敗（権限不足・走査中の削除等の
      // レース）は黙殺のままで妥当と判断する。
      return;
    }

    for (const entryName of entryNames) {
      const absPath = path.join(absDir, entryName);
      const relPath = relDir === "" ? entryName : path.join(relDir, entryName);

      let lstat: fs.Stats;
      try {
        lstat = fs.lstatSync(absPath);
      } catch {
        continue;
      }

      if (lstat.isSymbolicLink()) {
        const result = resolveMdFileWithinRoot(resolvedRoot, absPath);
        if (result.ok) {
          files.push(relPath);
        }
        continue;
      }

      if (lstat.isDirectory()) {
        if (entryName.startsWith(".") || entryName === NODE_MODULES_DIR) {
          continue;
        }
        walk(absPath, relPath, false);
      } else if (lstat.isFile() && path.extname(entryName) === MD_EXTENSION) {
        files.push(relPath);
      }
    }
  }
}

/**
 * fleet 登録済みの全 repo を走査し、`.md` ファイル一覧を repo 単位でまとめる。
 * オンデマンド走査であり、呼び出しごとに repo 配下を再走査する
 * （ツリーのための fs-watch は追加しない。親 Issue #61 の決定）。
 */
export function listMdTree(
  fleetEntries: readonly FleetEntry[],
): MdTreeResponse {
  const repos = fleetEntries.map((entry) => ({
    name: entry.name,
    files: listMdFilesForRepo(entry.path),
  }));
  return { repos };
}
