import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LogEntry } from "./journal.ts";
import {
  DEFAULT_STALE_MINUTES,
  deriveRunLogEntries,
  deriveRuns,
  logEntrySortKey,
  matchRuns,
  mergeLogEntries,
  parseRuns,
  resolveStaleMinutes,
} from "./runs.ts";

const fixture = (name: string) =>
  fileURLToPath(
    new URL(`../../../tests/fixtures/runs/${name}`, import.meta.url),
  );

describe("parseRuns", () => {
  it("正常な runs.jsonl を6イベント種別まとめて行数どおりにパースする", async () => {
    const { events, errors } = await parseRuns(fixture("valid.jsonl"));

    expect(errors).toEqual([]);
    expect(events).toHaveLength(6);
    expect(events.map((e) => e.event)).toEqual([
      "cycle_start",
      "delegate_start",
      "delegate_end",
      "cycle_end",
      "adhoc_start",
      "adhoc_end",
    ]);
  });

  it("cycle_start は cycle フィールドを保持する", async () => {
    const { events } = await parseRuns(fixture("valid.jsonl"));

    const cycleStart = events[0];
    expect(cycleStart).toMatchObject({
      event: "cycle_start",
      cycle: "2026-07-16-cycle",
    });
  });

  it("delegate_end は challenge/repo/session_id/result を保持する", async () => {
    const { events } = await parseRuns(fixture("valid.jsonl"));

    const delegateEnd = events[2];
    expect(delegateEnd).toMatchObject({
      event: "delegate_end",
      challenge: "C-044",
      repo: "net-config",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      result: "実装完了・PR起票（照合済み）",
    });
  });

  it("adhoc_start/end は challenge/repo が任意フィールドでも通る", async () => {
    const { events } = await parseRuns(fixture("valid.jsonl"));

    const adhocStart = events[4];
    const adhocEnd = events[5];
    expect(adhocStart).toMatchObject({
      event: "adhoc_start",
      id: "adhoc-20260716-1302-ci-failure",
      title: "CI 落ちの調査",
      repo: "net-config",
    });
    expect(adhocEnd).toMatchObject({
      event: "adhoc_end",
      id: "adhoc-20260716-1302-ci-failure",
      result: "修正PRを作成",
    });
  });

  it("壊れた行（JSON構文エラー・必須フィールド欠落・未知event）を ParseError として積みつつ、正常な行は失わずにパースする", async () => {
    const { events, errors } = await parseRuns(fixture("broken.jsonl"));

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event)).toEqual(["cycle_start", "cycle_end"]);

    expect(errors).toHaveLength(3);
    expect(errors[0]?.line).toBe(2);
    expect(errors[0]?.file).toBe(fixture("broken.jsonl"));
    expect(errors[0]?.message.length).toBeGreaterThan(0);

    expect(errors[1]?.line).toBe(4);
    expect(errors[1]?.raw).toContain("C-045");
    expect(errors[1]?.message.length).toBeGreaterThan(0);

    expect(errors[2]?.line).toBe(5);
    expect(errors[2]?.raw).toContain("unknown_event");
    expect(errors[2]?.message.length).toBeGreaterThan(0);
  });

  it("ts が Date.parse できない値は ParseError になる", async () => {
    const { events, errors } = await parseRuns(
      fixture("invalid-timestamp.jsonl"),
    );

    expect(events).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/ts/);
  });
});

describe("matchRuns", () => {
  it("cycle_start/end を cycle キーで対応付ける", async () => {
    const { events } = await parseRuns(fixture("valid.jsonl"));

    const matched = matchRuns(events);
    const cycle = matched.find((r) => r.kind === "cycle");

    expect(cycle).toMatchObject({
      kind: "cycle",
      key: "2026-07-16-cycle",
      startedAt: "2026-07-16T10:00:00+09:00",
      endedAt: "2026-07-16T10:45:00+09:00",
      result: "completed",
    });
  });

  it("delegate_start/end を session_id キーで対応付ける", async () => {
    const { events } = await parseRuns(fixture("valid.jsonl"));

    const matched = matchRuns(events);
    const delegate = matched.find((r) => r.kind === "delegate");

    expect(delegate).toMatchObject({
      kind: "delegate",
      key: "550e8400-e29b-41d4-a716-446655440000",
      challenge: "C-044",
      repo: "net-config",
      startedAt: "2026-07-16T10:05:12+09:00",
      endedAt: "2026-07-16T10:42:30+09:00",
      result: "実装完了・PR起票（照合済み）",
    });
  });

  it("adhoc_start/end を id キーで対応付け、title を保持する", async () => {
    const { events } = await parseRuns(fixture("valid.jsonl"));

    const matched = matchRuns(events);
    const adhoc = matched.find((r) => r.kind === "adhoc");

    expect(adhoc).toMatchObject({
      kind: "adhoc",
      key: "adhoc-20260716-1302-ci-failure",
      title: "CI 落ちの調査",
      repo: "net-config",
      startedAt: "2026-07-16T13:02:00+09:00",
      endedAt: "2026-07-16T13:40:00+09:00",
      result: "修正PRを作成",
    });
  });

  it("resume 規則: 別サイクルへ持ち越した同一 session_id の resume は、最新の未終了 start に end が対応付けられ、1回目の start は未終了のまま残る", async () => {
    const { events } = await parseRuns(fixture("resume.jsonl"));

    const matched = matchRuns(events);
    const delegates = matched.filter((r) => r.kind === "delegate");

    expect(delegates).toHaveLength(2);
    expect(delegates[0]?.startedAt).toBe("2026-07-16T10:05:00+09:00");
    expect(delegates[0]?.endedAt).toBeUndefined();
    expect(delegates[1]).toMatchObject({
      startedAt: "2026-07-17T09:01:00+09:00",
      endedAt: "2026-07-17T09:30:00+09:00",
      result: "実装完了・PR起票（照合済み）",
    });
  });

  it("未終了の adhoc_start は endedAt が undefined のまま残る", async () => {
    const { events } = await parseRuns(fixture("adhoc-unterminated.jsonl"));

    const matched = matchRuns(events);

    expect(matched).toHaveLength(1);
    expect(matched[0]?.kind).toBe("adhoc");
    expect(matched[0]?.endedAt).toBeUndefined();
  });

  it("cycle_end の result が abandoned でも result として保持する", async () => {
    const { events } = await parseRuns(fixture("abandoned.jsonl"));

    const matched = matchRuns(events);

    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({
      kind: "cycle",
      result: "abandoned",
      endedAt: "2026-07-16T10:45:00+09:00",
    });
  });

  it("対応する未終了 start が見つからない *_end イベントは無視する（新しい Run を作らない）", () => {
    const matched = matchRuns([
      {
        ts: "2026-07-16T10:00:00+09:00",
        event: "delegate_end",
        challenge: "C-999",
        repo: "net-config",
        session_id: "no-such-session",
        result: "unknown",
      },
    ]);

    expect(matched).toEqual([]);
  });
});

describe("deriveRuns", () => {
  it("endedAt がある Run は stale にならない（経過が長くても）", () => {
    const matched = [
      {
        kind: "delegate" as const,
        key: "s1",
        startedAt: "2026-07-16T10:00:00+09:00",
        endedAt: "2026-07-16T10:05:00+09:00",
      },
    ];

    const now = new Date("2026-07-16T15:00:00+09:00");
    const result = deriveRuns(matched, now, 30);

    expect(result[0]?.stale).toBe(false);
  });

  it("実行中（endedAt なし）かつ経過がしきい値以下なら stale=false", () => {
    const matched = [
      {
        kind: "delegate" as const,
        key: "s1",
        startedAt: "2026-07-16T10:00:00+09:00",
      },
    ];

    const now = new Date("2026-07-16T10:10:00+09:00"); // 10分経過
    const result = deriveRuns(matched, now, 30);

    expect(result[0]?.stale).toBe(false);
  });

  it("実行中（endedAt なし）かつ経過がしきい値超過なら stale=true", () => {
    const matched = [
      {
        kind: "delegate" as const,
        key: "s1",
        startedAt: "2026-07-16T10:00:00+09:00",
      },
    ];

    const now = new Date("2026-07-16T10:31:00+09:00"); // 31分経過
    const result = deriveRuns(matched, now, 30);

    expect(result[0]?.stale).toBe(true);
  });

  it("未終了の adhoc も stale 判定の対象になる", () => {
    const matched = [
      {
        kind: "adhoc" as const,
        key: "adhoc-1",
        title: "調査",
        startedAt: "2026-07-16T10:00:00+09:00",
      },
    ];

    const now = new Date("2026-07-16T10:31:00+09:00");
    const result = deriveRuns(matched, now, 30);

    expect(result[0]?.stale).toBe(true);
  });
});

describe("DEFAULT_STALE_MINUTES / resolveStaleMinutes", () => {
  const ENV_KEY = "FLYWHEEL_BOARD_STALE_MINUTES";
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  });

  it("デフォルトは30分", () => {
    expect(DEFAULT_STALE_MINUTES).toBe(30);
  });

  it("引数優先", () => {
    process.env[ENV_KEY] = "10";
    expect(resolveStaleMinutes(60)).toBe(60);
  });

  it("引数なし・環境変数ありなら環境変数を使う", () => {
    process.env[ENV_KEY] = "45";
    expect(resolveStaleMinutes()).toBe(45);
  });

  it("環境変数が不正な数値なら既定値にフォールバックする", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);
  });

  it("環境変数が0以下（0・負値・空文字）なら既定値にフォールバックする（しきい値0以下は実行中Runが即staleになってしまうため不正値扱い）", () => {
    process.env[ENV_KEY] = "0";
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);

    process.env[ENV_KEY] = "-5";
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);

    process.env[ENV_KEY] = "";
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);
  });

  it("引数・環境変数どちらもなければ既定値", () => {
    delete process.env[ENV_KEY];
    expect(resolveStaleMinutes()).toBe(DEFAULT_STALE_MINUTES);
  });
});

describe("deriveRunLogEntries", () => {
  it("delegate の start/end から source: runs の LogEntry を2件生成する", () => {
    const entries = deriveRunLogEntries([
      {
        kind: "delegate",
        key: "550e8400-e29b-41d4-a716-446655440000",
        challenge: "C-044",
        repo: "net-config",
        startedAt: "2026-07-16T10:05:12+09:00",
        endedAt: "2026-07-16T10:42:30+09:00",
        result: "実装完了・PR起票（照合済み）",
      },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.source).toBe("runs");
    expect(entries[0]?.ts).toBe("2026-07-16T10:05:12+09:00");
    expect(entries[0]?.text).toContain("C-044");
    expect(entries[0]?.text).toContain("net-config");
    expect(entries[1]?.ts).toBe("2026-07-16T10:42:30+09:00");
    expect(entries[1]?.text).toContain("実装完了・PR起票（照合済み）");
  });

  it("未終了の Run は start の1件のみ生成する", () => {
    const entries = deriveRunLogEntries([
      {
        kind: "adhoc",
        key: "adhoc-1",
        title: "CI 落ちの調査",
        startedAt: "2026-07-16T13:02:00+09:00",
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toContain("CI 落ちの調査");
  });
});

describe("logEntrySortKey", () => {
  it("日付のみ（journal 由来）は同日 00:00 として扱う", () => {
    const entry: LogEntry = { ts: "2026-07-16", source: "journal", text: "x" };

    expect(logEntrySortKey(entry)).toBe(Date.parse("2026-07-16T00:00:00.000Z"));
  });

  it("フル ISO（runs 由来）はそのまま Date.parse する", () => {
    const entry: LogEntry = {
      ts: "2026-07-16T10:05:12+09:00",
      source: "runs",
      text: "x",
    };

    expect(logEntrySortKey(entry)).toBe(
      Date.parse("2026-07-16T10:05:12+09:00"),
    );
  });
});

describe("mergeLogEntries", () => {
  it("journal と runs の LogEntry をソートキー順にマージする（同日内では journal が runs より先）", () => {
    const journalEntries: LogEntry[] = [
      { ts: "2026-07-16", source: "journal", text: "journal 側" },
    ];
    const runsEntries: LogEntry[] = [
      {
        ts: "2026-07-16T10:05:12+09:00",
        source: "runs",
        text: "runs 側",
      },
    ];

    const merged = mergeLogEntries(journalEntries, runsEntries);

    expect(merged.map((e) => e.text)).toEqual(["journal 側", "runs 側"]);
  });

  it("時系列が前後する複数リストを正しい順序にマージする", () => {
    const a: LogEntry[] = [
      { ts: "2026-07-17T00:00:00+09:00", source: "runs", text: "later" },
    ];
    const b: LogEntry[] = [
      { ts: "2026-07-16T00:00:00+09:00", source: "runs", text: "earlier" },
    ];

    expect(mergeLogEntries(a, b).map((e) => e.text)).toEqual([
      "earlier",
      "later",
    ]);
  });
});
