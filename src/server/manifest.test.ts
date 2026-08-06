import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFleetEntry,
  loadFleetManifest,
  removeFleetEntry,
  resolveFleetManifestPath,
} from "./manifest.ts";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../../tests/fixtures/fleet/", import.meta.url),
);

describe("resolveFleetManifestPath", () => {
  const ENV_KEY = "FLYWHEEL_FLEET_MANIFEST";
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
  });

  it("引数で明示されたパスを最優先で返す", () => {
    process.env[ENV_KEY] = "/env/fleet.tsv";

    const resolved = resolveFleetManifestPath("/explicit/fleet.tsv");

    expect(resolved).toBe("/explicit/fleet.tsv");
  });

  it("引数が無い場合は環境変数 FLYWHEEL_FLEET_MANIFEST を返す", () => {
    process.env[ENV_KEY] = "/env/fleet.tsv";

    const resolved = resolveFleetManifestPath();

    expect(resolved).toBe("/env/fleet.tsv");
  });

  it("引数・環境変数どちらも無い場合は既定値 ~/.flywheel/fleet.tsv を返す", () => {
    delete process.env[ENV_KEY];

    const resolved = resolveFleetManifestPath();

    expect(resolved).toBe(path.join(os.homedir(), ".flywheel", "fleet.tsv"));
  });
});

describe("loadFleetManifest", () => {
  it("コメント行・空行を無視して FleetEntry[] を返す", () => {
    const entries = loadFleetManifest(`${FIXTURES_ROOT}valid.tsv`);

    expect(entries).toEqual([
      { name: "medical", path: "/repos/medical-agent" },
      { name: "bi", path: "/repos/bi-agent" },
    ]);
  });

  it("ファイルが存在しない場合はその旨のメッセージで Error を throw する", () => {
    const missingPath = `${FIXTURES_ROOT}does-not-exist.tsv`;

    expect(() => loadFleetManifest(missingPath)).toThrowError(/見つかりません/);
  });

  it("tab 区切りでない行があれば Error を throw する（行番号・原文を含む）", () => {
    const malformedPath = `${FIXTURES_ROOT}malformed-missing-tab.tsv`;

    expect(() => loadFleetManifest(malformedPath)).toThrowError(
      /2 行目.*bi \/repos\/bi-agent/s,
    );
  });

  it("name / path が空フィールドの行があれば Error を throw する", () => {
    const malformedPath = `${FIXTURES_ROOT}malformed-empty-field.tsv`;

    expect(() => loadFleetManifest(malformedPath)).toThrowError(/2 行目/);
  });

  it("name が重複していれば Error を throw する", () => {
    const malformedPath = `${FIXTURES_ROOT}malformed-duplicate-name.tsv`;

    expect(() => loadFleetManifest(malformedPath)).toThrowError(
      /重複.*medical/s,
    );
  });

  it('name の末尾が予約接尾辞 "-shell" なら Error を throw する（#57 セッション名衝突防止）', () => {
    const malformedPath = `${FIXTURES_ROOT}malformed-reserved-shell-suffix.tsv`;

    expect(() => loadFleetManifest(malformedPath)).toThrowError(
      /-shell.*予約/s,
    );
  });
});

describe("appendFleetEntry", () => {
  let tmpDir: string;
  let tmpManifestPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-append-test-"));
    tmpManifestPath = path.join(tmpDir, "fleet.tsv");
    fs.copyFileSync(`${FIXTURES_ROOT}valid.tsv`, tmpManifestPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("有効な entry を append すると既存内容を保持したままファイル末尾に1行追記される", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    appendFleetEntry(
      { name: "research", path: "/repos/research-agent" },
      tmpManifestPath,
    );

    const content = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(content).toBe(`${before}research\t/repos/research-agent\n`);
  });

  it("append の戻り値は追記後の fleet entries 全件になる", () => {
    const result = appendFleetEntry(
      { name: "research", path: "/repos/research-agent" },
      tmpManifestPath,
    );

    expect(result).toEqual([
      { name: "medical", path: "/repos/medical-agent" },
      { name: "bi", path: "/repos/bi-agent" },
      { name: "research", path: "/repos/research-agent" },
    ]);
  });

  it("既存内容の末尾に改行が無い場合でも新しい行として追記される", () => {
    fs.writeFileSync(tmpManifestPath, "medical\t/repos/medical-agent", "utf-8");

    appendFleetEntry({ name: "bi", path: "/repos/bi-agent" }, tmpManifestPath);

    const content = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(content).toBe(
      "medical\t/repos/medical-agent\nbi\t/repos/bi-agent\n",
    );
  });

  it("append 後に loadFleetManifest で読み込むと新エントリが含まれる", () => {
    appendFleetEntry(
      { name: "research", path: "/repos/research-agent" },
      tmpManifestPath,
    );

    const entries = loadFleetManifest(tmpManifestPath);

    expect(entries).toEqual([
      { name: "medical", path: "/repos/medical-agent" },
      { name: "bi", path: "/repos/bi-agent" },
      { name: "research", path: "/repos/research-agent" },
    ]);
  });

  it("name が空文字なら Error を throw し、ファイル内容は変更されない", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "", path: "/repos/research-agent" },
        tmpManifestPath,
      ),
    ).toThrowError(/空です/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("path が空文字なら Error を throw し、ファイル内容は変更されない", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry({ name: "research", path: "" }, tmpManifestPath),
    ).toThrowError(/空です/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it('name が "-shell" 接尾辞なら Error を throw し、ファイル内容は変更されない', () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "research-shell", path: "/repos/research-agent" },
        tmpManifestPath,
      ),
    ).toThrowError(/-shell.*予約/s);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("既存 fleet と name が重複するなら Error を throw し、ファイル内容は変更されない", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "medical", path: "/repos/new-agent" },
        tmpManifestPath,
      ),
    ).toThrowError(/medical.*重複/s);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("既存 fleet と path が重複するなら Error を throw し、ファイル内容は変更されない", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "new-agent", path: "/repos/medical-agent" },
        tmpManifestPath,
      ),
    ).toThrowError(/\/repos\/medical-agent.*重複/s);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("マニフェストファイルが存在しない場合、loadFleetManifest 由来のエラーが伝播する", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.tsv");

    expect(() =>
      appendFleetEntry(
        { name: "research", path: "/repos/research-agent" },
        missingPath,
      ),
    ).toThrowError(/見つかりません/);
  });

  it("name にタブが含まれる場合は Error を throw し、ファイル内容は変更されない（fleet.tsv のタブ区切り形式の破壊防止）", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "research\tinjected", path: "/repos/research-agent" },
        tmpManifestPath,
      ),
    ).toThrowError(/タブ・改行/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("path にタブが含まれる場合は Error を throw し、ファイル内容は変更されない（列数超過による fleet.tsv 破損の防止）", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "research", path: "/repos/research-agent\tinjected" },
        tmpManifestPath,
      ),
    ).toThrowError(/タブ・改行/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("path に改行が含まれる場合は Error を throw し、ファイル内容は変更されない（複数行注入によるバリデーション回避の防止）", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        {
          name: "research",
          path: "/repos/research-agent\nresearch-shell\t/repos/evil",
        },
        tmpManifestPath,
      ),
    ).toThrowError(/タブ・改行/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it('name が "#" で始まる場合は Error を throw し、ファイル内容は変更されない（コメント行として無視されるサイレント no-op の防止）', () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "#research", path: "/repos/research-agent" },
        tmpManifestPath,
      ),
    ).toThrowError(/コメント行/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("既存 fleet と末尾スラッシュ違いのみのパスは正規化した上で重複と判定される", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "new-agent", path: "/repos/medical-agent/" },
        tmpManifestPath,
      ),
    ).toThrowError(/重複/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("path が相対パスなら Error を throw し、ファイル内容は変更されない（サーバの cwd 依存によるパス誤解決の防止）", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "research", path: "repos/research-agent" },
        tmpManifestPath,
      ),
    ).toThrowError(/絶対パス/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it('path が "~" 始まりなら相対パス扱いで Error を throw し、ファイル内容は変更されない', () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(() =>
      appendFleetEntry(
        { name: "research", path: "~/repos/research-agent" },
        tmpManifestPath,
      ),
    ).toThrowError(/絶対パス/);

    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it('name/path の前後の空白は trim され、path の冗長な "." セグメントは正規化されて書き込まれる（恒等変換にならない入力での正規化確認）', () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    const result = appendFleetEntry(
      { name: "  research  ", path: "/repos/./research-agent" },
      tmpManifestPath,
    );

    const content = fs.readFileSync(tmpManifestPath, "utf-8");

    expect(content).toBe(`${before}research\t/repos/research-agent\n`);
    expect(result.at(-1)).toEqual({
      name: "research",
      path: "/repos/research-agent",
    });
  });
});

describe("removeFleetEntry（Issue #122: POST /api/fleet/agents のロールバック専用）", () => {
  let tmpDir: string;
  let tmpManifestPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-remove-test-"));
    tmpManifestPath = path.join(tmpDir, "fleet.tsv");
    fs.copyFileSync(`${FIXTURES_ROOT}valid.tsv`, tmpManifestPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appendFleetEntry で追記した行をそのまま除去できる（追記前の内容に戻る）", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");
    appendFleetEntry(
      { name: "research", path: "/repos/research-agent" },
      tmpManifestPath,
    );

    const removed = removeFleetEntry(
      "research",
      "/repos/research-agent",
      tmpManifestPath,
    );

    expect(removed).toBe(true);
    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("末尾に改行が無い既存内容へ追記した行を除去しても、直前の行の区切りは壊れない（回帰テスト）", () => {
    fs.writeFileSync(tmpManifestPath, "medical\t/repos/medical-agent", "utf-8");
    appendFleetEntry(
      { name: "research", path: "/repos/research-agent" },
      tmpManifestPath,
    );
    // 追記直後、割り込みで別の行が追記された状況を模倣する。
    fs.appendFileSync(tmpManifestPath, "bi\t/repos/bi-agent\n", "utf-8");

    const removed = removeFleetEntry(
      "research",
      "/repos/research-agent",
      tmpManifestPath,
    );

    expect(removed).toBe(true);
    // 割り込んだ行は残り、かつ前後の行が連結されて壊れていない。
    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(
      "medical\t/repos/medical-agent\nbi\t/repos/bi-agent\n",
    );
  });

  it("該当する行が見つからない場合は false を返し、ファイルを変更しない", () => {
    const before = fs.readFileSync(tmpManifestPath, "utf-8");

    const removed = removeFleetEntry(
      "does-not-exist",
      "/repos/does-not-exist",
      tmpManifestPath,
    );

    expect(removed).toBe(false);
    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(before);
  });

  it("マニフェストファイルが存在しない場合は false を返す（例外を投げない）", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.tsv");

    const removed = removeFleetEntry(
      "research",
      "/repos/research-agent",
      missingPath,
    );

    expect(removed).toBe(false);
  });

  it("他の行の内容は変更せずに保つ", () => {
    appendFleetEntry(
      { name: "research", path: "/repos/research-agent" },
      tmpManifestPath,
    );

    removeFleetEntry("research", "/repos/research-agent", tmpManifestPath);

    const entries = loadFleetManifest(tmpManifestPath);
    expect(entries).toEqual([
      { name: "medical", path: "/repos/medical-agent" },
      { name: "bi", path: "/repos/bi-agent" },
    ]);
  });

  it("同一 name/path のテキストがコメントアウトされた行の内部に存在しても、それを誤って壊さない（回帰テスト）", () => {
    // "#research\t/repos/research-agent" というコメント行が、これから追記・
    // 除去する行と同じ "research\t/repos/research-agent" という部分文字列を
    // 行頭以外の位置に含む。単純な部分文字列検索（indexOf）だと、末尾改行
    // 込みの完全一致がこのコメント行の内部でも成立してしまい、コメント行の
    // 先頭 "#" を残したまま中身だけを取り除いてしまう（本来消すべきは末尾に
    // 実際に追記した行）。
    fs.writeFileSync(
      tmpManifestPath,
      "#research\t/repos/research-agent\nmedical\t/repos/medical-agent\n",
      "utf-8",
    );
    appendFleetEntry(
      { name: "research", path: "/repos/research-agent" },
      tmpManifestPath,
    );

    const removed = removeFleetEntry(
      "research",
      "/repos/research-agent",
      tmpManifestPath,
    );

    expect(removed).toBe(true);
    // コメント行はそのまま残り、medical 行も無事、末尾に追記した行だけが消える。
    expect(fs.readFileSync(tmpManifestPath, "utf-8")).toBe(
      "#research\t/repos/research-agent\nmedical\t/repos/medical-agent\n",
    );
  });
});
