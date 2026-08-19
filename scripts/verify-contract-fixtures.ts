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

/**
 * 上流 `contracts/` の既定の探索先（隣接 repo）。**絶対パスを直書きしない**ため
 * 本ファイルからの相対で解決する。存在しない環境では「検査不能」に落ちるだけで、
 * テスト・ビルドは成立する。
 */
export const DEFAULT_UPSTREAM_DIR = fileURLToPath(
  new URL("../../claude-flywheel/contracts/", import.meta.url),
);

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
  const candidate =
    explicit ?? process.env.FLYWHEEL_CONTRACTS_DIR ?? DEFAULT_UPSTREAM_DIR;
  const candidates = [candidate, path.join(candidate, "contracts")];
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

export function readManifest(manifestPath = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
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

  const manifest = readManifest(manifestPath);
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

  const commit = readUpstreamCommit(upstream.dir);
  manifest.upstream.commit = commit;
  manifest.upstream.retrievedAt =
    options?.today ?? new Date().toISOString().slice(0, 10);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  return { updated, findings, commit };
}

function readUpstreamCommit(upstreamDir: string): string {
  try {
    return execFileSync(
      "git",
      ["-C", upstreamDir, "rev-parse", "--short", "HEAD"],
      // git 自身のエラー出力は握る（取得できなければ "unknown" を記録するだけで、
      // 更新そのものは成立する）。
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "unknown";
  }
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
