import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import { serve } from "@hono/node-server";
import xtermHeadlessPkg from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FleetEntry } from "../manifest.ts";
import { createTerminalWebSocketServer } from "./bridge.ts";

const { Terminal: HeadlessTerminal } = xtermHeadlessPkg;

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

function capturePane(sessionName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "tmux",
      ["capture-pane", "-t", sessionName, "-p"],
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
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

  // #27 症状1（attach 直後のターミナル1行目の文字化けノイズ）の回帰固定テスト。
  //
  // 実ブラウザの xterm.js は tmux の初期問い合わせ（Primary/Secondary Device
  // Attributes 等）に自動応答し、その応答は本番コードの実際の配線（xterm の
  // onData → socket.sendInput → WS "input" メッセージ）を経由して、他の
  // ユーザー入力と区別なく pty へ書き込まれる（bridge.ts の processRawMessage
  // は input メッセージの由来を判別しない）。@xterm/headless は canvas 描画を
  // 除く xterm.js のコア（DA/DSR 応答を含むパーサ）を共有するため、実ブラウザの
  // この自動応答挙動を Node 上で忠実に再現できる。ただし headless は
  // `terminal.open(container)` を使えない（DOM 前提）ため、TerminalPane.tsx /
  // xterm-adapter.ts の onData→sendInput / message→write の配線をこのテスト内で
  // 個別に複製している（xterm-adapter.ts 自体は import していない）。
  // TerminalPane.tsx 側の配線を変更した場合、このテストは自動追随しない点に注意
  // （複製箇所の手動更新が必要）。
  //
  // このテストは「意図的に送っていない入力（xterm 自身の自動応答）由来の文字が
  // pane に現れないこと」を固定する。現状は tmux 側がこれらの応答を tty
  // ネゴシエーションとして正しく消費しており pane には現れないが、
  // pre-ready キューや処理順序に手を入れた際の回帰を検知するガードとする。
  it("attach 直後、xterm.js の自動応答（DA1/DA2 等）由来の文字が pane に現れない", async () => {
    const agentName = `pty-bridge-noise-it-${randomUUID().slice(0, 8)}`;
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

    // TerminalPane.tsx / xterm-adapter.ts の配線（pty 出力を xterm へ write し、
    // xterm の onData を "input" として WS 送信する）を、headless 版で複製する。
    // 実ブラウザなら DA/DSR 自動応答もこの onData を通って input 送信される。
    const term = new HeadlessTerminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
    });
    const autoRepliesSent: string[] = [];
    term.onData((data: string) => {
      autoRepliesSent.push(data);
      ws.send(JSON.stringify({ type: "input", data }));
    });
    ws.on("message", (data) => {
      term.write(data.toString());
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));

    await waitUntil(() => tmuxSessionExists(sessionName ?? ""));

    // attach 直後の画面（プロンプト行・自動応答の反映）が安定するまで待つ。
    // 固定 sleep ではなく、「連続2回の capture-pane が同一内容」になるまで
    // ポーリングすることで、環境差によるタイミング揺らぎを吸収する。
    let pane = "";
    await waitUntil(
      async () => {
        const first = await capturePane(sessionName ?? "");
        if (first.trim().length === 0) {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        const second = await capturePane(sessionName ?? "");
        if (first !== second) {
          return false;
        }
        pane = second;
        return true;
      },
      { timeoutMs: 8000 },
    );

    // 前提の確認（正の主張）: xterm.js（headless）が実際に DA1 自動応答を
    // onData 経由で送信していること。ここが発火しなければ、このテストは
    // 検証すべき経路（自動応答→pty書き込み）を一度も通らずに緑になる
    // （否定アサーションのみでは配線切れの回帰を検出できないため）。
    expect(autoRepliesSent.some((data) => data.includes("[?1;2c"))).toBe(true);

    // DA1 (`ESC[?1;2c`) / DA2 (`ESC[>0;276;0c`) の自動応答が、意図せず
    // シェルへの入力として pane 上に literal 文字として現れていないこと。
    expect(pane).not.toMatch(/\?1;2c/);
    expect(pane).not.toMatch(/>0;276;0c/);
    expect(pane).not.toMatch(/\d;276;\d/);

    // pty 自体は健全なまま（自動応答の書き込みで壊れていない）ことを、
    // 実際にコマンドを実行させて確認する。
    let received = "";
    ws.on("message", (data) => {
      received += data.toString();
    });
    ws.send(
      JSON.stringify({
        type: "input",
        data: "echo PTY_BRIDGE_NOISE_IT_MARKER=$((6*7))\n",
      }),
    );
    await waitUntil(() => received.includes("PTY_BRIDGE_NOISE_IT_MARKER=42"), {
      timeoutMs: 8000,
    });

    ws.close();
  }, 15000);
});
