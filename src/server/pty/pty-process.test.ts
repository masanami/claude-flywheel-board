import { describe, expect, it } from "vitest";
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
});
