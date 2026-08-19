// vendoring の同期規律そのもののテスト。
// 「上流とズレたら気づける」「上流が無いときに一致へ丸めない」を固定する。
// 範囲・更新手順は tests/fixtures/contracts/VENDORING.md が正本。

import { execFileSync } from "node:child_process";
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
  isExcluded,
  readManifest,
  resolveUpstreamDir,
  updateVendoredCopies,
  upstreamSearchPaths,
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
      //
      // ただし既定レポータは skip のテスト名も理由も出さず「1 skipped」の数だけを
      // 表示する。「検査不能」が「検証済み」と誤読されないよう、理由は必ず
      // 標準エラーへ出す（vitest はテスト中の console 出力をファイル名つきで表示する）。
      // console.* は vitest のインターセプトに載って既定レポータでは表示されない
      // （skip したテストの出力は落ちる）。素の stderr へ書いて必ず見えるようにする。
      process.stderr.write(
        `[contracts] 上流との差分検査を実行していない（検査不能・「一致」ではない）: ${upstream.reason}\n`,
      );
      // 上流が必ず手元にある前提で回す場面（リリース前の確認など）は
      // REQUIRE_UPSTREAM_CONTRACT_CHECK=1 で skip を失敗に昇格できる。
      if (process.env.REQUIRE_UPSTREAM_CONTRACT_CHECK === "1") {
        throw new Error(
          `上流との差分検査が必須指定（REQUIRE_UPSTREAM_CONTRACT_CHECK=1）だが実行できない: ${upstream.reason}`,
        );
      }
      ctx.skip(`上流との差分は検査不能: ${upstream.reason}`);
      return;
    }

    const result = verifyContracts();

    expect(result.findings).toEqual([]);
    expect(result.status).toBe("ok");
  });
});

describe("上流の探索先", () => {
  // 標準の実装フローは git worktree（`<repo>-worktrees/issue-N/`）で回る。
  // 「本ファイルの 2 つ上の隣接 repo」だけを見ると、上流が通常位置に実在しても
  // 見つからず**常に検査不能へ落ちる**＝上流差分検査が事実上存在しなくなる。
  it("worktree 配置（<repo>-worktrees/issue-N）でも隣接 repo を候補に含める", () => {
    const candidates = upstreamSearchPaths(
      "/ws/repos/claude-flywheel-board-worktrees/issue-999",
      "/ws/repos/claude-flywheel-board",
    );

    expect(candidates).toContain("/ws/repos/claude-flywheel/contracts");
  });

  it("通常のチェックアウトでは隣接 repo が最初の候補になる", () => {
    const candidates = upstreamSearchPaths(
      "/ws/repos/claude-flywheel-board",
      undefined,
    );

    expect(candidates[0]).toBe("/ws/repos/claude-flywheel/contracts");
  });

  it("git が使えない worktree 配置でも祖先をさかのぼって候補に含める", () => {
    // mainRoot が取れない（git 実行不可）場合の保険。
    const candidates = upstreamSearchPaths(
      "/ws/repos/claude-flywheel-board-worktrees/issue-999",
      undefined,
    );

    expect(candidates).toContain("/ws/repos/claude-flywheel/contracts");
  });
});

describe("除外指定の一致規則", () => {
  const excluded = [
    { path: "README.md", reason: "散文" },
    { path: "fixtures/journal-md/", reason: "消費するパーサが無い" },
  ];

  it("末尾が / でない指定は完全一致のみ（接頭辞一致にしない）", () => {
    expect(isExcluded("README.md", excluded)).toBe(true);
    // 接頭辞一致に緩むと、上流に増えた README.mdx が upstream-added として
    // 報告されず、検査対象外へ落ちたことが見えなくなる。
    expect(isExcluded("README.mdx", excluded)).toBe(false);
    expect(isExcluded("README.md.bak", excluded)).toBe(false);
    expect(isExcluded("docs/README.md", excluded)).toBe(false);
  });

  it("末尾が / の指定はディレクトリ接頭辞として一致する", () => {
    expect(isExcluded("fixtures/journal-md/valid/minimal.md", excluded)).toBe(
      true,
    );
    // 名前が前方一致するだけの別ディレクトリは巻き込まない。
    expect(isExcluded("fixtures/journal-md-extra/x.md", excluded)).toBe(false);
    expect(isExcluded("fixtures/journal-index/valid/x.jsonl", excluded)).toBe(
      false,
    );
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

  // 構文は通るが構造が壊れている MANIFEST は、そのまま進むと後段で TypeError になり
  // 3 値の exit 契約（2 = 検査不能）から漏れて「差分あり(1)」に化ける。
  describe("構造が不正な MANIFEST も unverifiable（例外で exit 1 に化けない）", () => {
    const BROKEN: Record<string, unknown> = {
      "files が配列でない": {
        upstream: {
          repo: "r",
          path: "contracts/",
          commit: "c",
          retrievedAt: "2026-08-20",
        },
        files: "oops",
        excluded: [],
      },
      "excluded キーが無い": {
        upstream: {
          repo: "r",
          path: "contracts/",
          commit: "c",
          retrievedAt: "2026-08-20",
        },
        files: [],
      },
      "upstream キーが無い": { files: [], excluded: [] },
      "files の要素の形が違う": {
        upstream: {
          repo: "r",
          path: "contracts/",
          commit: "c",
          retrievedAt: "2026-08-20",
        },
        files: [{ path: "a.md" }],
        excluded: [],
      },
      "excluded の要素の形が違う": {
        upstream: {
          repo: "r",
          path: "contracts/",
          commit: "c",
          retrievedAt: "2026-08-20",
        },
        files: [],
        excluded: [{ path: "a.md" }],
      },
    };

    for (const [label, manifest] of Object.entries(BROKEN)) {
      it(label, () => {
        writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

        const result = verify();

        expect(result.status).toBe("unverifiable");
        expect(result.unverifiableReason).toContain("構造が不正");
      });
    }

    // `excluded` 欠落は、上流のファイル集合が空だと参照に到達せず
    // 「正常に検査できた」ように見えてしまう（空虚に真）。
    it("上流のファイル集合が空でも見逃さない", () => {
      const emptyUpstream = path.join(root, "empty-upstream");
      mkdirSync(path.join(emptyUpstream, "schemas"), { recursive: true });
      mkdirSync(path.join(emptyUpstream, "fixtures"), { recursive: true });
      writeFileSync(
        manifestPath,
        JSON.stringify({
          upstream: {
            repo: "r",
            path: "contracts/",
            commit: "c",
            retrievedAt: "2026-08-20",
          },
          files: [],
        }),
        "utf-8",
      );

      const result = verifyContracts({
        vendorRoot,
        upstreamDir: emptyUpstream,
        manifestPath,
      });

      expect(result.status).toBe("unverifiable");
    });
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

  function git(dir: string, args: string[]): string {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "contract-update-"));
    upstreamDir = path.join(root, "upstream");
    vendorRoot = path.join(root, "vendor");
    manifestPath = path.join(vendorRoot, "MANIFEST.json");

    write(upstreamDir, "schemas/runs.schema.json", '{"title":"runs v2"}\n');
    write(upstreamDir, "fixtures/ledger/valid/a.md", "# a v2\n");
    // 来歴（HEAD コミット）を記録できる状態＝クリーンな git 作業ツリーが前提。
    git(upstreamDir, ["init", "-q"]);
    git(upstreamDir, ["add", "-A"]);
    git(upstreamDir, [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "contracts",
    ]);

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
    const manifest = readManifest(manifestPath);
    expect(manifest.upstream.retrievedAt).toBe("2026-08-20");
    // 来歴は実際の HEAD で、プレースホルダのままにしない。
    expect(manifest.upstream.commit).toBe(
      git(upstreamDir, ["rev-parse", "--short", "HEAD"]),
    );
    expect(
      verifyContracts({ vendorRoot, upstreamDir, manifestPath }).status,
    ).toBe("ok");
  });

  it("未収録の新規ファイルは自動でコピーせず、人の判断へ返す", () => {
    write(upstreamDir, "fixtures/runs/valid/new.jsonl", "{}\n");
    git(upstreamDir, ["add", "-A"]);
    git(upstreamDir, [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "add fixture",
    ]);

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

  // 未コミットの内容を複製しながらクリーンな HEAD を来歴として記録すると、
  // 後日その SHA と突き合わせたとき upstream-changed（上流が改訂された）と
  // 誤報告され、原因を取り違える。
  it("上流の作業ツリーが dirty なら 1 ファイルも複製せずエラーを返す", () => {
    write(upstreamDir, "fixtures/ledger/valid/a.md", "# 未コミットの編集\n");

    const result = updateVendoredCopies({
      vendorRoot,
      upstreamDir,
      manifestPath,
      today: "2026-08-20",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("未コミット");
    expect(
      readFileSync(
        path.join(vendorRoot, "fixtures/ledger/valid/a.md"),
        "utf-8",
      ),
    ).toBe("# a\n");
    // MANIFEST も書き換えない（偽の来歴を残さない）。
    expect(readManifest(manifestPath).upstream.commit).toBe("0000000");
  });

  it("上流の未追跡ファイルも dirty として扱う", () => {
    write(upstreamDir, "fixtures/ledger/valid/untracked.md", "# 未追跡\n");

    const result = updateVendoredCopies({
      vendorRoot,
      upstreamDir,
      manifestPath,
    });

    expect("error" in result).toBe(true);
  });

  // 来歴を "unknown" として記録すると、以後の差分検査の基準にならない
  // （検査不能を正常に丸めない）。
  it("上流が git 管理外なら更新せずエラーを返す", () => {
    const bare = path.join(root, "bare-upstream");
    write(bare, "schemas/runs.schema.json", '{"title":"runs v2"}\n');
    write(bare, "fixtures/ledger/valid/a.md", "# a v2\n");

    const result = updateVendoredCopies({
      vendorRoot,
      upstreamDir: bare,
      manifestPath,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("HEAD");
    expect(readManifest(manifestPath).upstream.commit).toBe("0000000");
  });

  it("構造が不正な MANIFEST では更新せずエラーを返す（例外を投げ抜けさせない）", () => {
    writeFileSync(manifestPath, JSON.stringify({ files: "oops" }), "utf-8");

    const result = updateVendoredCopies({
      vendorRoot,
      upstreamDir,
      manifestPath,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("構造が不正");
    expect(
      readFileSync(
        path.join(vendorRoot, "fixtures/ledger/valid/a.md"),
        "utf-8",
      ),
    ).toBe("# a\n");
  });
});
