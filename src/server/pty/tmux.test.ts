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

  it("newSession は escape-time を 0 に設定する set-option -g を実行する（Issue #45: 全画面UIで単独 Esc が既定 500ms 待たされる問題への対処。escape-time はサーバスコープのオプションのため -g を使う）", async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const tmux = createTmuxClient({ runCommand });

    await tmux.newSession("flywheel-medical", "/repos/medical-agent");

    expect(runCommand).toHaveBeenCalledWith("tmux", [
      "set-option",
      "-g",
      "escape-time",
      "0",
    ]);
  });

  it("newSession は new-session の後に escape-time の set-option を実行する（set-option -g はサーバの起動を前提とするため、先に new-session でサーバ・セッションを立ち上げてから呼ぶ）", async () => {
    const calls: string[][] = [];
    const runCommand = vi.fn().mockImplementation((_command, args) => {
      calls.push(args);
      return Promise.resolve(undefined);
    });
    const tmux = createTmuxClient({ runCommand });

    await tmux.newSession("flywheel-medical", "/repos/medical-agent");

    const newSessionIndex = calls.findIndex(
      (args) => args[0] === "new-session",
    );
    const setOptionIndex = calls.findIndex((args) => args[0] === "set-option");
    expect(newSessionIndex).toBeGreaterThanOrEqual(0);
    expect(setOptionIndex).toBeGreaterThan(newSessionIndex);
  });

  it("newSession は new-session が失敗した場合、set-option を実行せずにエラーを伝播する", async () => {
    const runCommand = vi.fn().mockImplementation((_command, args) => {
      if (args[0] === "new-session") {
        return Promise.reject(new Error("tmux binary not found"));
      }
      return Promise.resolve(undefined);
    });
    const tmux = createTmuxClient({ runCommand });

    await expect(
      tmux.newSession("flywheel-medical", "/repos/medical-agent"),
    ).rejects.toThrow("tmux binary not found");

    expect(runCommand).not.toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["set-option"]),
    );
  });

  it("newSession は set-option（escape-time 設定）が失敗しても、セッション自体は作成済みとして成功扱いにする（ベストエフォート。design-reviewer 指摘: set-option 失敗を ensureTmuxSession の重複セッション再確認ロジックに黙って握り潰させない）", async () => {
    const runCommand = vi.fn().mockImplementation((_command, args) => {
      if (args[0] === "set-option") {
        return Promise.reject(new Error("no server running"));
      }
      return Promise.resolve(undefined);
    });
    const tmux = createTmuxClient({ runCommand });

    await expect(
      tmux.newSession("flywheel-medical", "/repos/medical-agent"),
    ).resolves.toBeUndefined();

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

  it("newSession が失敗しても、再確認で既にセッションが存在すれば成功扱いにする（並行接続時の hasSession→newSession 競合吸収）", async () => {
    const tmux = {
      hasSession: vi
        .fn()
        .mockResolvedValueOnce(false) // 1回目: まだ無い → newSession を試みる
        .mockResolvedValueOnce(true), // newSession 失敗後の再確認: 先発の接続が作成済みだった
      newSession: vi
        .fn()
        .mockRejectedValue(new Error("duplicate session: flywheel-medical")),
      sendKeysLiteral: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      ensureTmuxSession(tmux, "flywheel-medical", "/repos/medical-agent"),
    ).resolves.toBeUndefined();

    // 「再確認だけ」で newSession を一切呼ばない実装でも hasSession の呼び出し
    // 回数だけを見れば通ってしまうため、newSession が実際に呼ばれ、かつ
    // （mockRejectedValue により）失敗した上で回復していることまで検証する。
    expect(tmux.newSession).toHaveBeenCalledTimes(1);
    expect(tmux.newSession).toHaveBeenCalledWith(
      "flywheel-medical",
      "/repos/medical-agent",
    );
    await expect(tmux.newSession.mock.results[0]?.value).rejects.toThrow(
      "duplicate session: flywheel-medical",
    );
    expect(tmux.hasSession).toHaveBeenCalledTimes(2);
  });

  it("newSession が失敗し、再確認でもセッションが存在しない場合は元のエラーを rethrow する", async () => {
    const originalError = new Error("tmux binary not found");
    const tmux = {
      hasSession: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false),
      newSession: vi.fn().mockRejectedValue(originalError),
      sendKeysLiteral: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      ensureTmuxSession(tmux, "flywheel-medical", "/repos/medical-agent"),
    ).rejects.toBe(originalError);
  });
});
