import { EventEmitter } from "node:events";
import * as path from "node:path";
import type { FSWatcher } from "chokidar";
import { watch } from "chokidar";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryBoardCache } from "./cache.ts";
import type { FleetEntry } from "./manifest.ts";
import type {
  JournalEntry,
  ParseError as JournalParseError,
} from "./parsers/journal.ts";
import { parseJournal } from "./parsers/journal.ts";
import type {
  Challenge,
  ParseError as LedgerParseError,
} from "./parsers/ledger.ts";
import { parseLedgerFile } from "./parsers/ledger.ts";
import { startFleetWatcher } from "./watcher.ts";

// エージェント単位の直列化（クリティカル設計決定: debounce 再スキャンと低頻度
// フル再スキャンなど、複数のトリガーが同一エージェントへの再スキャンを
// 並行させても、古い（が遅く終わる）スキャン結果が新しいスキャン結果を
// 上書きしてはならない）を検証する回帰テスト。
//
// parseLedgerFile / parseJournal をモックし、1回目のスキャン（「古い」内容）の
// 完了を deferred Promise で完全に制御下に置く。直列化されていれば、1回目が
// 完了する前は2回目の scanAndUpdateAgent 本体（parseLedgerFile 呼び出し）が
// 実行されないことを、タイマー猶予に依存せず決定的に確認できる。
vi.mock("chokidar", () => ({ watch: vi.fn() }));

vi.mock("./parsers/ledger.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./parsers/ledger.ts")>();
  return { ...actual, parseLedgerFile: vi.fn() };
});

vi.mock("./parsers/journal.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./parsers/journal.ts")>();
  return { ...actual, parseJournal: vi.fn() };
});

class FakeFSWatcher extends EventEmitter {
  close = vi.fn().mockResolvedValue(undefined);
}

function mockChokidarWatch(): FakeFSWatcher {
  const fake = new FakeFSWatcher();
  vi.mocked(watch).mockReturnValue(fake as unknown as FSWatcher);
  return fake;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  { timeoutMs = 3000, intervalMs = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitUntil: タイムアウトしました（${timeoutMs}ms）`);
}

type JournalScanResult = {
  entries: JournalEntry[];
  errors: JournalParseError[];
};

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const agentA: FleetEntry = { name: "agent-a", path: "/agents/agent-a" };

beforeEach(() => {
  vi.mocked(watch).mockReset();
  vi.mocked(parseLedgerFile).mockReset();
  vi.mocked(parseJournal).mockReset();
});

describe("startFleetWatcher のエージェント単位直列化", () => {
  it("遅い旧スキャンの完了前は新スキャンが実行されず、完了後の cache は新スキャンの内容になる", async () => {
    const fake = mockChokidarWatch();
    const cache = createMemoryBoardCache();
    const onAgentUpdate = vi.fn();

    let ledgerCallCount = 0;
    vi.mocked(parseLedgerFile).mockImplementation(() => {
      ledgerCallCount += 1;
      const status = ledgerCallCount === 1 ? "着手中" : "検証中";
      const challenge: Challenge = {
        id: "C-500",
        title: "直列化テスト用課題",
        status,
        needsHuman: false,
      };
      return { challenges: [challenge], errors: [] as LedgerParseError[] };
    });

    const firstJournalCall = createDeferred<JournalScanResult>();
    let journalCallCount = 0;
    vi.mocked(parseJournal).mockImplementation(async () => {
      journalCallCount += 1;
      if (journalCallCount === 1) {
        // 1回目（「古い」内容の読み取り）は完了タイミングを完全に手動制御する。
        return firstJournalCall.promise;
      }
      return { entries: [], errors: [] };
    });

    const fleetWatcher = startFleetWatcher([agentA], cache, onAgentUpdate, {
      debounceMs: 5,
      // 定期フル再スキャンはこのテストでは発火させない
      // （debounce 経由の2回のトリガーだけでエージェント単位の直列化を検証する）。
      fullRescanIntervalMs: 10 * 60 * 1000,
    });

    // 1回目: debounce 経由のスキャン（「古い」内容）を起動する。
    fake.emit("change", path.join(agentA.path, "challenge-ledger.md"));
    await waitUntil(() => ledgerCallCount >= 1);
    await waitUntil(() => journalCallCount >= 1);

    // 2回目: 1回目がまだ完了していない状態で、別トリガー（「新しい」内容）を起動する。
    fake.emit("change", path.join(agentA.path, "challenge-ledger.md"));
    // debounceMs（5ms）を十分に超えて待ち、2回目の debounce タイマー自体は
    // 発火してよい猶予を与える。直列化されていれば、それでも2回目の
    // scanAndUpdateAgent 本体（parseLedgerFile 呼び出し）はまだ実行されない。
    await sleep(50);

    expect(ledgerCallCount).toBe(1);

    // 1回目を完了させる。直列化キューにより、これで初めて2回目が実行される。
    firstJournalCall.resolve({ entries: [], errors: [] });

    await waitUntil(() => ledgerCallCount >= 2);
    await waitUntil(
      () => cache.getChallenge("agent-a", "C-500")?.status === "検証中",
    );

    expect(cache.getChallenge("agent-a", "C-500")?.status).toBe("検証中");

    await fleetWatcher.close();
  });
});
