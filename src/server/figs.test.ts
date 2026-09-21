import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIG_MAX_BYTES, figPathFor, readChallengeFig } from "./figs.ts";

// 課題の一枚絵（fig。Issue #180 / FR-14）の読み取り。
// 正本はファイル（NFR-01）なので、fs をモックせず実ファイルで検証する
// （CLAUDE.md テスト方針「状態ファイルの読み取りはフィクスチャの実ファイルで検証する」）。
describe("readChallengeFig", () => {
  let tempRoot: string;
  let workspace: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "figs-test-"));
    workspace = path.join(tempRoot, "workspace");
    fs.mkdirSync(path.join(workspace, "figs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeFig(fileName: string, content: string): void {
    fs.writeFileSync(path.join(workspace, "figs", fileName), content);
  }

  it("figs/<課題ID>.mmd の内容をそのまま返す", () => {
    writeFig("C-001.mmd", "flowchart LR\n  A --> B\n");

    expect(readChallengeFig(workspace, "C-001")).toEqual({
      ok: true,
      source: "flowchart LR\n  A --> B\n",
    });
  });

  it("枝番付きの課題 ID（C-002-4）も読める", () => {
    writeFig("C-002-4.mmd", "flowchart TD\n  X --> Y\n");

    expect(readChallengeFig(workspace, "C-002-4")).toEqual({
      ok: true,
      source: "flowchart TD\n  X --> Y\n",
    });
  });

  it("図が無い課題は ok:false を返す（不在は正常系）", () => {
    expect(readChallengeFig(workspace, "C-999")).toEqual({ ok: false });
  });

  it("figs ディレクトリ自体が無くても例外にせず ok:false を返す", () => {
    const bare = path.join(tempRoot, "bare-workspace");
    fs.mkdirSync(bare);

    expect(readChallengeFig(bare, "C-001")).toEqual({ ok: false });
  });

  it("ワークスペース自体が存在しない場合も ok:false を返す", () => {
    expect(readChallengeFig(path.join(tempRoot, "missing"), "C-001")).toEqual({
      ok: false,
    });
  });

  it("課題 ID 形式から外れる値は読みに行かずに ok:false を返す（パス組み立ての防御）", () => {
    // 実在させても読まれないことを見るため、脱出先のファイルを用意しておく。
    fs.writeFileSync(path.join(tempRoot, "secret.mmd"), "secret");

    for (const id of [
      "../secret",
      "../../etc/passwd",
      "figs/C-001",
      "C-001/../../secret",
      ".hidden",
      "",
      "C-001.mmd",
    ]) {
      expect(readChallengeFig(workspace, id)).toEqual({ ok: false });
    }
  });

  it("symlink でワークスペース外を指す fig は読まない", () => {
    const outside = path.join(tempRoot, "outside.mmd");
    fs.writeFileSync(outside, "flowchart LR\n  A --> B\n");
    fs.symlinkSync(outside, path.join(workspace, "figs", "C-003.mmd"));

    expect(readChallengeFig(workspace, "C-003")).toEqual({ ok: false });
  });

  it("ディレクトリを figs/<課題ID>.mmd として置かれても ok:false を返す", () => {
    fs.mkdirSync(path.join(workspace, "figs", "C-004.mmd"));

    expect(readChallengeFig(workspace, "C-004")).toEqual({ ok: false });
  });

  it("上限サイズを超える fig は読み込まずに ok:false を返す", () => {
    writeFig("C-005.mmd", "x".repeat(FIG_MAX_BYTES + 1));

    expect(readChallengeFig(workspace, "C-005")).toEqual({ ok: false });
  });

  it("上限サイズちょうどは読める（境界）", () => {
    writeFig("C-006.mmd", "x".repeat(FIG_MAX_BYTES));

    expect(readChallengeFig(workspace, "C-006")).toEqual({
      ok: true,
      source: "x".repeat(FIG_MAX_BYTES),
    });
  });
});

describe("figPathFor", () => {
  it("ワークスペース直下の figs/<課題ID>.mmd を組み立てる", () => {
    expect(figPathFor("/ws", "C-001")).toBe(
      path.join("/ws", "figs", "C-001.mmd"),
    );
  });
});
