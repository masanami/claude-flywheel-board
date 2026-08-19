// vendoring の同期規律そのもののテスト。
// 「上流とズレたら気づける」「上流が無いときに一致へ丸めない」を固定する。
// 範囲・更新手順は tests/fixtures/contracts/VENDORING.md が正本。

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Manifest,
  VENDOR_ROOT,
  readManifest,
  resolveUpstreamDir,
  updateVendoredCopies,
  verifyContracts,
  verifyVendoredCopies,
} from "./verify-contract-fixtures.ts";

describe("vendoring した契約物（実体）", () => {
  it("複製が MANIFEST.json の記録と一致する（上流が無くても検査できる）", () => {
    expect(verifyVendoredCopies(readManifest(), VENDOR_ROOT)).toEqual([]);
  });

  it("上流と一致する（上流が手元に無い環境では skip＝検査不能として残す）", (ctx) => {
    const upstream = resolveUpstreamDir();
    if (!upstream.ok) {
      // ここを pass にしないのが要点。検査していない事実を結果に残す。
      ctx.skip(`上流との差分は検査不能: ${upstream.reason}`);
      return;
    }

    const result = verifyContracts();

    expect(result.findings).toEqual([]);
    expect(result.status).toBe("ok");
  });
});

describe("差分検出", () => {
  let root = "";
  let upstreamDir = "";
  let vendorRoot = "";
  let manifestPath = "";

  const UPSTREAM_FILES: Record<string, string> = {
    "schemas/runs.schema.json": '{"title":"runs"}\n',
    "fixtures/ledger/valid/a.md": "# a\n",
    "fixtures/ledger/invalid/b.md": "# b\n",
    "fixtures/journal-md/valid/minimal.md": "# 収録対象外\n",
    "README.md": "上流の散文\n",
  };

  /** MANIFEST に収録する（＝board が複製する）ファイル。 */
  const VENDORED = [
    "schemas/runs.schema.json",
    "fixtures/ledger/valid/a.md",
    "fixtures/ledger/invalid/b.md",
  ];

  function write(dir: string, relative: string, content: string): void {
    const absolute = path.join(dir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf-8");
  }

  function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  function verify() {
    return verifyContracts({ vendorRoot, upstreamDir, manifestPath });
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "contract-vendoring-"));
    upstreamDir = path.join(root, "upstream");
    vendorRoot = path.join(root, "vendor");
    manifestPath = path.join(vendorRoot, "MANIFEST.json");

    for (const [relative, content] of Object.entries(UPSTREAM_FILES)) {
      write(upstreamDir, relative, content);
    }
    for (const relative of VENDORED) {
      write(vendorRoot, relative, UPSTREAM_FILES[relative] ?? "");
    }

    const manifest: Manifest = {
      upstream: {
        repo: "masanami/claude-flywheel",
        path: "contracts/",
        commit: "0000000",
        retrievedAt: "2026-08-20",
      },
      files: VENDORED.map((relative) => ({
        path: relative,
        sha256: sha256(UPSTREAM_FILES[relative] ?? ""),
      })),
      excluded: [
        { path: "README.md", reason: "散文はコピーしない" },
        { path: "fixtures/journal-md/", reason: "消費するパーサが無い" },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("上流と一致していれば ok", () => {
    const result = verify();

    expect(result.findings).toEqual([]);
    expect(result.status).toBe("ok");
  });

  it("上流が改訂されたら upstream-changed", () => {
    write(upstreamDir, "fixtures/ledger/valid/a.md", "# a（改訂）\n");

    const result = verify();

    expect(result.status).toBe("drift");
    expect(
      result.findings.map((finding) => [finding.kind, finding.path]),
    ).toEqual([["upstream-changed", "fixtures/ledger/valid/a.md"]]);
  });

  it("上流から削除されたら upstream-removed", () => {
    rmSync(path.join(upstreamDir, "fixtures/ledger/invalid/b.md"));

    const result = verify();

    expect(result.status).toBe("drift");
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "upstream-removed",
    ]);
  });

  it("上流に増えたら upstream-added（収録も除外も判断されていないものだけ）", () => {
    write(upstreamDir, "fixtures/runs/valid/new.jsonl", "{}\n");
    write(
      upstreamDir,
      "fixtures/journal-md/invalid/added.md",
      "# 除外カテゴリ\n",
    );

    const result = verify();

    expect(result.status).toBe("drift");
    // 除外カテゴリ（ディレクトリ接頭辞）配下の追加は鳴らさない。
    expect(
      result.findings.map((finding) => [finding.kind, finding.path]),
    ).toEqual([["upstream-added", "fixtures/runs/valid/new.jsonl"]]);
  });

  it("複製をローカルで書き換えたら vendored-modified（上流が無くても検出する）", () => {
    write(vendorRoot, "fixtures/ledger/valid/a.md", "# 手で直した\n");

    const result = verifyContracts({
      vendorRoot,
      upstreamDir: path.join(root, "no-such-upstream"),
      manifestPath,
    });

    // 検査不能より違反を優先して報告する（違反を検査不能に隠さない）。
    expect(result.status).toBe("drift");
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "vendored-modified",
    ]);
    expect(result.unverifiableReason).toBeDefined();
  });

  it("複製が欠けていたら vendored-missing", () => {
    rmSync(path.join(vendorRoot, "schemas/runs.schema.json"));

    const result = verify();

    expect(result.status).toBe("drift");
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "vendored-missing",
    ]);
  });

  it("MANIFEST に無いファイルを置いたら vendored-untracked", () => {
    write(vendorRoot, "fixtures/ledger/valid/stray.md", "# 記録の無い複製\n");

    const result = verify();

    expect(result.status).toBe("drift");
    expect(
      result.findings.map((finding) => [finding.kind, finding.path]),
    ).toEqual([["vendored-untracked", "fixtures/ledger/valid/stray.md"]]);
  });

  it("上流が手元に無ければ unverifiable（ok に丸めない）", () => {
    const result = verifyContracts({
      vendorRoot,
      upstreamDir: path.join(root, "no-such-upstream"),
      manifestPath,
    });

    expect(result.status).toBe("unverifiable");
    expect(result.status).not.toBe("ok");
    expect(result.findings).toEqual([]);
    expect(result.unverifiableReason).toContain("見つからない");
  });

  it("MANIFEST.json が壊れていれば unverifiable", () => {
    writeFileSync(manifestPath, "{ 壊れた JSON", "utf-8");

    const result = verify();

    expect(result.status).toBe("unverifiable");
    expect(result.unverifiableReason).toContain("MANIFEST.json");
  });

  it("契約物の体裁を持たないディレクトリを指しても unverifiable（別物を上流とみなさない）", () => {
    const decoy = path.join(root, "decoy");
    mkdirSync(decoy, { recursive: true });

    const result = verifyContracts({
      vendorRoot,
      upstreamDir: decoy,
      manifestPath,
    });

    expect(result.status).toBe("unverifiable");
  });
});

describe("更新（--update）", () => {
  let root = "";
  let upstreamDir = "";
  let vendorRoot = "";
  let manifestPath = "";

  function write(dir: string, relative: string, content: string): void {
    const absolute = path.join(dir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf-8");
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "contract-update-"));
    upstreamDir = path.join(root, "upstream");
    vendorRoot = path.join(root, "vendor");
    manifestPath = path.join(vendorRoot, "MANIFEST.json");

    write(upstreamDir, "schemas/runs.schema.json", '{"title":"runs v2"}\n');
    write(upstreamDir, "fixtures/ledger/valid/a.md", "# a v2\n");
    write(vendorRoot, "schemas/runs.schema.json", '{"title":"runs"}\n');
    write(vendorRoot, "fixtures/ledger/valid/a.md", "# a\n");

    const manifest: Manifest = {
      upstream: {
        repo: "masanami/claude-flywheel",
        path: "contracts/",
        commit: "0000000",
        retrievedAt: "2026-08-01",
      },
      files: [
        {
          path: "schemas/runs.schema.json",
          sha256: createHash("sha256")
            .update('{"title":"runs"}\n')
            .digest("hex"),
        },
        {
          path: "fixtures/ledger/valid/a.md",
          sha256: createHash("sha256").update("# a\n").digest("hex"),
        },
      ],
      excluded: [],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("収録済みファイルを取り直し、MANIFEST を更新して差分を解消する", () => {
    const result = updateVendoredCopies({
      vendorRoot,
      upstreamDir,
      manifestPath,
      today: "2026-08-20",
    });

    expect("error" in result).toBe(false);
    expect(
      readFileSync(
        path.join(vendorRoot, "fixtures/ledger/valid/a.md"),
        "utf-8",
      ),
    ).toBe("# a v2\n");
    expect(readManifest(manifestPath).upstream.retrievedAt).toBe("2026-08-20");
    expect(
      verifyContracts({ vendorRoot, upstreamDir, manifestPath }).status,
    ).toBe("ok");
  });

  it("未収録の新規ファイルは自動でコピーせず、人の判断へ返す", () => {
    write(upstreamDir, "fixtures/runs/valid/new.jsonl", "{}\n");

    const result = updateVendoredCopies({
      vendorRoot,
      upstreamDir,
      manifestPath,
      today: "2026-08-20",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(
      result.findings.map((finding) => [finding.kind, finding.path]),
    ).toEqual([["upstream-added", "fixtures/runs/valid/new.jsonl"]]);
    // 収録可否は board の読み取り規則に関わるかどうかの判断で、機械が決めない。
    expect(
      readManifest(manifestPath).files.map((file) => file.path),
    ).not.toContain("fixtures/runs/valid/new.jsonl");
  });

  it("上流が手元に無ければ更新せずエラーを返す", () => {
    const result = updateVendoredCopies({
      vendorRoot,
      upstreamDir: path.join(root, "no-such-upstream"),
      manifestPath,
    });

    expect("error" in result).toBe(true);
    expect(
      readFileSync(
        path.join(vendorRoot, "fixtures/ledger/valid/a.md"),
        "utf-8",
      ),
    ).toBe("# a\n");
  });
});
