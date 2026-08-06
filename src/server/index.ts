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
import { NO_FLEET_ENTRIES, loadFleetManifest } from "./manifest.ts";
import type { FleetEntry, GetFleetEntries } from "./manifest.ts";
import {
  TERMINAL_WS_PATH,
  createTerminalWebSocketServer,
} from "./pty/bridge.ts";
import type { TerminalWebSocketServer } from "./pty/bridge.ts";
import { startStaleReevaluation } from "./stale-reevaluation.ts";
import { fullScan, startFleetWatcher } from "./watcher.ts";
import type { FleetWatcher } from "./watcher.ts";

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
 *
 * getFleetEntries は省略時 fleet entries 無し（NO_FLEET_ENTRIES）扱いになる。md 系
 * エンドポイント（別チケット、Issue #62）が repo ルート解決のために fleet entries を
 * 必要とするため、registerApiRoutes まで貫通させる受け皿として先に通す（実際に参照
 * するエンドポイントの追加はこのチケットのスコープ外）。本番の起動経路
 * （isMainModule ブロック）では常に loadFleetManifest() 由来の getFleetEntries を
 * 明示的に渡すため、この既定値は既存呼び出し元・テストの後方互換のためだけに存在する。
 */
export function createApp(
  cache: BoardCache = createMemoryBoardCache(),
  getFleetEntries: GetFleetEntries = NO_FLEET_ENTRIES,
) {
  const app = new Hono();
  // api ルートは静的配信ミドルウェアより先に登録する。
  registerApiRoutes(app, cache, getFleetEntries);
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
  getFleetEntries: GetFleetEntries = NO_FLEET_ENTRIES,
) {
  return {
    fetch: createApp(cache, getFleetEntries).fetch,
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

/**
 * 稼働中サーバへ新規エージェントを1件動的に追加する「再構築機構」（Issue #121）。
 *
 * HTTP（registerApiRoutes / createApp 経由）・WS（attachWebSocketServer）・
 * pty ブリッジ（createTerminalWebSocketServer）は起動時に渡された getFleetEntries
 * コールバック経由で fleetEntries 配列を遅延参照している（Issue #62）。この
 * 配列（同一参照）へ push することで、次回以降の getFleetEntries() 呼び出しが
 * 新 entry を含むようになる。fleetWatcher へは addAgentWatch で追加し、
 * 稼働中の chokidar 監視ハンドルを再生成せずに監視対象へ加える。
 *
 * クリティカル設計決定: loadFleetManifest() をここから再度呼び出さない
 * （「loadFleetManifest() の呼び出しは起動時1箇所のみ」という isMainModule
 * ブロックの不変条件を維持する）。fleet.tsv への追記（#120）・API エンドポイント
 * としての配線（#122）・name 重複や repo パス妥当性等のバリデーションはこの
 * 関数のスコープ外（無条件追加。将来 #122 側の責務）。
 *
 * 失敗時の挙動（セルフレビュー指摘対応の明記）: fleetEntries への push は常に
 * 成功する（同期処理・例外なし）。その後の addAgentWatch が失敗した場合、
 * push 済みの entry はロールバックされず、HTTP/WS/pty からは見えるが
 * watcher には監視されない状態になりうる。また戻り値の Promise が resolve
 * することは「追加した entry の初回スキャンが完了した」ことを意味するのみで、
 * スキャン自体の成否（parseErrors の有無）までは表さない
 * （scanAgent の既存方針どおり、読み込み失敗は例外ではなく該当 entry の
 * ParseError として可視化される）。呼び出し元（#122）がこれらを利用者へ
 * 通知する必要がある場合は、呼び出し元の責務として設計する。
 */
export async function addFleetEntry(
  fleetEntries: FleetEntry[],
  fleetWatcher: FleetWatcher,
  entry: FleetEntry,
): Promise<void> {
  fleetEntries.push(entry);
  await fleetWatcher.addAgentWatch(entry);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  // fleet マニフェスト読込（FR-06）。fleet.tsv 自体の不正（存在しない・書式違反）は
  // 起動を止める致命的エラーとして扱う（manifest.ts の既存方針）。個々の repo
  // パス不存在等は scanAgent 側で ParseError 化され、この起動フローは止まらない。
  //
  // loadFleetManifest() の呼び出しはこの1箇所のみとし、HTTP（registerApiRoutes /
  // createApp 経由）・WS（attachWebSocketServer）・pty ブリッジ
  // （createTerminalWebSocketServer）のすべてが getFleetEntries 経由で
  // 同一インスタンスを共有する（Issue #62）。この「1箇所のみ」という不変条件は
  // NFR-01 のような他の不変条件と同様、単体テストではなくコードレビュー／grep で
  // 検証する。isMainModule ガード配下は実プロセスの起動処理であり、テストから
  // 到達させる対象ではないため。確認コマンド（コメント行を構造的に除外するので、
  // この注釈コメント自身には一致しない）:
  //   grep -n "loadFleetManifest(" src/server/index.ts | grep -v '^[0-9]*:[[:space:]]*\(//\|\*\)'
  // → 実際の呼び出し行（`const fleetEntries = loadFleetManifest();`）1件のみに一致するはず。
  const fleetEntries = loadFleetManifest();
  const getFleetEntries: GetFleetEntries = () => fleetEntries;

  // HTTP と WS で同一の cache インスタンスを共有する。
  const cache = createMemoryBoardCache();
  const server = serve(
    getServeOptions(DEFAULT_PORT, cache, getFleetEntries),
    (info) => {
      console.log(
        `claude-flywheel-board listening on http://${LISTEN_HOSTNAME}:${info.port}`,
      );
    },
  );
  const { broadcastAgentUpdate, closeMdWatches } = attachWebSocketServer(
    server,
    cache,
    getFleetEntries,
  );

  // pty ブリッジ（P2-1）: /ws/terminal を既存の /ws と共存させる形で追加登録する。
  const terminalWebSocketServer = createTerminalWebSocketServer({
    getFleetEntries,
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
      // Issue #67 セルフレビュー指摘対応: プレビュー用動的 watch（md_subscribe
      // 経由）も fleetWatcher と同様に chokidar ハンドルを保持するため、同じ
      // fire-and-forget 方針でシャットダウン時に解放する。
      void closeMdWatches();
      staleReevaluationTimer.close();
      server.close();
      process.exit(0);
    });
  }
}
