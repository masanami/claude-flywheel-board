import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { isAllowedHost, isAllowedOrigin } from "../api.ts";
import type { FleetEntry } from "../manifest.ts";
import { parseClientMessage } from "./messages.ts";
import { createNodePtySpawner } from "./pty-process.ts";
import type { PtyProcess, SpawnTerminalPty } from "./pty-process.ts";
import { resolveAgentEntry, terminalSessionName } from "./session.ts";
import { createTmuxClient, ensureTmuxSession } from "./tmux.ts";
import type { TmuxClient } from "./tmux.ts";

/**
 * `/ws/terminal` の URL pathname（厳密一致）。実際のクエリは `/ws/terminal?agent=<name>`。
 * index.ts 側の upgrade ルーティングもこの pathname で振り分ける。
 */
export const TERMINAL_WS_PATH = "/ws/terminal";

export type TerminalBridgeDeps = {
  /** fleet マニフェストの entry 一覧。呼び出し側が読み込んだものを渡す（このモジュールは manifest.ts を直接読まない）。 */
  getFleetEntries: () => readonly FleetEntry[];
  tmux?: TmuxClient;
  spawnPty?: SpawnTerminalPty;
};

export type TerminalWebSocketServer = {
  wss: WebSocketServer;
  /**
   * server.on("upgrade", ...) から呼び出す想定のハンドラ。
   * `/ws/terminal` 以外の URL は何もしない（socket に触れない）ため、
   * 既存の `/ws`（api.ts の attachWebSocketServer）の upgrade ハンドラと共存できる。
   */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void;
};

/**
 * WS `/ws/terminal?agent=<name>` を node-pty ⇔ tmux にブリッジする WebSocketServer を構築する。
 *
 * クリティカル設計決定（親 Issue #2 / #14）:
 * - Origin/Host 検証は既存の isAllowedHost / isAllowedOrigin を再利用する（再実装しない）
 * - agent はマニフェスト登録名のみ許可し、任意パスでのセッション生成は行わない
 * - WS 切断時は pty プロセスのみ kill する（tmux セッションは残す。TmuxClient に
 *   kill 相当のメソッドを生やしていないため、型レベルでも tmux 終了は不可能）
 */
export function createTerminalWebSocketServer(
  deps: TerminalBridgeDeps,
): TerminalWebSocketServer {
  const tmux = deps.tmux ?? createTmuxClient();
  const spawnPty = deps.spawnPty ?? createNodePtySpawner();
  const wss = new WebSocketServer({ noServer: true });

  function handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void {
    const url = request.url ?? "";
    // pathname のみを厳密一致で判定する（`/ws/terminalXYZ` のような他パスを
    // 誤って terminal 接続として扱わないため。クエリ文字列は無視する）。
    const pathname = new URL(url, "http://localhost").pathname;
    if (pathname !== TERMINAL_WS_PATH) {
      // このハンドラの対象外。他の upgrade リスナー（既存の /ws 等）に委ねるため
      // socket には一切触れない。
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

    const parsedUrl = new URL(url, "http://localhost");
    const agentName = parsedUrl.searchParams.get("agent");
    const entry = resolveAgentEntry(deps.getFleetEntries(), agentName);
    if (!entry) {
      // 未登録の agent 名・agent クエリ欠落は拒否する（任意パスでのセッション生成不可）。
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, entry);
    });
  }

  wss.on(
    "connection",
    (ws: WebSocket, _request: IncomingMessage, entry: FleetEntry) => {
      void startTerminalSession(ws, entry, tmux, spawnPty);
    },
  );

  return { wss, handleUpgrade };
}

// 接続直後（tmux セッション確保待ち・pty 起動待ち）に届いたメッセージを溜めておく
// キューの上限。この上限を超えた分は古い順に破棄する（無制限に溜めて board の
// メモリを圧迫しないため）。
const PRE_READY_MESSAGE_QUEUE_LIMIT = 100;

async function startTerminalSession(
  ws: WebSocket,
  entry: FleetEntry,
  tmux: TmuxClient,
  spawnPty: SpawnTerminalPty,
): Promise<void> {
  const sessionName = terminalSessionName(entry.name);

  // ensureTmuxSession（tmux セッション確保）・pty spawn が完了する前に届いた
  // input/resize/prefill を、ここで一旦キューに溜める。接続直後から購読を
  // 始めることで、pty 起動前のメッセージが黙って失われる（"message" リスナー
  // 未登録のまま Receiver がフレームを parse・emit してしまう）ことを防ぐ。
  let ptyProcess: PtyProcess | undefined;
  const pendingRawMessages: string[] = [];

  function processRawMessage(raw: string): void {
    if (!ptyProcess) {
      // まだ pty が起動していない場合はここには来ない想定（呼び出し側で
      // ptyProcess の有無により振り分けている）が、念のためのガード。
      return;
    }
    const message = parseClientMessage(raw);
    if (!message) {
      return;
    }
    switch (message.type) {
      case "input":
        // node-pty のネイティブ層が同期的に throw するケース（fd が既に閉じている等）
        // を捕捉し、この接続だけに影響を閉じる（board プロセス全体を落とさない）。
        try {
          ptyProcess.write(message.data);
        } catch {
          // 該当タブでの入力が失われるのみ。board 全体を巻き込む必要は無い。
        }
        break;
      case "resize":
        try {
          ptyProcess.resize(message.cols, message.rows);
        } catch {
          // 該当タブでのリサイズが失われるのみ。board 全体を巻き込む必要は無い。
        }
        break;
      case "prefill":
        // tmux send-keys -l（literal・改行なし）で流し込む。pty.write は使わない
        // （Enter を送るコードパスをここに一切作らない）。失敗しても board 自体を
        // 落とさないよう、ここで確実に catch する（unhandledRejection 防止）。
        tmux.sendKeysLiteral(sessionName, message.command).catch(() => {
          // prefill 失敗は該当タブでのユーザー操作にのみ影響し、board 全体を
          // 巻き込む必要は無いため、ここでは静かに無視する。
        });
        break;
    }
  }

  // 接続直後から購読を開始する。pty 起動前は上限付きキューへ貯め、
  // 起動後は即座に処理する（ptyProcess の有無で振り分ける）。
  ws.on("message", (raw) => {
    const rawString = raw.toString();
    if (ptyProcess) {
      processRawMessage(rawString);
      return;
    }
    pendingRawMessages.push(rawString);
    if (pendingRawMessages.length > PRE_READY_MESSAGE_QUEUE_LIMIT) {
      // 上限超過分は古い順に破棄する。
      pendingRawMessages.shift();
    }
  });

  try {
    await ensureTmuxSession(tmux, sessionName, entry.path);
  } catch {
    ws.close(1011, "tmux セッションの確保に失敗しました");
    return;
  }

  if (ws.readyState !== WebSocket.OPEN) {
    // セッション確保待ちの間に切断済みなら pty を spawn しない。
    return;
  }

  try {
    ptyProcess = spawnPty(sessionName, entry.path);
  } catch {
    ws.close(1011, "pty の起動に失敗しました");
    return;
  }

  ptyProcess.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  ptyProcess.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  // pty 起動待ちの間に溜まっていたメッセージを、届いた順のまま処理する。
  const queued = pendingRawMessages.splice(0, pendingRawMessages.length);
  for (const raw of queued) {
    processRawMessage(raw);
  }

  // WS 切断時は pty プロセスのみ kill する。tmux セッションは残す
  // （TmuxClient に kill-session 相当のメソッドが無いため、ここから tmux を
  // 終了させることはそもそもできない）。
  const killPtyOnly = () => {
    ptyProcess?.kill();
  };
  ws.on("close", killPtyOnly);
  ws.on("error", killPtyOnly);
}
