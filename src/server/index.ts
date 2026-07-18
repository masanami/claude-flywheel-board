import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { attachWebSocketServer, registerApiRoutes } from "./api.ts";
import type { BoardCache } from "./cache.ts";
import { createMemoryBoardCache } from "./cache.ts";
import { loadFleetManifest } from "./manifest.ts";
import {
  TERMINAL_WS_PATH,
  createTerminalWebSocketServer,
} from "./pty/bridge.ts";
import type { TerminalWebSocketServer } from "./pty/bridge.ts";
import { startStaleReevaluation } from "./stale-reevaluation.ts";
import { fullScan, startFleetWatcher } from "./watcher.ts";

// NFR-03 / クリティカル設計決定: サーバは 127.0.0.1 に固定バインドする。
// 環境変数・起動引数など、外部からホストを上書きできる口は意図的に作らない。
export const LISTEN_HOSTNAME = "127.0.0.1";

const DEFAULT_PORT = 4317;

// ビルド済み UI（vite build の出力）を静的配信するルート。
const UI_DIST_ROOT = fileURLToPath(new URL("../../dist/ui", import.meta.url));

/**
 * cache は省略時にプロセス内蔵のメモリキャッシュを生成する（NFR-04: 読み取り
 * キャッシュ。破棄しても正本ファイルから再構築できる）。呼び出し側は
 * HTTP（このアプリ）と WS（attachWebSocketServer）で同一インスタンスを共有できる
 * よう、明示的に渡すこともできる。
 */
export function createApp(cache: BoardCache = createMemoryBoardCache()) {
  const app = new Hono();
  // api ルートは静的配信ミドルウェアより先に登録する。
  registerApiRoutes(app, cache);
  app.use("/*", serveStatic({ root: UI_DIST_ROOT }));
  return app;
}

/**
 * @hono/node-server の serve() に渡すオプションを組み立てる。
 * hostname は常に LISTEN_HOSTNAME 固定であり、引数として受け取らない
 * （＝呼び出し側からホストを上書きする経路が存在しない）。
 */
export function getServeOptions(
  port: number = DEFAULT_PORT,
  cache: BoardCache = createMemoryBoardCache(),
) {
  return {
    fetch: createApp(cache).fetch,
    hostname: LISTEN_HOSTNAME,
    port,
  };
}

/**
 * `/ws/terminal` の upgrade ルーティングを既存の `/ws`（attachWebSocketServer が
 * 自ら登録する upgrade リスナー）と共存させる形で server へ追加登録する。
 *
 * - attachWebSocketServer 側の upgrade リスナーは `/ws` 以外の URL では
 *   何もしない（socket に触れない）よう変更済みのため、ここで追加する
 *   terminalWebSocketServer.handleUpgrade（`/ws/terminal` 以外は何もしない）と
 *   お互いに干渉しない。
 * - どちらの pathname にも一致しない upgrade リクエストは、最後に登録する
 *   catch-all リスナーで destroy する（従来 attachWebSocketServer 単体が
 *   担っていた「未知の upgrade パスは拒否する」という安全側の挙動を維持する）。
 */
export function attachTerminalUpgradeRouting(
  server: ServerType,
  terminalWebSocketServer: TerminalWebSocketServer,
): void {
  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      terminalWebSocketServer.handleUpgrade(request, socket, head);
    },
  );

  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    const pathname = new URL(request.url ?? "", "http://localhost").pathname;
    if (pathname !== "/ws" && pathname !== TERMINAL_WS_PATH) {
      socket.destroy();
    }
  });
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  // HTTP と WS で同一の cache インスタンスを共有する。
  const cache = createMemoryBoardCache();
  const server = serve(getServeOptions(DEFAULT_PORT, cache), (info) => {
    console.log(
      `claude-flywheel-board listening on http://${LISTEN_HOSTNAME}:${info.port}`,
    );
  });
  const { broadcastAgentUpdate } = attachWebSocketServer(server, cache);

  // fleet マニフェスト読込 → 起動時フルスキャンでキャッシュ構築 → watcher 起動
  // （FR-06）。fleet.tsv 自体の不正（存在しない・書式違反）は起動を止める致命的
  // エラーとして扱う（manifest.ts の既存方針）。個々の repo パス不存在等は
  // scanAgent 側で ParseError 化され、この起動フローは止まらない。
  const fleetEntries = loadFleetManifest();

  // pty ブリッジ（P2-1）: /ws/terminal を既存の /ws と共存させる形で追加登録する。
  const terminalWebSocketServer = createTerminalWebSocketServer({
    getFleetEntries: () => fleetEntries,
  });
  attachTerminalUpgradeRouting(server, terminalWebSocketServer);

  await fullScan(fleetEntries, cache, broadcastAgentUpdate);
  const fleetWatcher = startFleetWatcher(
    fleetEntries,
    cache,
    broadcastAgentUpdate,
  );

  // P3: fs イベントも API 呼び出しも起きない間に stale へ変わったことへ誰も
  // 気づけない問題を解消するための定期再評価（既定1分間隔）。
  // staleMinutes は cache 側の既定（resolveStaleMinutes()）をそのまま使う。
  const staleReevaluationTimer = startStaleReevaluation(
    cache,
    broadcastAgentUpdate,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // close() は chokidar ハンドルやタイマーの解放を待つ Promise を返すが、
      // プロセスは直後の process.exit(0) で終了するため意図的に待たない
      // （fire-and-forget）。OS 側でハンドルは回収されるため実害はない。
      void fleetWatcher.close();
      staleReevaluationTimer.close();
      server.close();
      process.exit(0);
    });
  }
}
