import * as fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentBoard, BoardCache } from "./cache.ts";
import type { GetFleetEntries } from "./manifest.ts";
import { validateMdPath } from "./md/path-validation.ts";
import { listMdTree } from "./md/tree.ts";

/**
 * `GET /api/md/file` が読み取りを許可する上限サイズ（親 Issue #61 のクリティカル
 * 設計決定）。この基準を超えるファイルは `fs.stat` の時点で弾き、本文
 * （`fs.promises.readFile`）を一切読み込まない。
 */
const MD_FILE_MAX_BYTES = 1024 * 1024;

// クリティカル設計決定（親 Issue #1）: HTTP / WS とも 127.0.0.1 固定バインドを前提に、
// Host / Origin ヘッダを検証し localhost / 127.0.0.1 以外からのアクセスを拒否する。

const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
]);

/**
 * Host ヘッダ（ポート番号付きも許容）が localhost / 127.0.0.1 かどうかを判定する。
 * ヘッダが存在しない場合は拒否する（HTTP リクエストには常に Host が付与されるため）。
 */
export function isAllowedHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  const hostname = hostHeader.split(":")[0] ?? "";
  return ALLOWED_HOSTNAMES.has(hostname);
}

/**
 * Origin ヘッダが http(s)://localhost / http(s)://127.0.0.1（ポート番号付きも許容）
 * かどうかを判定する。ヘッダが存在しない Origin（非ブラウザからの直接アクセス等）は許容する。
 */
export function isAllowedOrigin(
  originHeader: string | null | undefined,
): boolean {
  if (!originHeader) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  return ALLOWED_HOSTNAMES.has(url.hostname);
}

/**
 * /api/* ルートに Origin / Host 検証と board API を登録する。
 * 静的配信ミドルウェアより先に呼び出すこと（呼び出し側 index.ts の責務）。
 *
 * getFleetEntries（Issue #62）: md 系エンドポイント（Issue #65 以降）はすべて manifest
 * から repo ルートを解決する必要があるため、fleet entries を遅延参照できるコール
 * バックを受け取れるようにする（pty/bridge.ts の
 * createTerminalWebSocketServer({ getFleetEntries }) と同じ DI パターン。
 * TerminalBridgeDeps.getFleetEntries と同様、必須の依存として受け取る。省略時の
 * 既定値は上位の createApp / getServeOptions 側でのみ持たせ、この関数自身は暗黙に
 * 空 fleet へフォールバックしない）。ルート登録処理自体（この関数の呼び出し時点）は
 * getFleetEntries を呼び出さない。各 md ハンドラ内でリクエストのたびに呼び出す
 * （eager 評価を持ち込まない）。
 */
export function registerApiRoutes(
  app: Hono,
  cache: BoardCache,
  getFleetEntries: GetFleetEntries,
): void {
  app.use("/api/*", async (c, next) => {
    if (!isAllowedHost(c.req.header("host"))) {
      return c.text("Forbidden", 403);
    }
    if (!isAllowedOrigin(c.req.header("origin"))) {
      return c.text("Forbidden", 403);
    }
    await next();
  });

  app.get("/api/board", (c) => c.json(cache.getSnapshot()));

  app.get("/api/log", (c) => {
    const agent = c.req.query("agent");
    const challenge = c.req.query("challenge");
    if (!agent || !challenge) {
      return c.text(
        "Bad Request: agent, challenge クエリパラメータが必要です",
        400,
      );
    }
    return c.json(cache.getLog(agent, challenge));
  });

  app.get("/api/md/tree", (c) => c.json(listMdTree(getFleetEntries())));

  // クリティカル設計決定（親 Issue #61）: 検証失敗・不存在・.md 以外はすべて同一の
  // 404 とし、パスの存在有無を漏らさない。理由は問わず validateMdPath の
  // ok:false をそのまま 404 に変換する（呼び出し側で理由分岐しない）。例外として
  // 検証をすべて通過したファイルのサイズ超過（1MB 超）のみ 413 で区別する。
  // サイズ判定は本文読み込み（fs.promises.readFile）より必ず先に fs.promises.stat
  // で行い、上限超過時は本文を一切読み込まない。
  app.get("/api/md/file", async (c) => {
    const repo = c.req.query("repo") ?? "";
    const repoRelativePath = c.req.query("path") ?? "";

    const validation = validateMdPath(
      getFleetEntries(),
      repo,
      repoRelativePath,
    );
    if (!validation.ok) {
      return c.text("Not Found", 404);
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(validation.resolvedPath);
    } catch {
      // validateMdPath 通過直後のレース（読み取り直前に削除された等）も
      // 存在有無を漏らさないため同一の 404 として扱う。
      return c.text("Not Found", 404);
    }
    if (stat.size > MD_FILE_MAX_BYTES) {
      return c.text("Payload Too Large", 413);
    }

    let content: string;
    try {
      content = await fs.promises.readFile(validation.resolvedPath, "utf-8");
    } catch (err) {
      // 権限不足・stat 後の削除レース等も、検証失敗・不存在と同様に
      // クライアントへの応答は同一の 404 とし、存在有無を漏らさない（500 を返さない）。
      // ただし運用時の切り分け（設定ミス等が「.md が読めない」と見分けが付かなくなる
      // ことを避ける目的で、tree.ts が repo ルート階層の走査失敗を console.warn で
      // 記録するのと同じ動機）のため、サーバ側ログには残す（クライアント応答は変えない）。
      // 注意: tree.ts は非ルート（個別ファイル/ディレクトリ）の走査失敗は黙殺する方針
      // であり、ここでの記録はその方針を単純に踏襲したものではない（本エンドポイントは
      // そもそも「1ファイルの読み取り」単位のため、tree.ts の非ルート走査とは対応しない）。
      console.warn(
        `GET /api/md/file: 検証通過後のファイル読み取りに失敗しました: ${validation.resolvedPath}`,
        err,
      );
      return c.text("Not Found", 404);
    }
    return c.json({ content });
  });
}

export type BoardWebSocketServer = {
  wss: WebSocketServer;
  /** repo 単位の全量置き換え（watcher 由来）を接続中の全クライアントへ配信する。 */
  broadcastAgentUpdate(agent: AgentBoard): void;
};

/**
 * @hono/node-server の serve() が返す http.Server に WebSocket（/ws）をアタッチする。
 * noServer: true で生成し、upgrade イベントを手動でハンドシェイクすることで
 * Origin / Host 検証を挟む（HTTP と同じ許可条件）。
 *
 * getFleetEntries（Issue #62）: registerApiRoutes と同じ受け皿（必須の依存として
 * 受け取る。既定値は上位の createApp / getServeOptions 側でのみ持たせる）。この
 * 関数の本体も現時点では getFleetEntries を呼び出さない（md 系 WS メッセージ種別を
 * 追加する別チケットの受け皿）。
 */
export function attachWebSocketServer(
  server: ServerType,
  cache: BoardCache,
  getFleetEntries: GetFleetEntries,
): BoardWebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      // pathname のみを厳密一致で判定する（bridge.ts の /ws/terminal 判定と統一）。
      // request.url の完全一致だと `/ws?x` のようなクエリ付き URL がどちらの
      // upgrade ハンドラにも一致せず、半開き接続のまま残ってしまうため。
      const pathname = new URL(request.url ?? "", "http://localhost").pathname;
      if (pathname !== "/ws") {
        // このハンドラの対象外。/ws/terminal 等、他の upgrade リスナーと共存
        // させるため socket には触れない（destroy しない）。
        return;
      }
      if (
        !isAllowedHost(request.headers.host) ||
        !isAllowedOrigin(request.headers.origin)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    },
  );

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "snapshot", board: cache.getSnapshot() }));
  });

  function broadcastAgentUpdate(agent: AgentBoard): void {
    const message = JSON.stringify({ type: "agent_update", agent });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  return { wss, broadcastAgentUpdate };
}
