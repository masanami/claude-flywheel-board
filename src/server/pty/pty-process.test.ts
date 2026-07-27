import * as nodePty from "node-pty";
import { describe, expect, it, vi } from "vitest";
import { spawnPtyProcess } from "./pty-process.ts";

// node-pty 自体は Mock せず、tmux に依存しない軽量な実プロセス（/bin/echo）を
// spawn して、PtyProcess インタフェースへの変換（onData/onExit/write/resize/kill）
// が正しく配線されていることを検証する。tmux 依存の結合テストは
// bridge.integration.test.ts 側で行う。

function waitForExit(
  ptyProcess: ReturnType<typeof spawnPtyProcess>,
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    ptyProcess.onExit((event) => resolve(event));
  });
}

describe("spawnPtyProcess", () => {
  it("プロセスの標準出力を onData で受け取れる", async () => {
    const ptyProcess = spawnPtyProcess("/bin/echo", ["hello-pty"], {
      cwd: process.cwd(),
    });

    let received = "";
    ptyProcess.onData((data) => {
      received += data;
    });
    await waitForExit(ptyProcess);

    expect(received).toContain("hello-pty");
  });

  it("プロセス終了時に onExit が呼ばれる", async () => {
    const ptyProcess = spawnPtyProcess("/bin/echo", ["exit-test"], {
      cwd: process.cwd(),
    });

    const event = await waitForExit(ptyProcess);

    expect(event.exitCode).toBe(0);
  });

  it("resize / write / kill が例外を投げずに呼び出せる", async () => {
    const ptyProcess = spawnPtyProcess("/bin/cat", [], {
      cwd: process.cwd(),
    });

    expect(() => ptyProcess.resize(100, 30)).not.toThrow();
    expect(() => ptyProcess.write("hello\n")).not.toThrow();
    expect(() => ptyProcess.kill()).not.toThrow();
  });

  it("pause / resume が例外を投げずに呼び出せる（バックプレッシャー制御。Issue #26）", async () => {
    const ptyProcess = spawnPtyProcess("/bin/cat", [], {
      cwd: process.cwd(),
    });

    // アサーション失敗時にも /bin/cat を残さないよう、kill は finally で保証する
    try {
      expect(() => ptyProcess.pause()).not.toThrow();
      expect(() => ptyProcess.resume()).not.toThrow();
    } finally {
      ptyProcess.kill();
    }
  });

  it("TERM を xterm-256color として宣言する（Issue #71: xterm-color=8色宣言だと tmux が256色のAI補完候補ゴーストテキストを8色に丸めて通常文字と同色に潰してしまう回帰防止）", async () => {
    const spawnSpy = vi.spyOn(nodePty, "spawn");
    const ptyProcess = spawnPtyProcess("/bin/cat", [], {
      cwd: process.cwd(),
    });
    const exited = waitForExit(ptyProcess);

    try {
      expect(spawnSpy).toHaveBeenCalledWith(
        "/bin/cat",
        [],
        expect.objectContaining({ name: "xterm-256color" }),
      );
    } finally {
      ptyProcess.kill();
      await exited;
      spawnSpy.mockRestore();
    }
  });
});
