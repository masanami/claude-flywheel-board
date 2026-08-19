// 上流フォーマット契約（claude-flywheel `contracts/`）の vendoring 同期チェック。
//
// board は台帳・journal・runs.jsonl の**消費者**であり、フォーマットの正本は
// claude-flywheel 側にある（NFR-05）。契約物（JSON Schema・ゴールデンフィクスチャ）は
// tests/fixtures/contracts/ へ逐語コピーし、パーサテストで固定している。
// 本スクリプトはそのコピーが「いつの上流と一致しているか」を機械的に検査する。
//
// 検査は 2 段:
//   1. **複製の自己検査**（上流不要）: MANIFEST.json に記録した sha256 と
//      ローカルの複製が一致するか。ローカルで契約物を書き換えていないことの担保。
//   2. **上流との差分検査**（上流があるときだけ）: 上流の内容・ファイル集合が
//      MANIFEST 記録時点から変わっていないか。
//
// 終了コードは上流バリデータ（scripts/validate-artifact.rb）と同じ 3 値にそろえる。
// **検査不能を「一致」に丸めない**のが要点で、上流が手元に無い環境では 0 ではなく
// 2（検査不能）を返す。
//   0 = 差分なし / 1 = 差分あり / 2 = 検査不能（上流不在・MANIFEST 破損など）
//
// 使い方:
//   node scripts/verify-contract-fixtures.ts [--upstream <dir>]
//   node scripts/verify-contract-fixtures.ts --update [--upstream <dir>]
//   FLYWHEEL_CONTRACTS_DIR=<dir> node scripts/verify-contract-fixtures.ts
//
// 書き込みは --update 指定時の tests/fixtures/contracts/ 配下のみ。
// **上流リポジトリへは一切書き込まない**（読み取り専用で参照する）。
// --update は**来歴（上流コミット）を truthful に記録できないときは 1 ファイルも複製しない**
// （上流が dirty・git 管理外など。偽の来歴は後日の差分検査を誤らせる）。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** vendoring 先（board 側の複製ルート）。 */
export const VENDOR_ROOT = fileURLToPath(
  new URL("../tests/fixtures/contracts/", import.meta.url),
);

/** board リポジトリのルート（scripts/ の親）。 */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 上流リポジトリのディレクトリ名（board と横並びに置かれる前提）。 */
const UPSTREAM_REPO_DIRNAME = "claude-flywheel";

/** git worktree で作業中なら、メインの作業ツリーのルートを返す。 */
function mainWorktreeRoot(): string | undefined {
  try {
    const commonDir = execFileSync(
      "git",
      [
        "-C",
        REPO_ROOT,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return commonDir === "" ? undefined : path.dirname(commonDir);
  } catch {
    return undefined;
  }
}

/**
 * 上流 `contracts/` の探索先候補（明示指定が無いときの順序）。
 *
 * **絶対パスを直書きしない**。すべて board リポジトリの位置からの相対で解決し、
 * 見つからなければ「検査不能」に落ちるだけで、隣接 repo が無い環境でもテスト・
 * ビルドは成立する。
 *
 * 単純に「本ファイルの 2 つ上の隣接 repo」だけを見ると、**git worktree で作業して
 * いるときに上流が実在しても見つけられない**（worktree は `<repo>-worktrees/issue-N/`
 * に作られるため、2 つ上は `<repo>-worktrees/` になる）。検査不能へ落ちること自体は
 * 安全側だが、標準の実装フローが常に検査不能になるのでは検査が存在しないのと同じ。
 * そこで通常配置・worktree 配置・git が使えない配置の 3 通りを順に探す。
 *
 * @param repoRoot 現在の作業ツリーのルート（テストから配置を差し替えられるようにしてある）
 * @param mainRoot git worktree のメイン作業ツリーのルート（無ければ undefined）
 */
export function upstreamSearchPaths(
  repoRoot: string = REPO_ROOT,
  mainRoot: string | undefined = mainWorktreeRoot(),
): string[] {
  const found: string[] = [];
  const add = (dir: string): void => {
    const normalized = path.resolve(dir);
    if (!found.includes(normalized)) found.push(normalized);
  };

  // 1. 通常のチェックアウト（<repos>/claude-flywheel-board）。
  add(path.join(path.dirname(repoRoot), UPSTREAM_REPO_DIRNAME, "contracts"));

  // 2. git worktree（<repos>/claude-flywheel-board-worktrees/issue-N）。
  //    メインの作業ツリーの位置は --git-common-dir から引ける。
  if (mainRoot !== undefined) {
    add(path.join(path.dirname(mainRoot), UPSTREAM_REPO_DIRNAME, "contracts"));
  }

  // 3. git が使えない配置の保険: 祖先を数段さかのぼって隣接 repo を探す。
  let ancestor = repoRoot;
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
    add(path.join(ancestor, UPSTREAM_REPO_DIRNAME, "contracts"));
  }

  return found;
}

/** 上流の複製ではなく board 側で書いたファイル（複製の集合検査から除外する）。 */
const BOARD_AUTHORED = new Set(["MANIFEST.json", "VENDORING.md"]);

const MANIFEST_PATH = path.join(VENDOR_ROOT, "MANIFEST.json");

export type ManifestFile = { path: string; sha256: string };
export type ManifestExclusion = { path: string; reason: string };

export type Manifest = {
  upstream: {
    repo: string;
    path: string;
    commit: string;
    retrievedAt: string;
  };
  files: ManifestFile[];
  excluded: ManifestExclusion[];
};

export type FindingKind =
  /** MANIFEST にある複製がローカルで書き換わっている */
  | "vendored-modified"
  /** MANIFEST にある複製がローカルに無い */
  | "vendored-missing"
  /** MANIFEST に無いファイルが vendoring ディレクトリにある */
  | "vendored-untracked"
  /** 上流の内容が MANIFEST 記録時点から変わった */
  | "upstream-changed"
  /** 上流から削除された */
  | "upstream-removed"
  /** 上流に増えた（収録も除外も判断されていない） */
  | "upstream-added";

export type Finding = {
  kind: FindingKind;
  path: string;
  detail: string;
};

export type VerifyResult = {
  /** drift = 差分あり(exit 1) / unverifiable = 検査不能(exit 2) / ok = 差分なし(exit 0) */
  status: "ok" | "drift" | "unverifiable";
  findings: Finding[];
  /** 上流との差分検査ができなかった理由（できた場合は undefined） */
  unverifiableReason?: string;
  /** 実際に参照した上流ディレクトリ（検査できた場合のみ） */
  upstreamDir?: string;
};

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * dir 配下のファイルを再帰列挙し、dir からの相対パス（posix 区切り）で返す。
 * ドット始まりのエントリ（`.DS_Store` 等）は契約物ではないため無視する。
 */
export function listFiles(dir: string, prefix = ""): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    const absolute = path.join(dir, entry);
    const relative = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(absolute).isDirectory()) {
      result.push(...listFiles(absolute, relative));
    } else {
      result.push(relative);
    }
  }
  return result.sort();
}

/**
 * 除外指定に一致するか。末尾が `/` の指定はディレクトリ接頭辞として扱う
 * （カテゴリごと収録対象外にする用途。例: `fixtures/journal-md/`）。
 */
export function isExcluded(
  relativePath: string,
  excluded: ManifestExclusion[],
): boolean {
  return excluded.some((entry) =>
    entry.path.endsWith("/")
      ? relativePath.startsWith(entry.path)
      : relativePath === entry.path,
  );
}

/** 1 段目: 上流を必要としない複製の自己検査。 */
export function verifyVendoredCopies(
  manifest: Manifest,
  vendorRoot: string,
): Finding[] {
  const findings: Finding[] = [];
  const recorded = new Set(manifest.files.map((file) => file.path));

  for (const file of manifest.files) {
    const absolute = path.join(vendorRoot, file.path);
    if (!existsSync(absolute)) {
      findings.push({
        kind: "vendored-missing",
        path: file.path,
        detail: "MANIFEST に記録された複製がローカルに存在しない",
      });
      continue;
    }
    const actual = sha256(absolute);
    if (actual !== file.sha256) {
      findings.push({
        kind: "vendored-modified",
        path: file.path,
        detail: `複製がローカルで書き換わっている（記録 ${file.sha256.slice(0, 12)} / 実体 ${actual.slice(0, 12)}）`,
      });
    }
  }

  for (const relative of listFiles(vendorRoot)) {
    if (BOARD_AUTHORED.has(relative)) continue;
    if (!recorded.has(relative)) {
      findings.push({
        kind: "vendored-untracked",
        path: relative,
        detail: "vendoring ディレクトリにあるが MANIFEST に記録が無い",
      });
    }
  }

  return findings;
}

/** 2 段目: 上流との差分検査。 */
export function compareWithUpstream(
  manifest: Manifest,
  upstreamDir: string,
): Finding[] {
  const findings: Finding[] = [];
  const upstreamFiles = new Set(listFiles(upstreamDir));

  for (const file of manifest.files) {
    if (!upstreamFiles.has(file.path)) {
      findings.push({
        kind: "upstream-removed",
        path: file.path,
        detail: "収録済みのファイルが上流から削除された",
      });
      continue;
    }
    const actual = sha256(path.join(upstreamDir, file.path));
    if (actual !== file.sha256) {
      findings.push({
        kind: "upstream-changed",
        path: file.path,
        detail: `上流が改訂された（MANIFEST ${manifest.upstream.commit} 時点の ${file.sha256.slice(0, 12)} / 上流 ${actual.slice(0, 12)}）`,
      });
    }
  }

  const recorded = new Set(manifest.files.map((file) => file.path));
  for (const relative of upstreamFiles) {
    if (recorded.has(relative)) continue;
    if (isExcluded(relative, manifest.excluded)) continue;
    findings.push({
      kind: "upstream-added",
      path: relative,
      detail: "上流に増えたが、収録・除外のどちらも判断されていない",
    });
  }

  return findings;
}

/**
 * 上流 `contracts/` ディレクトリを解決する。repo ルートを渡された場合は
 * `<dir>/contracts` を見に行く。契約物の体裁（schemas/ と fixtures/）を
 * 持たないディレクトリは「検査不能」として扱い、一致に丸めない。
 */
export function resolveUpstreamDir(
  explicit?: string,
): { ok: true; dir: string } | { ok: false; reason: string } {
  const override = explicit ?? process.env.FLYWHEEL_CONTRACTS_DIR;
  // 明示指定は repo ルートを渡されても受ける。指定が無ければ既定の探索順を使う。
  const candidates =
    override === undefined
      ? upstreamSearchPaths()
      : [override, path.join(override, "contracts")];
  for (const dir of candidates) {
    if (
      existsSync(path.join(dir, "schemas")) &&
      existsSync(path.join(dir, "fixtures"))
    ) {
      return { ok: true, dir };
    }
  }
  return {
    ok: false,
    reason: `上流の contracts ディレクトリが見つからない（探索: ${candidates.join(" , ")}）。--upstream か FLYWHEEL_CONTRACTS_DIR で指定する`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringField(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * MANIFEST.json の構造を検証する。構文は正しいが構造が壊れている場合に
 * 後段で TypeError を投げると、3 値の exit 契約（2 = 検査不能）から漏れて
 * 「差分あり(1)」として扱われてしまうため、読み取り時点で弾く。
 */
function validateManifestShape(value: unknown): string | undefined {
  if (!isPlainObject(value)) {
    return "トップレベルが JSON オブジェクトではない";
  }
  const upstream = value.upstream;
  if (!isPlainObject(upstream)) {
    return "upstream がオブジェクトではない";
  }
  for (const key of ["repo", "path", "commit", "retrievedAt"]) {
    if (!isStringField(upstream[key])) {
      return `upstream.${key} が文字列ではない`;
    }
  }
  if (!Array.isArray(value.files)) {
    return "files が配列ではない";
  }
  for (const [index, file] of value.files.entries()) {
    if (
      !isPlainObject(file) ||
      !isStringField(file.path) ||
      !isStringField(file.sha256)
    ) {
      return `files[${index}] が { path: string, sha256: string } ではない`;
    }
  }
  if (!Array.isArray(value.excluded)) {
    return "excluded が配列ではない";
  }
  for (const [index, entry] of value.excluded.entries()) {
    if (
      !isPlainObject(entry) ||
      !isStringField(entry.path) ||
      !isStringField(entry.reason)
    ) {
      return `excluded[${index}] が { path: string, reason: string } ではない`;
    }
  }
  return undefined;
}

export function readManifest(manifestPath = MANIFEST_PATH): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const shapeError = validateManifestShape(parsed);
  if (shapeError !== undefined) {
    throw new Error(`MANIFEST.json の構造が不正: ${shapeError}`);
  }
  return parsed as Manifest;
}

export function verifyContracts(options?: {
  vendorRoot?: string;
  upstreamDir?: string;
  manifestPath?: string;
}): VerifyResult {
  const vendorRoot = options?.vendorRoot ?? VENDOR_ROOT;
  const manifestPath =
    options?.manifestPath ?? path.join(vendorRoot, "MANIFEST.json");

  let manifest: Manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (error) {
    return {
      status: "unverifiable",
      findings: [],
      unverifiableReason: `MANIFEST.json を読めない: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const findings = verifyVendoredCopies(manifest, vendorRoot);

  const upstream = resolveUpstreamDir(options?.upstreamDir);
  if (!upstream.ok) {
    // 上流が無くても 1 段目の違反は違反として報告する（違反 > 検査不能）。
    // 上流が無いことは「一致」ではないので、違反が無くても ok にはしない。
    return {
      status: findings.length > 0 ? "drift" : "unverifiable",
      findings,
      unverifiableReason: upstream.reason,
    };
  }

  findings.push(...compareWithUpstream(manifest, upstream.dir));
  return {
    status: findings.length > 0 ? "drift" : "ok",
    findings,
    upstreamDir: upstream.dir,
  };
}

/**
 * 収録済みファイルの内容を上流から取り直し、MANIFEST を更新する。
 * **未収録の新規ファイルは自動でコピーしない**——収録するか除外するかは
 * board の読み取り規則に関わるかどうかの判断であり、機械が決めてよい事柄ではない
 * （VENDORING.md「収録可否の基準」）。増えたファイルは報告だけして人へ返す。
 */
export function updateVendoredCopies(options?: {
  vendorRoot?: string;
  upstreamDir?: string;
  manifestPath?: string;
  today?: string;
}):
  | { updated: string[]; findings: Finding[]; commit: string }
  | { error: string } {
  const vendorRoot = options?.vendorRoot ?? VENDOR_ROOT;
  const manifestPath =
    options?.manifestPath ?? path.join(vendorRoot, "MANIFEST.json");
  const upstream = resolveUpstreamDir(options?.upstreamDir);
  if (!upstream.ok) return { error: upstream.reason };

  // 来歴（上流コミット）を先に確定する。**取れないなら 1 ファイルも複製しない**——
  // 「この SHA の内容」と主張できない MANIFEST を書くと、後日の差分検査が
  // `upstream-changed`（上流が改訂された）と誤報告して原因を取り違えさせる。
  const provenance = readUpstreamProvenance(upstream.dir);
  if (!provenance.ok) return { error: provenance.reason };

  let manifest: Manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (error) {
    return {
      error: `MANIFEST.json を読めない: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const upstreamFiles = new Set(listFiles(upstream.dir));
  const updated: string[] = [];
  const findings: Finding[] = [];

  for (const file of manifest.files) {
    const source = path.join(upstream.dir, file.path);
    if (!upstreamFiles.has(file.path)) {
      findings.push({
        kind: "upstream-removed",
        path: file.path,
        detail: "上流から削除された。収録を続けるか判断すること",
      });
      continue;
    }
    const destination = path.join(vendorRoot, file.path);
    const next = sha256(source);
    if (!existsSync(destination) || sha256(destination) !== next) {
      copyFileSync(source, destination);
      updated.push(file.path);
    }
    file.sha256 = next;
  }

  const recorded = new Set(manifest.files.map((file) => file.path));
  for (const relative of upstreamFiles) {
    if (recorded.has(relative) || isExcluded(relative, manifest.excluded)) {
      continue;
    }
    findings.push({
      kind: "upstream-added",
      path: relative,
      detail:
        "上流に増えた。board の読み取り規則に関わるなら MANIFEST.files へ、関わらないなら excluded へ（理由つきで）追加する",
    });
  }

  manifest.upstream.commit = provenance.commit;
  manifest.upstream.retrievedAt =
    options?.today ?? new Date().toISOString().slice(0, 10);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  return { updated, findings, commit: provenance.commit };
}

function git(upstreamDir: string, args: string[]): string {
  return execFileSync("git", ["-C", upstreamDir, ...args], {
    encoding: "utf-8",
    // git 自身のエラー出力は握る（失敗は例外で扱う）。
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * 複製の来歴（上流のコミット）を確定する。
 *
 * **来歴を truthful に記録できないなら更新しない**（検査不能を正常に丸めない）:
 * - HEAD が取れない（git 管理外・git 実行不可）→ 「unknown の内容」と記録しても
 *   後日の差分検査の基準にならない
 * - 作業ツリーが dirty → 未コミットの内容を複製しながら clean な SHA を記録すると、
 *   後日その SHA と突き合わせたときに `upstream-changed` と誤報告される
 */
function readUpstreamProvenance(
  upstreamDir: string,
): { ok: true; commit: string } | { ok: false; reason: string } {
  let commit: string;
  try {
    commit = git(upstreamDir, ["rev-parse", "--short", "HEAD"]);
  } catch {
    return {
      ok: false,
      reason: `上流の HEAD コミットを取得できない（git 管理外・git 実行不可）: ${upstreamDir}。来歴を記録できないため更新しない`,
    };
  }

  let status: string;
  try {
    status = git(upstreamDir, ["status", "--porcelain", "--", "."]);
  } catch {
    return {
      ok: false,
      reason: `上流の作業ツリーの状態を取得できない: ${upstreamDir}。来歴を記録できないため更新しない`,
    };
  }
  if (status !== "") {
    return {
      ok: false,
      reason: `上流の contracts に未コミットの変更がある（HEAD ${commit}）。その内容を "${commit} の複製" として記録できないため更新しない。上流を commit / stash してから再実行する:\n${status}`,
    };
  }

  return { ok: true, commit };
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map((finding) => `${finding.path}: [${finding.kind}] ${finding.detail}`)
    .join("\n");
}

function main(argv: string[]): number {
  const upstreamIndex = argv.indexOf("--upstream");
  const upstreamDir = upstreamIndex >= 0 ? argv[upstreamIndex + 1] : undefined;
  if (upstreamIndex >= 0 && upstreamDir === undefined) {
    process.stderr.write("--upstream にはディレクトリを指定する\n");
    return 2;
  }

  if (argv.includes("--update")) {
    const result = updateVendoredCopies({ upstreamDir });
    if ("error" in result) {
      process.stderr.write(`検査不能: ${result.error}\n`);
      return 2;
    }
    process.stdout.write(
      `上流コミット ${result.commit} へ更新（内容が変わった複製: ${result.updated.length} 件）\n`,
    );
    if (result.updated.length > 0) {
      process.stdout.write(`${result.updated.join("\n")}\n`);
    }
    if (result.findings.length > 0) {
      process.stdout.write(
        `\n人の判断が要るもの:\n${formatFindings(result.findings)}\n`,
      );
      return 1;
    }
    return 0;
  }

  const result = verifyContracts({ upstreamDir });
  if (result.findings.length > 0) {
    process.stdout.write(`${formatFindings(result.findings)}\n`);
  }
  if (result.unverifiableReason !== undefined) {
    process.stderr.write(
      `上流との差分は検査不能（「一致」ではない）: ${result.unverifiableReason}\n`,
    );
  }
  if (result.status === "drift") return 1;
  if (result.status === "unverifiable") return 2;
  return 0;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  process.exitCode = main(process.argv.slice(2));
}
