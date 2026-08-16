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

  it("repo ルート直下の .md ファイルは許可され、解決済み絶対パスと kind: markdown を返す", () => {
    const result = validateMdPath(fleetEntries, "myrepo", "doc.md");

    expect(result).toEqual({
      ok: true,
      resolvedPath: fs.realpathSync(path.join(repoRoot, "doc.md")),
      kind: "markdown",
    });
  });

  it("repo ルート配下のサブディレクトリの .md ファイルは許可される", () => {
    const result = validateMdPath(fleetEntries, "myrepo", "subdir/nested.md");

    expect(result).toEqual({
      ok: true,
      resolvedPath: fs.realpathSync(path.join(repoRoot, "subdir", "nested.md")),
      kind: "markdown",
    });
  });

  it("アローリスト登録済みのテキスト系拡張子は許可され kind: text を返す（#142 の挙動変更。従来は .md 以外を拒否していた）", () => {
    const result = validateMdPath(fleetEntries, "myrepo", "notes.txt");

    expect(result).toEqual({
      ok: true,
      resolvedPath: fs.realpathSync(path.join(repoRoot, "notes.txt")),
      kind: "text",
    });
  });

  it("画像拡張子は許可され kind: image を返す（#143 Phase B。png/jpg/jpeg/gif/webp）", () => {
    for (const fileName of [
      "shot.png",
      "photo.jpg",
      "photo2.jpeg",
      "anim.gif",
      "modern.webp",
    ]) {
      fs.writeFileSync(path.join(repoRoot, fileName), "binary");

      expect(
        validateMdPath(fleetEntries, "myrepo", fileName),
        fileName,
      ).toEqual({
        ok: true,
        resolvedPath: fs.realpathSync(path.join(repoRoot, fileName)),
        kind: "image",
      });
    }
  });

  it("SVG は image ではなく text のまま扱う（設計 §2.3: board オリジン上のスクリプト実行経路を作らない）", () => {
    fs.writeFileSync(path.join(repoRoot, "icon.svg"), "<svg></svg>");

    expect(validateMdPath(fleetEntries, "myrepo", "icon.svg")).toEqual({
      ok: true,
      resolvedPath: fs.realpathSync(path.join(repoRoot, "icon.svg")),
      kind: "text",
    });
  });

  it("アローリスト外の拡張子（鍵系・大文字小文字違い）は ok:false を返す", () => {
    fs.writeFileSync(path.join(repoRoot, "id_rsa.pem"), "secret key");
    fs.writeFileSync(path.join(repoRoot, "UPPER.MD"), "# upper");

    expect(validateMdPath(fleetEntries, "myrepo", "id_rsa.pem")).toEqual({
      ok: false,
    });
    expect(validateMdPath(fleetEntries, "myrepo", "UPPER.MD")).toEqual({
      ok: false,
    });
  });

  it("拡張子を持たないファイルは ok:false を返す（設計 §2.1: 秘密情報の構造的な除外）", () => {
    fs.writeFileSync(path.join(repoRoot, "Makefile"), "all:\n");
    fs.writeFileSync(path.join(repoRoot, "credentials"), "token");

    expect(validateMdPath(fleetEntries, "myrepo", "Makefile")).toEqual({
      ok: false,
    });
    expect(validateMdPath(fleetEntries, "myrepo", "credentials")).toEqual({
      ok: false,
    });
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
      kind: "markdown",
    });
  });

  it("manifest 記載の repo ルートパス自体が存在しない場合も ok:false を返す", () => {
    const missingRootEntries: FleetEntry[] = [
      { name: "myrepo", path: path.join(tempRoot, "does-not-exist") },
    ];

    const result = validateMdPath(missingRootEntries, "myrepo", "doc.md");

    expect(result).toEqual({ ok: false });
  });

  // 設計 docs/features/file-tree-non-md-support.md §2.2 の受け入れ条件:
  // (a) 除外セグメントを含む要求（`..` の解決で消えるケースを含む）の拒否
  // (b) `.` 始まり symlink alias が許可対象ファイルを指すケースの拒否
  // (c) 許可対象実体を指す通常名 symlink alias の受け入れ
  describe("セグメント除外判定（設計 §2.2）", () => {
    it("`.` 始まりディレクトリ配下は ok:false を返す（tree の除外ルールと対称化。従来は読み取りだけ許していた）", () => {
      fs.mkdirSync(path.join(repoRoot, ".git"));
      fs.writeFileSync(path.join(repoRoot, ".git", "config.toml"), "secret");

      expect(
        validateMdPath(fleetEntries, "myrepo", ".git/config.toml"),
      ).toEqual({ ok: false });
    });

    it("`.` 始まりファイルは ok:false を返す（設計 §2.2 の `.` 始まり判定の統一。`.hidden.md` は読み取り不可へ挙動変更）", () => {
      fs.writeFileSync(path.join(repoRoot, ".hidden.md"), "# hidden");
      fs.writeFileSync(path.join(repoRoot, ".env"), "TOKEN=secret");

      expect(validateMdPath(fleetEntries, "myrepo", ".hidden.md")).toEqual({
        ok: false,
      });
      expect(validateMdPath(fleetEntries, "myrepo", ".env")).toEqual({
        ok: false,
      });
    });

    it("node_modules 配下は ok:false を返す", () => {
      fs.mkdirSync(path.join(repoRoot, "node_modules", "pkg"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(repoRoot, "node_modules", "pkg", "readme.md"),
        "# pkg",
      );

      expect(
        validateMdPath(fleetEntries, "myrepo", "node_modules/pkg/readme.md"),
      ).toEqual({ ok: false });
    });

    it("`..` の解決で除外セグメントが消える要求も拒否する（正規化前の生セグメント列で検査していることの回帰ガード）", () => {
      fs.mkdirSync(path.join(repoRoot, "node_modules"));
      fs.mkdirSync(path.join(repoRoot, ".hidden"));

      // いずれも path.join 後は repo ルート直下の doc.md へ解決するため、
      // 正規化後の検査だけでは除外セグメントを検出できない。
      expect(
        validateMdPath(fleetEntries, "myrepo", "node_modules/../doc.md"),
      ).toEqual({ ok: false });
      expect(
        validateMdPath(fleetEntries, "myrepo", ".hidden/../doc.md"),
      ).toEqual({ ok: false });
    });

    it("repo 内で完結する `..` を含む要求も拒否する（`..` セグメント自体を要求パスで拒否する）", () => {
      expect(
        validateMdPath(fleetEntries, "myrepo", "subdir/../doc.md"),
      ).toEqual({ ok: false });
    });

    it("`.` 始まりの symlink alias が許可対象ファイルを指す場合も拒否する（要求パス側の検査で落ちる）", () => {
      fs.symlinkSync(
        path.join(repoRoot, "doc.md"),
        path.join(repoRoot, ".alias.md"),
      );

      expect(validateMdPath(fleetEntries, "myrepo", ".alias.md")).toEqual({
        ok: false,
      });
    });

    it("通常名の symlink が除外セグメント配下の実体を指す場合は拒否する（解決後パス側の検査）", () => {
      fs.mkdirSync(path.join(repoRoot, ".hidden"));
      fs.writeFileSync(path.join(repoRoot, ".hidden", "secret.md"), "# secret");
      fs.symlinkSync(
        path.join(repoRoot, ".hidden", "secret.md"),
        path.join(repoRoot, "alias.md"),
      );
      fs.mkdirSync(path.join(repoRoot, "node_modules", "pkg"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(repoRoot, "node_modules", "pkg", "readme.md"),
        "# pkg",
      );
      fs.symlinkSync(
        path.join(repoRoot, "node_modules", "pkg", "readme.md"),
        path.join(repoRoot, "pkg-alias.md"),
      );

      expect(validateMdPath(fleetEntries, "myrepo", "alias.md")).toEqual({
        ok: false,
      });
      expect(validateMdPath(fleetEntries, "myrepo", "pkg-alias.md")).toEqual({
        ok: false,
      });
    });

    it("許可対象の実体を指す通常名の symlink alias は、リンク名の拡張子がアローリスト外でも受け入れる（拡張子判定は解決後の実体のみ・設計 §2.2）", () => {
      fs.symlinkSync(
        path.join(repoRoot, "doc.md"),
        path.join(repoRoot, "alias.bin"),
      );

      expect(validateMdPath(fleetEntries, "myrepo", "alias.bin")).toEqual({
        ok: true,
        resolvedPath: fs.realpathSync(path.join(repoRoot, "doc.md")),
        kind: "markdown",
      });
    });

    it("repo ルート自体が `.` 始まりディレクトリ配下にあっても通常のファイルは許可される（判定は repo ルートからの相対パスで行う）", () => {
      const dottedParent = path.join(tempRoot, ".flywheel");
      const nestedRepo = path.join(dottedParent, "repo");
      fs.mkdirSync(nestedRepo, { recursive: true });
      fs.writeFileSync(path.join(nestedRepo, "doc.md"), "# doc");

      const result = validateMdPath(
        [{ name: "nested", path: nestedRepo }],
        "nested",
        "doc.md",
      );

      expect(result).toEqual({
        ok: true,
        resolvedPath: fs.realpathSync(path.join(nestedRepo, "doc.md")),
        kind: "markdown",
      });
    });
  });
});
