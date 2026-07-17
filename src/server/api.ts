import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentBoard, BoardCache } from "./cache.ts";

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
 */
export function registerApiRoutes(app: Hono, cache: BoardCache): void {
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
 */
export function attachWebSocketServer(
  server: ServerType,
  cache: BoardCache,
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
