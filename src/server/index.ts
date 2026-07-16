import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { attachWebSocketServer, registerApiRoutes } from "./api.ts";
import type { BoardCache } from "./cache.ts";
import { createMemoryBoardCache } from "./cache.ts";
import { loadFleetManifest } from "./manifest.ts";
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
  await fullScan(fleetEntries, cache, broadcastAgentUpdate);
  const fleetWatcher = startFleetWatcher(
    fleetEntries,
    cache,
    broadcastAgentUpdate,
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // close() は chokidar ハンドルやタイマーの解放を待つ Promise を返すが、
      // プロセスは直後の process.exit(0) で終了するため意図的に待たない
      // （fire-and-forget）。OS 側でハンドルは回収されるため実害はない。
      void fleetWatcher.close();
      server.close();
      process.exit(0);
    });
  }
}
