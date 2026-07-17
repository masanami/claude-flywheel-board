import { describe, expect, it, vi } from "vitest";
import { createTmuxClient, ensureTmuxSession, stripNewlines } from "./tmux.ts";

describe("stripNewlines", () => {
  it("改行 (\\n) を除去する", () => {
    expect(stripNewlines("git status\n")).toBe("git status ");
  });

  it("CRLF (\\r\\n) を除去する", () => {
    expect(stripNewlines("git status\r\n")).toBe("git status ");
  });

  it("改行が無ければ変化しない", () => {
    expect(stripNewlines("git status")).toBe("git status");
  });

  it("連続する改行はまとめて1個のスペースに置換する", () => {
    expect(stripNewlines("a\n\n\nb")).toBe("a b");
  });
});

describe("createTmuxClient", () => {
  it("hasSession は has-session コマンドの成功/失敗から真偽を返す", async () => {
    const runHasSessionCheck = vi.fn().mockResolvedValue(true);
    const tmux = createTmuxClient({ runHasSessionCheck });

    const result = await tmux.hasSession("flywheel-medical");

    expect(result).toBe(true);
    expect(runHasSessionCheck).toHaveBeenCalledWith("tmux", [
      "has-session",
      "-t",
      "flywheel-medical",
    ]);
  });

  it("hasSession はセッションが無ければ false を返す", async () => {
    const runHasSessionCheck = vi.fn().mockResolvedValue(false);
    const tmux = createTmuxClient({ runHasSessionCheck });

    expect(await tmux.hasSession("flywheel-medical")).toBe(false);
  });

  it("newSession は new-session -d -s <name> -c <cwd> を実行する", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const tmux = createTmuxClient({ runCommand });

    await tmux.newSession("flywheel-medical", "/repos/medical-agent");

    expect(runCommand).toHaveBeenCalledWith("tmux", [
      "new-session",
      "-d",
      "-s",
      "flywheel-medical",
      "-c",
      "/repos/medical-agent",
    ]);
  });

  it("sendKeysLiteral は send-keys -t <name> -l -- <command> を実行する（literal・改行なし・-- ガード付き）", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const tmux = createTmuxClient({ runCommand });

    await tmux.sendKeysLiteral("flywheel-medical", "git status");

    expect(runCommand).toHaveBeenCalledWith("tmux", [
      "send-keys",
      "-t",
      "flywheel-medical",
      "-l",
      "--",
      "git status",
    ]);
  });

  it("sendKeysLiteral は '-' 始まりの command でもフラグとして解釈されないよう -- を挟む", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const tmux = createTmuxClient({ runCommand });

    await tmux.sendKeysLiteral("flywheel-medical", "--help");

    expect(runCommand).toHaveBeenCalledWith("tmux", [
      "send-keys",
      "-t",
      "flywheel-medical",
      "-l",
      "--",
      "--help",
    ]);
  });

  it("sendKeysLiteral はコマンド文字列に改行が含まれていても除去してから送信する（Enter 相当のコードパスを作らない）", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const tmux = createTmuxClient({ runCommand });

    await tmux.sendKeysLiteral("flywheel-medical", "git status\n");

    const call = runCommand.mock.calls[0];
    expect(call?.[1]).not.toContain("Enter");
    expect(call?.[1]?.[5]).not.toMatch(/[\r\n]/);
    expect(call?.[1]).toEqual([
      "send-keys",
      "-t",
      "flywheel-medical",
      "-l",
      "--",
      "git status ",
    ]);
  });

  it("sendKeysLiteral が組み立てる引数配列は常に6要素（余分な Enter 引数を追加しない）", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const tmux = createTmuxClient({ runCommand });

    await tmux.sendKeysLiteral("flywheel-medical", "ls");

    expect(runCommand.mock.calls[0]?.[1]).toHaveLength(6);
  });
});

describe("ensureTmuxSession", () => {
  it("既にセッションがある場合は newSession を呼ばない", async () => {
    const tmux = {
      hasSession: vi.fn().mockResolvedValue(true),
      newSession: vi.fn().mockResolvedValue(undefined),
      sendKeysLiteral: vi.fn().mockResolvedValue(undefined),
    };

    await ensureTmuxSession(tmux, "flywheel-medical", "/repos/medical-agent");

    expect(tmux.newSession).not.toHaveBeenCalled();
  });

  it("セッションが無い場合は newSession を呼ぶ", async () => {
    const tmux = {
      hasSession: vi.fn().mockResolvedValue(false),
      newSession: vi.fn().mockResolvedValue(undefined),
      sendKeysLiteral: vi.fn().mockResolvedValue(undefined),
    };

    await ensureTmuxSession(tmux, "flywheel-medical", "/repos/medical-agent");

    expect(tmux.newSession).toHaveBeenCalledWith(
      "flywheel-medical",
      "/repos/medical-agent",
    );
  });
});
