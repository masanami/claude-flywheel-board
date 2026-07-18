import { describe, expect, it } from "vitest";
import type { Run } from "../board-types.ts";
import {
  buildResumeCommand,
  findStaleDelegateRun,
  isResumableDelegateRun,
} from "./resume-command.ts";

describe("buildResumeCommand", () => {
  it("repo と session_id から cd + claude --resume コマンド文字列を組み立てる", () => {
    const command = buildResumeCommand("org/service-a", "session-123");

    expect(command).toBe(
      "cd .flywheel/repos/org/service-a && claude -p --resume session-123",
    );
  });
});

describe("findStaleDelegateRun", () => {
  function delegateRun(overrides: Partial<Run> = {}): Run {
    return {
      kind: "delegate",
      key: "session-1",
      challenge: "C-042",
      repo: "org/service-a",
      startedAt: "2026-07-16T09:00:00.000Z",
      stale: true,
      ...overrides,
    };
  }

  it("kind が delegate かつ stale かつ repo があり challenge が一致する run を返す", () => {
    const run = delegateRun();

    expect(findStaleDelegateRun([run], "C-042")).toBe(run);
  });

  it("runs が undefined の場合は undefined を返す", () => {
    expect(findStaleDelegateRun(undefined, "C-042")).toBeUndefined();
  });

  it("runs が空配列の場合は undefined を返す", () => {
    expect(findStaleDelegateRun([], "C-042")).toBeUndefined();
  });

  it("stale が false の run は対象外とする", () => {
    const run = delegateRun({ stale: false });

    expect(findStaleDelegateRun([run], "C-042")).toBeUndefined();
  });

  it("kind が delegate 以外（adhoc）の run は対象外とする", () => {
    const run: Run = {
      kind: "adhoc",
      key: "adhoc-1",
      title: "差し込み対応",
      challenge: "C-042",
      repo: "org/service-a",
      startedAt: "2026-07-16T09:00:00.000Z",
      stale: true,
    };

    expect(findStaleDelegateRun([run], "C-042")).toBeUndefined();
  });

  it("challenge が一致しない run は対象外とする", () => {
    const run = delegateRun({ challenge: "C-999" });

    expect(findStaleDelegateRun([run], "C-042")).toBeUndefined();
  });

  it("repo が欠落（undefined）している run は対象外とする", () => {
    const run = delegateRun({ repo: undefined });

    expect(findStaleDelegateRun([run], "C-042")).toBeUndefined();
  });

  it("複数 run がある場合、条件を満たす最初の run を返す", () => {
    const first = delegateRun({ key: "session-1" });
    const second = delegateRun({ key: "session-2" });

    expect(findStaleDelegateRun([first, second], "C-042")).toBe(first);
  });
});

describe("isResumableDelegateRun", () => {
  function delegateRun(overrides: Partial<Run> = {}): Run {
    return {
      kind: "delegate",
      key: "session-1",
      challenge: "C-042",
      repo: "org/service-a",
      startedAt: "2026-07-16T09:00:00.000Z",
      stale: true,
      ...overrides,
    };
  }

  it("kind が delegate かつ stale かつ repo がある場合 true を返す", () => {
    expect(isResumableDelegateRun(delegateRun())).toBe(true);
  });

  it("stale が false の場合 false を返す", () => {
    expect(isResumableDelegateRun(delegateRun({ stale: false }))).toBe(false);
  });

  it("repo が欠落している場合 false を返す", () => {
    expect(isResumableDelegateRun(delegateRun({ repo: undefined }))).toBe(
      false,
    );
  });

  it("kind が delegate 以外（adhoc）の場合 false を返す", () => {
    const run: Run = {
      kind: "adhoc",
      key: "adhoc-1",
      title: "差し込み対応",
      repo: "org/service-a",
      startedAt: "2026-07-16T09:00:00.000Z",
      stale: true,
    };

    expect(isResumableDelegateRun(run)).toBe(false);
  });

  it("repo が安全な文字集合を外れる場合（シェルメタ文字混入）は false を返す（怪しいものは提示しない防御）", () => {
    expect(
      isResumableDelegateRun(delegateRun({ repo: "org/service-a; rm -rf /" })),
    ).toBe(false);
  });

  it("repo にバッククォート・ドル記号・パイプ等のシェルインジェクション文字が含まれる場合は false を返す", () => {
    expect(isResumableDelegateRun(delegateRun({ repo: "`whoami`" }))).toBe(
      false,
    );
    expect(isResumableDelegateRun(delegateRun({ repo: "$(whoami)" }))).toBe(
      false,
    );
    expect(isResumableDelegateRun(delegateRun({ repo: "a|b" }))).toBe(false);
  });

  it("sessionId（run.key）が安全な文字集合を外れる場合は false を返す", () => {
    expect(
      isResumableDelegateRun(delegateRun({ key: "session-1 && curl evil" })),
    ).toBe(false);
  });

  it("repo に .. のパス区切りセグメントが含まれる場合（パストラバーサル）は false を返す（セルフレビュー指摘対応: 文字集合だけでは cd 先が委譲先クローン配下から抜けられてしまう懸念への対応）", () => {
    expect(
      isResumableDelegateRun(delegateRun({ repo: "../../../../etc/passwd" })),
    ).toBe(false);
    expect(
      isResumableDelegateRun(delegateRun({ repo: "org/../../escape" })),
    ).toBe(false);
  });

  it("sessionId（run.key）が先頭ハイフンの場合は false を返す（セルフレビュー指摘対応: claude -p --resume <key> に展開された際、<key> がオプションフラグとして誤解釈されるのを防ぐ）", () => {
    expect(isResumableDelegateRun(delegateRun({ key: "-x" }))).toBe(false);
    expect(
      isResumableDelegateRun(delegateRun({ key: "--dangerous-flag" })),
    ).toBe(false);
  });

  it("org/repo 形式のスラッシュ区切り repo は引き続き true を返す（正当な値の後方互換）", () => {
    expect(isResumableDelegateRun(delegateRun({ repo: "org/service-a" }))).toBe(
      true,
    );
  });

  it("UUID 形式の session_id は引き続き true を返す（正当な値の後方互換）", () => {
    expect(
      isResumableDelegateRun(
        delegateRun({ key: "550e8400-e29b-41d4-a716-446655440000" }),
      ),
    ).toBe(true);
  });
});
