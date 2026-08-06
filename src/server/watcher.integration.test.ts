import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBoardCache } from "./cache.ts";
import type { FleetEntry } from "./manifest.ts";
import type { FleetWatcher } from "./watcher.ts";
import { fullScan, startFleetWatcher } from "./watcher.ts";

// クリティカル設計決定（NFR-01）: 監視対象ファイルへは一切書き込まない。
// このテストが実ファイルを書き換えて変更検知を検証する必要があるため、
// リポジトリ内のフィクスチャではなく os.tmpdir() 配下に都度リポジトリを再現する。

function writeAgentRepo(
  repoRoot: string,
  ledgerContent: string,
  journalContent: string,
): void {
  fs.mkdirSync(path.join(repoRoot, "journal"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "challenge-ledger.md"),
    ledgerContent,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(repoRoot, "journal", "index.jsonl"),
    journalContent,
    "utf-8",
  );
}

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

const LEDGER_V1 = [
  "# 課題台帳",
  "",
  "### [C-500] 結合テスト用の課題",
  "",
  "**分類欄（エージェントが記入）**",
  "- 担当ポジション: server-eng",
  "- 優先度: P1",
  "- ステータス: 未分類",
  "- タスク案: 1. 結合テストを書く",
  "",
].join("\n");

const LEDGER_V2 = [
  "# 課題台帳",
  "",
  "### [C-500] 結合テスト用の課題",
  "",
  "**分類欄（エージェントが記入）**",
  "- 担当ポジション: server-eng",
  "- 優先度: P1",
  "- ステータス: 着手中",
  "- タスク案: 1. 結合テストを書く",
  "",
].join("\n");

const JOURNAL_V1 =
  '{"date":"2026-07-01","seq":1,"touched_issues":[{"id":"C-500","from":"未着手","to":"分類済"}],"delegations":[],"pr_urls":[],"pending_approvals":[],"decisions":[]}\n';

const JOURNAL_V2 =
  '{"date":"2026-07-02","seq":1,"touched_issues":[{"id":"C-500","from":"分類済","to":"着手中"}],"delegations":[],"pr_urls":[],"pending_approvals":[],"decisions":[]}\n';

describe("watcher 結合テスト（実 chokidar・実フィクスチャファイル）", () => {
  let tmpRoot: string;
  let watcherHandle: FleetWatcher | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "flywheel-board-watcher-test-"),
    );
  });

  afterEach(async () => {
    await watcherHandle?.close();
    watcherHandle = undefined;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("challenge-ledger.md を実際に書き換えると chokidar が検知し、再パース→cache反映→onAgentUpdate まで行われる", async () => {
    const repoRoot = path.join(tmpRoot, "agent-a");
    writeAgentRepo(repoRoot, LEDGER_V1, JOURNAL_V1);

    const entry: FleetEntry = { name: "agent-a", path: repoRoot };
    const cache = createMemoryBoardCache();
    const updates: string[] = [];

    watcherHandle = startFleetWatcher(
      [entry],
      cache,
      (agent) => {
        updates.push(agent.challenges[0]?.status ?? "");
      },
      { debounceMs: 100, fullRescanIntervalMs: 10 * 60 * 1000 },
    );

    // chokidar の初期化（fsevents 登録等）を待ってから書き換える。
    await new Promise((resolve) => setTimeout(resolve, 300));

    fs.writeFileSync(
      path.join(repoRoot, "challenge-ledger.md"),
      LEDGER_V2,
      "utf-8",
    );

    await waitUntil(
      () => cache.getChallenge("agent-a", "C-500")?.status === "着手中",
    );

    expect(cache.getChallenge("agent-a", "C-500")?.status).toBe("着手中");
    expect(updates).toContain("着手中");
  });

  it("journal/index.jsonl を実際に書き換えると chokidar が検知し、getLog に新しいエントリが反映される", async () => {
    const repoRoot = path.join(tmpRoot, "agent-a");
    writeAgentRepo(repoRoot, LEDGER_V1, JOURNAL_V1);

    const entry: FleetEntry = { name: "agent-a", path: repoRoot };
    const cache = createMemoryBoardCache();

    watcherHandle = startFleetWatcher([entry], cache, () => {}, {
      debounceMs: 100,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    fs.writeFileSync(
      path.join(repoRoot, "journal", "index.jsonl"),
      JOURNAL_V1 + JOURNAL_V2,
      "utf-8",
    );

    await waitUntil(() => cache.getLog("agent-a", "C-500").length === 2);

    expect(cache.getLog("agent-a", "C-500")).toEqual([
      { ts: "2026-07-01", source: "journal", text: "未着手 → 分類済" },
      { ts: "2026-07-02", source: "journal", text: "分類済 → 着手中" },
    ]);
  });

  it("challenge-archive.md を実際に新規作成すると chokidar が検知し、cache.archivedChallenges に反映される（Issue #50 ①・実 chokidar での回帰確認）", async () => {
    // このテストはモックではなく実 chokidar を使う。watcher.chokidar.test.ts は
    // chokidar 自体をモックして手動 emit するため、watch() へ渡す監視対象の
    // 実効性（glob 文字列を渡しても実ファイルにマッチしない等）を検証できない
    // （セルフレビュー指摘対応）。ここでは実ファイル操作で検知できることを保証する。
    const repoRoot = path.join(tmpRoot, "agent-a");
    writeAgentRepo(repoRoot, LEDGER_V1, JOURNAL_V1);

    const entry: FleetEntry = { name: "agent-a", path: repoRoot };
    const cache = createMemoryBoardCache();

    watcherHandle = startFleetWatcher([entry], cache, () => {}, {
      debounceMs: 100,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const archiveContent = [
      "# 課題台帳アーカイブ",
      "",
      "### [C-600] アーカイブ結合テスト用の課題",
      "",
      "**分類欄（エージェントが記入）**",
      "- 担当ポジション: server-eng",
      "- 優先度: P1",
      "- ステータス: 完了",
      "- タスク案: 1. 実 chokidar でのアーカイブ検知を確認する",
      "",
    ].join("\n");
    fs.writeFileSync(
      path.join(repoRoot, "challenge-archive.md"),
      archiveContent,
      "utf-8",
    );

    await waitUntil(
      () =>
        (cache.getSnapshot().agents.find((a) => a.name === "agent-a")
          ?.archivedChallenges.length ?? 0) > 0,
    );

    const agent = cache.getSnapshot().agents.find((a) => a.name === "agent-a");
    expect(agent?.archivedChallenges.map((c) => c.id)).toEqual(["C-600"]);
  });

  it("起動時フルスキャン: repo パスが存在しなくても他の正常な repo は反映され、該当 repo は parseErrors 付きで登録される", async () => {
    const repoRoot = path.join(tmpRoot, "agent-a");
    writeAgentRepo(repoRoot, LEDGER_V1, JOURNAL_V1);

    const entries: FleetEntry[] = [
      { name: "agent-a", path: repoRoot },
      { name: "missing-agent", path: path.join(tmpRoot, "does-not-exist") },
    ];
    const cache = createMemoryBoardCache();

    await fullScan(entries, cache, () => {});

    const snapshot = cache.getSnapshot();
    expect(snapshot.agents.map((a) => a.name).sort()).toEqual([
      "agent-a",
      "missing-agent",
    ]);
    expect(cache.getChallenge("agent-a", "C-500")?.status).toBe("未分類");
    const missing = snapshot.agents.find((a) => a.name === "missing-agent");
    expect(missing?.challenges).toEqual([]);
    expect(missing?.parseErrors.length).toBeGreaterThan(0);
  });

  it("addAgentWatch で動的に追加した repo の challenge-ledger.md 書き換えも実 chokidar で検知される（Issue #121）", async () => {
    const repoRootA = path.join(tmpRoot, "agent-a");
    writeAgentRepo(repoRootA, LEDGER_V1, JOURNAL_V1);
    const entryA: FleetEntry = { name: "agent-a", path: repoRootA };

    const cache = createMemoryBoardCache();

    watcherHandle = startFleetWatcher([entryA], cache, () => {}, {
      debounceMs: 100,
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    // 固定 sleep ではなく、起動時 entry（agent-a）が ready 後の整合スキャンで
    // cache に反映されるのを明示的に待つ（セルフレビュー指摘対応: 末尾の
    // 「既存 entry は動的追加の影響を受けない」アサーションが暗黙に
    // ready 完了へ依存していたため、負荷時の flaky 化要因になっていた）。
    await waitUntil(
      () => cache.getChallenge("agent-a", "C-500")?.status === "未分類",
    );

    // Issue #119 が想定するオンボーディングの流れ: 起動後に新規エージェントの
    // repo が追加される。事前にファイルを用意してから動的追加する。
    const repoRootNew = path.join(tmpRoot, "agent-new");
    writeAgentRepo(repoRootNew, LEDGER_V1, JOURNAL_V1);
    const entryNew: FleetEntry = { name: "agent-new", path: repoRootNew };

    await watcherHandle.addAgentWatch(entryNew);

    // 動的追加時の初回スキャンで新規 entry が既に反映されていること。
    expect(cache.getChallenge("agent-new", "C-500")?.status).toBe("未分類");

    fs.writeFileSync(
      path.join(repoRootNew, "challenge-ledger.md"),
      LEDGER_V2,
      "utf-8",
    );

    await waitUntil(
      () => cache.getChallenge("agent-new", "C-500")?.status === "着手中",
    );

    expect(cache.getChallenge("agent-new", "C-500")?.status).toBe("着手中");
    // 既存 entry（agent-a）は動的追加の影響を受けず、引き続き元の状態のまま。
    expect(cache.getChallenge("agent-a", "C-500")?.status).toBe("未分類");
  });
});
