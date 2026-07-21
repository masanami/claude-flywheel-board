import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { isAllowedHost, isAllowedOrigin } from "../api.ts";
import type { FleetEntry } from "../manifest.ts";
import { parseClientMessage } from "./messages.ts";
import { createNodePtySpawner } from "./pty-process.ts";
import type { PtyProcess, SpawnTerminalPty } from "./pty-process.ts";
import { resolveAgentEntry, terminalSessionName } from "./session.ts";
import type { TerminalSessionKind } from "./session.ts";
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
  /** バックプレッシャー制御（低水位監視）の setInterval DI 用。既定 global setInterval。 */
  setIntervalFn?: (handler: () => void, timeoutMs: number) => NodeJS.Timeout;
  /** バックプレッシャー制御（低水位監視）の clearInterval DI 用。既定 global clearInterval。 */
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
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
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
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

    // kind クエリ（#57・縦分割）: 欠落時は既存クライアント（kind 非対応）との
    // 後方互換のため "agent" を既定にする。"agent"/"shell" 以外の値は、未知の
    // 種別でセッション・prefill 許可を誤って解決しないよう安全側（拒否）に倒す。
    const kindParam = parsedUrl.searchParams.get("kind");
    let kind: TerminalSessionKind;
    if (kindParam === null || kindParam === "agent") {
      kind = "agent";
    } else if (kindParam === "shell") {
      kind = "shell";
    } else {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, entry, kind);
    });
  }

  wss.on(
    "connection",
    (
      ws: WebSocket,
      _request: IncomingMessage,
      entry: FleetEntry,
      // wss.emit を直接叩く既存テストヘルパー（connectFakeWebSocket）との後方互換のため、
      // kind 省略時は "agent" 扱いにする。
      kind: TerminalSessionKind = "agent",
    ) => {
      void startTerminalSession(
        ws,
        entry,
        kind,
        tmux,
        spawnPty,
        setIntervalFn,
        clearIntervalFn,
      );
    },
  );

  return { wss, handleUpgrade };
}

// 接続直後（tmux セッション確保待ち・pty 起動待ち）に届いたメッセージを溜めておく
// キューの上限。この上限を超えた分は古い順に破棄する（無制限に溜めて board の
// メモリを圧迫しないため）。
const PRE_READY_MESSAGE_QUEUE_LIMIT = 100;

// バックプレッシャー制御（Issue #26 / PR #24 CodeRabbit 指摘）:
// board は 127.0.0.1 限定・単一ユーザーで、xterm.js は通常同一マシン上で高速に
// 出力を消費するため、ws.send を無条件に続けても実害は薄い。ただし「ターミナル
// 内で大量出力を出す暴走プロセス＋描画停滞」が重なると ws の送信バッファが
// 際限なく膨らみうる。node-pty の flow control API（pause/resume）で pty 側の
// 出力そのものを止め、切断せずに操作継続性を保ったまま抑制する。
//
// 高水位: ws.bufferedAmount がこれを超えたら pty からの出力を一時停止する。
const HIGH_WATERMARK_BYTES = 1_048_576; // 1MB
// 低水位: 一時停止後、ここまでバッファが捌けたら再開する。高水位と同値にすると
// 再開直後に即座に再一時停止するハンチングが起きうるため、意図的に低い値にして
// ヒステリシスを持たせる。
const LOW_WATERMARK_BYTES = 262_144; // 256KB
// 一時停止中、ws.bufferedAmount が低水位を下回ったかを確認するポーリング間隔。
// pause 中は pty からの onData が止まる（＝低水位到達を検知する自然なトリガーが
// 無くなる）ため、pause している間だけこのタイマーを起動して監視する
// （通常時は常時ポーリングしない。YAGNI）。
const RESUME_CHECK_INTERVAL_MS = 200;

async function startTerminalSession(
  ws: WebSocket,
  entry: FleetEntry,
  kind: TerminalSessionKind,
  tmux: TmuxClient,
  spawnPty: SpawnTerminalPty,
  setIntervalFn: (handler: () => void, timeoutMs: number) => NodeJS.Timeout,
  clearIntervalFn: (handle: NodeJS.Timeout) => void,
): Promise<void> {
  const sessionName = terminalSessionName(entry.name, kind);
  // 【最重要・安全要件】(#57) shell 接続（手動コマンド操作用の独立セッション）では
  // prefill を構造的に無視する。「別セッションなら prefill が手動シェルに落ちない」
  // という設計の採用理由をサーバ側で保証するための唯一の分岐点であり、UI 側の
  // 配線が万一誤って shell 接続へ prefill を送っても、ここで確実に弾く。
  const allowPrefill = kind === "agent";

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
        if (!allowPrefill) {
          // shell 接続（kind=shell）は prefill メッセージを構造的に無視する
          // （安全要件。上記 allowPrefill のコメント参照）。
          break;
        }
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

  // pause 中かどうかの状態フラグ。pause/resume の呼び出しを冪等にし、
  // 高水位超過が続く間に pause() を多重発火させない・ポーリングタイマーを
  // 二重起動しないために使う。
  let paused = false;
  let resumeCheckTimer: NodeJS.Timeout | undefined;

  function clearResumeCheckTimer(): void {
    if (resumeCheckTimer !== undefined) {
      clearIntervalFn(resumeCheckTimer);
      resumeCheckTimer = undefined;
    }
  }

  function pausePty(): void {
    if (paused) {
      return;
    }
    paused = true;
    ptyProcess?.pause();
    resumeCheckTimer = setIntervalFn(() => {
      if (ws.bufferedAmount < LOW_WATERMARK_BYTES) {
        resumePty();
      }
    }, RESUME_CHECK_INTERVAL_MS);
    // board 停止（プロセス終了）をこのタイマーが妨げないようにする
    // （cache.ts の startStaleReevaluation と同様）。DI 注入されたテストダブルには
    // unref が無い可能性があるため、存在チェックしてから呼ぶ。
    const maybeUnref = (resumeCheckTimer as unknown as { unref?: () => void })
      .unref;
    if (typeof maybeUnref === "function") {
      maybeUnref.call(resumeCheckTimer);
    }
  }

  function resumePty(): void {
    if (!paused) {
      return;
    }
    paused = false;
    clearResumeCheckTimer();
    ptyProcess?.resume();
  }

  ptyProcess.onData((data) => {
    // 高水位チェックは ws が OPEN の場合のみ行う。非 OPEN（CLOSING/CLOSED）の
    // ソケットに対して pausePty() を呼んでも無意味な上、close/error のクリーン
    // アップと競合してタイマーが回収されない余地を生むため、send と同じガードに
    // 揃える。
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      if (ws.bufferedAmount > HIGH_WATERMARK_BYTES) {
        pausePty();
      }
    }
  });

  ptyProcess.onExit(() => {
    // pause 中に pty が終了した場合に備え、ここでもポーリング用タイマーを
    // 片付ける（close/error リスナの発火だけに頼らない防御的な後始末）。
    clearResumeCheckTimer();
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
  // 終了させることはそもそもできない）。あわせて、pause 中のポーリング用
  // タイマーが起動していれば必ず片付ける（タイマーリーク防止）。
  const cleanupOnDisconnect = () => {
    clearResumeCheckTimer();
    ptyProcess?.kill();
  };
  ws.on("close", cleanupOnDisconnect);
  ws.on("error", cleanupOnDisconnect);
}
