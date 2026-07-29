import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetEntry } from "../manifest.ts";
import type { MdWatchRegistry } from "./watch.ts";
import { createMdWatchRegistry } from "./watch.ts";

// Issue #88 セルフレビュー指摘対応: src/server/api.test.ts の
// md_subscribe/md_unsubscribe（Issue #67）ブロックは決定性・高速化のため
// chokidar をモック化した。その結果、「md/watch.ts が実 chokidar の watch() 呼び
// 出しで実際にファイル変更を検知できる」ことを保証するテストがリポジトリから
// 失われていた（watcher.integration.test.ts が startFleetWatcher に対して同じ
// 理由で維持している実 chokidar 回帰テストの、md/watch.ts 版が存在しない状態）。
//
// chokidar をモックする単体テスト（watch.test.ts）は watch() へ渡す監視対象
// パスの実効性（例: glob 文字列を渡しても実ファイルにマッチしない等）を検証
// できないため、ここでは実ファイル操作で検知できることを最小限のケースで
// 保証する。api.test.ts と同様、監視対象ファイルへの書き込みは検証専用の
// os.tmpdir() 配下フィクスチャに対してのみ行い、状態ファイル（台帳・journal・
// memory・runs.jsonl）には一切触れない（NFR-01）。
describe("createMdWatchRegistry（実 chokidar での回帰確認）", () => {
  let tmpRoot: string;
  let registry: MdWatchRegistry | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "md-watch-integration-"));
  });

  afterEach(async () => {
    await registry?.closeAll();
    registry = undefined;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function waitUntil(
    condition: () => boolean,
    { timeoutMs = 5000, intervalMs = 50 } = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`waitUntil: タイムアウトしました（${timeoutMs}ms）`);
  }

  it("実ファイルを保存すると実 chokidar が検知し、broadcastFileChanged が呼ばれる", async () => {
    const docPath = path.join(tmpRoot, "doc.md");
    fs.writeFileSync(docPath, "# doc");
    const entry: FleetEntry = { name: "myrepo", path: tmpRoot };
    const changes: unknown[] = [];
    registry = createMdWatchRegistry(
      () => [entry],
      (message) => changes.push(message),
    );
    const ws = { readyState: 1, send: () => {} };

    registry.subscribe(ws as never, "myrepo", "doc.md");
    // watcher.integration.test.ts と同じ理由: 実 chokidar は非同期に監視を
    // 開始するため、確立を待ってから書き込む。
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(docPath, "# doc changed");

    await waitUntil(() => changes.length > 0);
    expect(changes[0]).toEqual({
      type: "md_file_changed",
      repo: "myrepo",
      path: "doc.md",
    });
  });
});
