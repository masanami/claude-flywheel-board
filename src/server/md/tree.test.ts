import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMdTree } from "./tree.ts";

describe("listMdTree", () => {
  let tempRoot: string;
  let repoRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "md-tree-test-"));
    repoRoot = path.join(tempRoot, "repo");
    fs.mkdirSync(repoRoot);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("repo 直下の .md ファイルを相対パスで返す", () => {
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "# doc");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result).toEqual({ repos: [{ name: "myrepo", files: ["doc.md"] }] });
  });

  it("サブディレクトリ内の .md ファイルも相対パスで含まれる", () => {
    fs.mkdirSync(path.join(repoRoot, "docs"));
    fs.writeFileSync(path.join(repoRoot, "docs", "nested.md"), "# nested");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual([path.join("docs", "nested.md")]);
  });

  it("アローリスト登録済みのテキスト系拡張子も一覧に含まれる（#142 の挙動変更）", () => {
    fs.writeFileSync(path.join(repoRoot, "notes.txt"), "not markdown");
    fs.writeFileSync(path.join(repoRoot, "config.yaml"), "a: 1");
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "# doc");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual([
      "config.yaml",
      "doc.md",
      "notes.txt",
    ]);
  });

  it("画像拡張子も一覧に含まれる（#143 Phase B の挙動変更）", () => {
    fs.writeFileSync(path.join(repoRoot, "shot.png"), "binary");
    fs.writeFileSync(path.join(repoRoot, "photo.jpg"), "binary");
    fs.writeFileSync(path.join(repoRoot, "photo2.jpeg"), "binary");
    fs.writeFileSync(path.join(repoRoot, "anim.gif"), "binary");
    fs.writeFileSync(path.join(repoRoot, "modern.webp"), "binary");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual([
      "anim.gif",
      "modern.webp",
      "photo.jpg",
      "photo2.jpeg",
      "shot.png",
    ]);
  });

  it("アローリスト外の拡張子（大文字小文字違い・鍵系）と拡張子なしファイルは除外される", () => {
    fs.writeFileSync(path.join(repoRoot, "upper.MD"), "# upper");
    fs.writeFileSync(path.join(repoRoot, "id_rsa.pem"), "secret key");
    fs.writeFileSync(path.join(repoRoot, "Makefile"), "all:\n");
    fs.writeFileSync(path.join(repoRoot, "photo.bmp"), "binary");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual([]);
  });

  it("`.` 始まりディレクトリ（.git を含む）配下は走査から除外される", () => {
    fs.mkdirSync(path.join(repoRoot, ".git"));
    fs.writeFileSync(path.join(repoRoot, ".git", "HEAD.md"), "# not real");
    fs.mkdirSync(path.join(repoRoot, ".hidden"));
    fs.writeFileSync(path.join(repoRoot, ".hidden", "secret.md"), "# hidden");
    fs.writeFileSync(path.join(repoRoot, "visible.md"), "# visible");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual(["visible.md"]);
  });

  it("`.` 始まりディレクトリの除外はネストした階層でも効く", () => {
    fs.mkdirSync(path.join(repoRoot, "docs", ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "docs", ".git", "HEAD.md"),
      "# not real",
    );
    fs.writeFileSync(path.join(repoRoot, "docs", "visible.md"), "# visible");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual([path.join("docs", "visible.md")]);
  });

  it("`.` 始まりのファイルも除外される（設計 §2.2「`.` 始まり判定の統一」。#142 の挙動変更）", () => {
    // #61 時点は「`.` 始まりの全ディレクトリ」のみを除外し `.hidden-note.md` は
    // 列挙していたが、拡張子アローリスト緩和にあわせてファイル名にも同じ判定を
    // 適用する（読み取り API と「一覧に出る＝読める」で対称化する）。
    fs.writeFileSync(path.join(repoRoot, ".hidden-note.md"), "# hidden note");
    fs.writeFileSync(path.join(repoRoot, "visible.md"), "# visible");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual(["visible.md"]);
  });

  it("`.` 始まりの symlink alias は、許可対象の実体を指していても除外される（実体解決より前にエントリ名で落とす）", () => {
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "# doc");
    fs.symlinkSync(
      path.join(repoRoot, "doc.md"),
      path.join(repoRoot, ".alias.md"),
    );

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual(["doc.md"]);
  });

  it("通常名の symlink が `.` 始まりディレクトリ配下の実体を指す場合は除外される（解決後パス側の検査）", () => {
    fs.mkdirSync(path.join(repoRoot, ".hidden"));
    fs.writeFileSync(path.join(repoRoot, ".hidden", "secret.md"), "# secret");
    fs.symlinkSync(
      path.join(repoRoot, ".hidden", "secret.md"),
      path.join(repoRoot, "alias.md"),
    );
    fs.writeFileSync(path.join(repoRoot, "visible.md"), "# visible");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual(["visible.md"]);
  });

  it("node_modules 配下は走査から除外される", () => {
    fs.mkdirSync(path.join(repoRoot, "node_modules", "some-pkg"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoRoot, "node_modules", "some-pkg", "readme.md"),
      "# pkg",
    );
    fs.writeFileSync(path.join(repoRoot, "visible.md"), "# visible");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual(["visible.md"]);
  });

  it("node_modules の除外はネストした階層でも効く", () => {
    fs.mkdirSync(path.join(repoRoot, "packages", "node_modules"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoRoot, "packages", "node_modules", "readme.md"),
      "# pkg",
    );
    fs.writeFileSync(
      path.join(repoRoot, "packages", "visible.md"),
      "# visible",
    );

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual([
      path.join("packages", "visible.md"),
    ]);
  });

  it("ディレクトリの symlink は辿らずスキップされる（循環参照防止）", () => {
    fs.mkdirSync(path.join(repoRoot, "real"));
    fs.writeFileSync(path.join(repoRoot, "real", "inner.md"), "# inner");
    // 自己参照する symlink（循環）を作り、辿った場合に無限再帰することを示す。
    fs.symlinkSync(repoRoot, path.join(repoRoot, "self-loop"));
    fs.writeFileSync(path.join(repoRoot, "visible.md"), "# visible");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    // self-loop 配下は辿られないため real/inner.md は self-loop 経由では
    // 二重に列挙されず、real/inner.md（実体経由）と visible.md のみが残る。
    expect(result.repos[0]?.files).toEqual([
      path.join("real", "inner.md"),
      "visible.md",
    ]);
  });

  it("ファイルを指す symlink は通常のファイルと同様に一覧へ含まれる（読み取りAPIとの非対称を避ける）", () => {
    fs.writeFileSync(path.join(repoRoot, "doc.md"), "# doc");
    fs.symlinkSync(
      path.join(repoRoot, "doc.md"),
      path.join(repoRoot, "link.md"),
    );

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual(["doc.md", "link.md"]);
  });

  it("壊れたシンボリックリンク（実体が存在しない）はクラッシュせず単に除外される", () => {
    fs.symlinkSync(
      path.join(repoRoot, "does-not-exist.md"),
      path.join(repoRoot, "broken-link.md"),
    );
    fs.writeFileSync(path.join(repoRoot, "visible.md"), "# visible");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual(["visible.md"]);
  });

  it("repo ルート外の実体を指す symlink は封じ込め判定により除外される（読み取りAPIと同じ判定基準）", () => {
    const outsideDir = path.join(tempRoot, "outside");
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "target.md"), "# outside target");
    fs.symlinkSync(
      path.join(outsideDir, "target.md"),
      path.join(repoRoot, "escape-link.md"),
    );
    fs.writeFileSync(path.join(repoRoot, "visible.md"), "# visible");

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual(["visible.md"]);
  });

  it("リンク名の拡張子がアローリスト外でも、リンク先の実体が対象ファイルなら一覧に含まれる（判定はリンク名でなく実体パスで行う）", () => {
    fs.writeFileSync(path.join(repoRoot, "real.md"), "# real");
    fs.symlinkSync(
      path.join(repoRoot, "real.md"),
      path.join(repoRoot, "looks-like-binary.bin"),
    );

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual([
      "looks-like-binary.bin",
      "real.md",
    ]);
  });

  it("リンク名が .md でも、リンク先の実体がアローリスト外なら一覧に含まれない（判定はリンク名でなく実体パスで行う）", () => {
    fs.writeFileSync(path.join(repoRoot, "real.pem"), "secret key");
    fs.symlinkSync(
      path.join(repoRoot, "real.pem"),
      path.join(repoRoot, "looks-like-md.md"),
    );

    const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

    expect(result.repos[0]?.files).toEqual([]);
  });

  it("repo ルートパスが存在しない場合は console.warn で走査失敗を記録する", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    listMdTree([
      { name: "myrepo", path: path.join(tempRoot, "does-not-exist") },
    ]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("repo ルートパスがディレクトリでない場合（realpath は解決できるが readdir が失敗する）も console.warn で記録する", () => {
    const rootAsFile = path.join(tempRoot, "not-a-directory");
    fs.writeFileSync(rootAsFile, "# this is a file, not a repo root");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = listMdTree([{ name: "myrepo", path: rootAsFile }]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(result.repos[0]?.files).toEqual([]);
    warnSpy.mockRestore();
  });

  it("repo ルート直下の読み取り権限が無い場合（realpath は解決できるが readdir が失敗する）も console.warn で記録する", () => {
    fs.chmodSync(repoRoot, 0o000);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(result.repos[0]?.files).toEqual([]);
    } finally {
      // afterEach の rmSync が権限不足で失敗しないよう、必ず読み書き権限を戻す。
      fs.chmodSync(repoRoot, 0o755);
      warnSpy.mockRestore();
    }
  });

  it("再帰中（非ルート）のディレクトリ走査失敗では console.warn を呼ばず、他のファイルの列挙は継続する", () => {
    // ルートを実際に読み取り不能にするとテスト自体が repo 丸ごと走査できなく
    // なってしまうため、非ルートのサブディレクトリの実行権限（x）だけを剥奪し
    // readdirSync が EACCES で失敗する状況を実際に再現する（root 権限で実行
    // されている場合はこの制限が効かず本テストが無意味になりうるが、通常の
    // 開発・CI 実行環境（非 root）では有効な回帰ガードとなる）。
    const brokenDir = path.join(repoRoot, "broken-dir");
    fs.mkdirSync(brokenDir);
    fs.writeFileSync(path.join(brokenDir, "unreachable.md"), "# unreachable");
    fs.writeFileSync(path.join(repoRoot, "visible.md"), "# visible");
    fs.chmodSync(brokenDir, 0o000);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = listMdTree([{ name: "myrepo", path: repoRoot }]);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(result.repos[0]?.files).toEqual(["visible.md"]);
    } finally {
      // afterEach の rmSync が権限不足で失敗しないよう、必ず読み書き権限を戻す。
      fs.chmodSync(brokenDir, 0o755);
      warnSpy.mockRestore();
    }
  });

  it("複数 repos が渡された場合、それぞれ { name, files } で返る", () => {
    const repoRoot2 = path.join(tempRoot, "repo2");
    fs.mkdirSync(repoRoot2);
    fs.writeFileSync(path.join(repoRoot, "a.md"), "# a");
    fs.writeFileSync(path.join(repoRoot2, "b.md"), "# b");

    const result = listMdTree([
      { name: "repo1", path: repoRoot },
      { name: "repo2", path: repoRoot2 },
    ]);

    expect(result).toEqual({
      repos: [
        { name: "repo1", files: ["a.md"] },
        { name: "repo2", files: ["b.md"] },
      ],
    });
  });

  it("repo ルートパスが存在しない場合はエラーにせず files: [] を返す", () => {
    const result = listMdTree([
      { name: "myrepo", path: path.join(tempRoot, "does-not-exist") },
    ]);

    expect(result).toEqual({ repos: [{ name: "myrepo", files: [] }] });
  });

  it("fleetEntries が空の場合は repos: [] を返す", () => {
    const result = listMdTree([]);

    expect(result).toEqual({ repos: [] });
  });
});
