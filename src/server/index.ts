import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

// NFR-03 / クリティカル設計決定: サーバは 127.0.0.1 に固定バインドする。
// 環境変数・起動引数など、外部からホストを上書きできる口は意図的に作らない。
export const LISTEN_HOSTNAME = "127.0.0.1";

const DEFAULT_PORT = 4317;

// ビルド済み UI（vite build の出力）を静的配信するルート。
const UI_DIST_ROOT = fileURLToPath(new URL("../../dist/ui", import.meta.url));

export function createApp() {
  const app = new Hono();
  app.use("/*", serveStatic({ root: UI_DIST_ROOT }));
  return app;
}

/**
 * @hono/node-server の serve() に渡すオプションを組み立てる。
 * hostname は常に LISTEN_HOSTNAME 固定であり、引数として受け取らない
 * （＝呼び出し側からホストを上書きする経路が存在しない）。
 */
export function getServeOptions(port: number = DEFAULT_PORT) {
  return {
    fetch: createApp().fetch,
    hostname: LISTEN_HOSTNAME,
    port,
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const server = serve(getServeOptions(), (info) => {
    console.log(
      `claude-flywheel-board listening on http://${LISTEN_HOSTNAME}:${info.port}`,
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
  }
}
