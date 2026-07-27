import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetEntry } from "../manifest.ts";
import { validateMdPath } from "./path-validation.ts";

describe("validateMdPath", () => {
  let tempRoot: string;
  let repoRoot: string;
  let fleetEntries: FleetEntry[];

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "md-path-validation-test-"),
    );
    repoRoot = path.join(tempRoot, "repo");
    fs.mkdirSync(repoRoot);
    fs.mkdirSync(path.join(repoRoot, "subdir"));
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "# doc");
    fs.writeFileSync(path.join(repoRoot, "subdir", "nested.md"), "# nested");
    fs.writeFileSync(path.join(repoRoot, "notes.txt"), "not markdown");

    fleetEntries = [{ name: "myrepo", path: repoRoot }];
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("repo 名が manifest に存在しない場合は ok:false を返す", () => {
    const result = validateMdPath(fleetEntries, "unknown-repo", "doc.md");

    expect(result).toEqual({ ok: false });
  });

  it("repo ルート直下の .md ファイルは許可され、解決済み絶対パスを返す", () => {
    const result = validateMdPath(fleetEntries, "myrepo", "doc.md");

    expect(result).toEqual({
      ok: true,
      resolvedPath: fs.realpathSync(path.join(repoRoot, "doc.md")),
    });
  });

  it("repo ルート配下のサブディレクトリの .md ファイルは許可される", () => {
    const result = validateMdPath(fleetEntries, "myrepo", "subdir/nested.md");

    expect(result).toEqual({
      ok: true,
      resolvedPath: fs.realpathSync(path.join(repoRoot, "subdir", "nested.md")),
    });
  });

  it("拡張子が .md 以外の場合は ok:false を返す", () => {
    const result = validateMdPath(fleetEntries, "myrepo", "notes.txt");

    expect(result).toEqual({ ok: false });
  });

  it("ファイルが存在しない場合は ok:false を返す（拒否ケースと同一の戻り値）", () => {
    const result = validateMdPath(fleetEntries, "myrepo", "missing.md");

    expect(result).toEqual({ ok: false });
  });

  it("名前が .md で終わるディレクトリは通常ファイルではないため ok:false を返す", () => {
    fs.mkdirSync(path.join(repoRoot, "dirlooksmd.md"));

    const result = validateMdPath(fleetEntries, "myrepo", "dirlooksmd.md");

    expect(result).toEqual({ ok: false });
  });

  it("repoRelativePath が文字列でない場合も例外を投げず ok:false を返す", () => {
    expect(() =>
      validateMdPath(fleetEntries, "myrepo", undefined as unknown as string),
    ).not.toThrow();

    const result = validateMdPath(
      fleetEntries,
      "myrepo",
      undefined as unknown as string,
    );

    expect(result).toEqual({ ok: false });
  });

  it("`../` で repo ルート外に脱出しようとする場合は ok:false を返す", () => {
    fs.writeFileSync(path.join(tempRoot, "outside.md"), "# outside");

    const result = validateMdPath(fleetEntries, "myrepo", "../outside.md");

    expect(result).toEqual({ ok: false });
  });

  it("絶対パスを repo 相対パスとして渡した場合は repo 外へ脱出せず ok:false を返す", () => {
    // repo 外に実在する .md ファイルの絶対パスを渡す。path.resolve で結合する
    // 実装であればこの絶対パスへ直接ジャンプして ok:true になってしまうため、
    // path.join によって repo ルート配下のサブパス扱いになることを実質的に検証する。
    const outsideAbsolutePath = path.join(tempRoot, "outside-abs.md");
    fs.writeFileSync(outsideAbsolutePath, "# outside abs");

    const result = validateMdPath(fleetEntries, "myrepo", outsideAbsolutePath);

    expect(result).toEqual({ ok: false });
  });

  it("repo ルート名と前方一致する兄弟ディレクトリへは脱出できず ok:false を返す", () => {
    // resolvedRoot が ".../repo" のとき、単純な startsWith(resolvedRoot) 判定だと
    // ".../repo-evil/..." のような兄弟ディレクトリも「配下」と誤判定してしまう。
    // path.sep 込みの境界判定が効いていることをここで固定する。
    const siblingDir = `${repoRoot}-evil`;
    fs.mkdirSync(siblingDir);
    fs.writeFileSync(path.join(siblingDir, "secret.md"), "# secret");

    const result = validateMdPath(
      fleetEntries,
      "myrepo",
      "../repo-evil/secret.md",
    );

    expect(result).toEqual({ ok: false });
  });

  it("シンボリックリンク経由で repo ルート外の実体を指す場合は ok:false を返す", () => {
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "target.md"), "# outside target");
    fs.symlinkSync(
      path.join(outsideDir, "target.md"),
      path.join(repoRoot, "escape-link.md"),
    );

    const result = validateMdPath(fleetEntries, "myrepo", "escape-link.md");

    expect(result).toEqual({ ok: false });
  });

  it("repo 内で完結するシンボリックリンクは許可される", () => {
    fs.symlinkSync(
      path.join(repoRoot, "doc.md"),
      path.join(repoRoot, "inside-link.md"),
    );

    const result = validateMdPath(fleetEntries, "myrepo", "inside-link.md");

    expect(result).toEqual({
      ok: true,
      resolvedPath: fs.realpathSync(path.join(repoRoot, "doc.md")),
    });
  });

  it("manifest 記載の repo ルートパス自体が存在しない場合も ok:false を返す", () => {
    const missingRootEntries: FleetEntry[] = [
      { name: "myrepo", path: path.join(tempRoot, "does-not-exist") },
    ];

    const result = validateMdPath(missingRootEntries, "myrepo", "doc.md");

    expect(result).toEqual({ ok: false });
  });
});
