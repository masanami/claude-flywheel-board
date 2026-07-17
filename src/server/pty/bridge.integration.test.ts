import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FleetEntry } from "../manifest.ts";
import { createTerminalWebSocketServer } from "./bridge.ts";

// 実 tmux / 実 node-pty を使った結合テスト。worktree 環境に tmux があれば実行し、
// 無ければスキップする（テスト方針: 「実施できない場合はスキップしてよい」）。
function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function killTmuxSession(sessionName: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("tmux", ["kill-session", "-t", sessionName], () => {
      // セッションが既に無い場合もエラーになるが、クリーンアップなので握り潰す。
      resolve();
    });
  });
}

function tmuxSessionExists(sessionName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tmux", ["has-session", "-t", sessionName], (error) => {
      resolve(!error);
    });
  });
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 100 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitUntil: タイムアウトしました（${timeoutMs}ms）`);
}

const describeIfTmux = hasTmux() ? describe : describe.skip;

describeIfTmux("pty ブリッジ 実 tmux 結合テスト", () => {
  let server: ReturnType<typeof serve> | undefined;
  let sessionName: string | undefined;

  afterEach(async () => {
    server?.close();
    server = undefined;
    if (sessionName) {
      await killTmuxSession(sessionName);
      sessionName = undefined;
    }
  });

  it("tmux セッションを新規作成し、pty 経由で入出力でき、WS 切断後もセッションは残る", async () => {
    const agentName = `pty-bridge-it-${randomUUID().slice(0, 8)}`;
    sessionName = `flywheel-${agentName}`;
    const fleetEntries: FleetEntry[] = [{ name: agentName, path: os.tmpdir() }];

    const bridge = createTerminalWebSocketServer({
      getFleetEntries: () => fleetEntries,
    });

    await new Promise<void>((resolve, reject) => {
      server = serve(
        {
          fetch: () => new Response("not found", { status: 404 }),
          hostname: "127.0.0.1",
          port: 0,
        },
        () => resolve(),
      );
      server.on("error", reject);
    });
    if (!server) throw new Error("server が起動していない");
    server.on("upgrade", (request, socket, head) => {
      bridge.handleUpgrade(request, socket, head);
    });

    const address = server.address() as AddressInfo;
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws/terminal?agent=${agentName}`,
      { headers: { origin: "http://localhost:5173" } },
    );

    let received = "";
    ws.on("message", (data) => {
      received += data.toString();
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // tmux セッションが実際に作成されていることを確認する。
    await waitUntil(() => tmuxSessionExists(sessionName ?? ""));

    // 通常のキー入力としてコマンド＋改行を送る（プリフィルではなく input。
    // シェルへの通常のタイピングを模しており、プリフィル API とは別経路）。
    //
    // 検証値は「コマンド文字列そのもの」ではなく「実行結果でしか現れない値」を
    // 使う（マーカー文字列 + 算術式の計算結果を分割して組み立てる）。tmux は
    // 送信したキー入力をそのまま画面にエコーするため、コマンド文字列自体を
    // 待ち受けると、実際にはコマンドが実行されず入力が画面に表示されただけでも
    // 誤って成功と判定してしまう（$((6*7)) は echo コマンドが実際に評価・展開
    // しない限り "42" という文字列には絶対にならないため、実行結果の検証になる）。
    ws.send(
      JSON.stringify({
        type: "input",
        data: "echo PTY_BRIDGE_IT_MARKER=$((6*7))\n",
      }),
    );

    await waitUntil(() => received.includes("PTY_BRIDGE_IT_MARKER=42"), {
      timeoutMs: 8000,
    });

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // WS 切断後も tmux セッションは残っている（pty だけが kill される）。
    expect(await tmuxSessionExists(sessionName)).toBe(true);
  }, 15000);
});
