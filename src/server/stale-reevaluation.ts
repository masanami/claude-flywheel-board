import type { AgentBoard, BoardCache } from "./cache.ts";
import { computeElapsedMs } from "./parsers/runs.ts";

// push オーケストレーション（定期再評価タイマー）は cache.ts の読み取り
// キャッシュ実装（BoardCache: replace* / get* の同期的な索引）とは異なる関心事
// のため、本ファイルへ分離する（Issue #36 項目2）。fs watcher（watcher.ts）と
// 同格の「cache を定期的に叩いて WS push を駆動する」役割であり、cache.ts は
// このファイルを import しない（一方向依存。循環参照にはならない）。

export type StaleReevaluationTimer = { close(): void };

export type StaleReevaluationOptions = {
  /** 再評価間隔（ミリ秒）。既定 60_000（1分）。 */
  intervalMs?: number;
  /** 現在時刻を返す関数。既定 () => new Date()（テストで時刻を Mock するための DI）。 */
  now?: () => Date;
  /** setInterval の DI 用。既定 global setInterval。 */
  setIntervalFn?: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  /** clearInterval の DI 用。既定 global clearInterval。 */
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
};

/**
 * cycleStatus + runningRuns（の stale 値等）の変化を検知するための署名。
 * 変化検知に十分な情報（kind/key/endedAt/stale）に加え、実行中 run の
 * 経過分バケット（elapsedMinutes）を含める — UI の経過時間表示は
 * クライアント側タイマーを持たず agent_update の再描画でのみ更新されるため、
 * 分が進むごとに署名が変わって push が発生することが表示更新の前提になる
 * （実行中 run が無いエージェントは従来どおり変化時のみ push）。
 */
function computeAgentSignature(agent: AgentBoard, nowMs: number): string {
  return JSON.stringify({
    cycleStatus: agent.cycleStatus,
    runningRuns: (agent.runningRuns ?? []).map((run) => ({
      kind: run.kind,
      key: run.key,
      endedAt: run.endedAt,
      stale: run.stale,
      elapsedMinutes: run.endedAt
        ? null
        : Math.floor(computeElapsedMs(run.startedAt, nowMs) / 60_000),
    })),
  });
}

const DEFAULT_STALE_REEVALUATION_INTERVAL_MS = 60_000;

/**
 * intervalMs（既定1分）ごとに cache.getSnapshot(now) を再計算し、前回 push した
 * cycleStatus/runningRuns から変化があったエージェントのみ onAgentUpdate を呼ぶ
 * （無変化なら push せず、無駄な WS broadcast を避ける）。fs イベントも API 呼び出しも
 * 起きない間に stale へ変わったことへ誰も気づけない問題を解消するための定期タイマー。
 */
export function startStaleReevaluation(
  cache: BoardCache,
  onAgentUpdate: (agent: AgentBoard) => void,
  options: StaleReevaluationOptions = {},
): StaleReevaluationTimer {
  const intervalMs =
    options.intervalMs ?? DEFAULT_STALE_REEVALUATION_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  const lastSignatureByAgent = new Map<string, string>();
  // 起動時点のスナップショットを基準にしておく（初回 tick で無変化なら push しない）。
  const initialNow = now().getTime();
  for (const agent of cache.getSnapshot(new Date(initialNow)).agents) {
    lastSignatureByAgent.set(
      agent.name,
      computeAgentSignature(agent, initialNow),
    );
  }

  const timer = setIntervalFn(() => {
    const tickNow = now();
    const snapshot = cache.getSnapshot(tickNow);
    for (const agent of snapshot.agents) {
      const signature = computeAgentSignature(agent, tickNow.getTime());
      if (lastSignatureByAgent.get(agent.name) !== signature) {
        lastSignatureByAgent.set(agent.name, signature);
        onAgentUpdate(agent);
      }
    }
  }, intervalMs);

  // board 停止（プロセス終了）をタイマーが妨げないようにする（watcher.ts の
  // rescanInterval.unref() と同様）。DI 注入されたテストダブルには unref が
  // 無い可能性があるため、存在チェックしてから呼ぶ。
  const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") {
    maybeUnref.call(timer);
  }

  return {
    close() {
      clearIntervalFn(timer);
    },
  };
}
