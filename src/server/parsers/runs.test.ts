import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LogEntry } from "./journal.ts";
import {
  DEFAULT_STALE_MINUTES,
  deriveCycleLastActivityAt,
  deriveCycleStatus,
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

  it("ファイルが存在しない（ENOENT）場合はエラーを投げず、events/errors ともに空を返す（runs.jsonl は遅延生成のため未稼働エージェントの正常状態）", async () => {
    const { events, errors } = await parseRuns(fixture("does-not-exist.jsonl"));

    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("ENOENT 以外の読み込みエラー（例: ディレクトリをファイルとして開こうとした EISDIR）はそのまま例外を投げる（scanAgent 側で ParseError 化される契約を維持する）", async () => {
    // fixtures/runs 自体はディレクトリなので、ファイルとして readFile すると EISDIR になる。
    await expect(
      parseRuns(
        fileURLToPath(new URL("../../../tests/fixtures/runs", import.meta.url)),
      ),
    ).rejects.toThrow();
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

  it("resume 規則: 別サイクルへ持ち越した同一 session_id の resume は、最新の未終了 start に end が対応付けられ、1回目の start は superseded: true のまま残る（合成 endedAt は作らない）", async () => {
    const { events } = await parseRuns(fixture("resume.jsonl"));

    const matched = matchRuns(events);
    const delegates = matched.filter((r) => r.kind === "delegate");

    expect(delegates).toHaveLength(2);
    expect(delegates[0]?.startedAt).toBe("2026-07-16T10:05:00+09:00");
    expect(delegates[0]?.endedAt).toBeUndefined();
    expect(delegates[0]?.superseded).toBe(true);
    expect(delegates[1]).toMatchObject({
      startedAt: "2026-07-17T09:01:00+09:00",
      endedAt: "2026-07-17T09:30:00+09:00",
      result: "実装完了・PR起票（照合済み）",
    });
    expect(delegates[1]?.superseded).toBeFalsy();
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

  it("同一 session_id の新しい delegate_start が来ると、既存の未終了 start は superseded: true になる（合成 endedAt は作らない）", () => {
    const matched = matchRuns([
      {
        ts: "2026-07-16T10:00:00+09:00",
        event: "delegate_start",
        challenge: "C-044",
        repo: "net-config",
        session_id: "s1",
      },
      {
        ts: "2026-07-17T09:00:00+09:00",
        event: "delegate_start",
        challenge: "C-044",
        repo: "net-config",
        session_id: "s1",
      },
    ]);

    expect(matched).toHaveLength(2);
    expect(matched[0]?.superseded).toBe(true);
    expect(matched[0]?.endedAt).toBeUndefined();
    expect(matched[1]?.superseded).toBeFalsy();
    expect(matched[1]?.endedAt).toBeUndefined();
  });

  it("cycle kind でも同一 key の新しい start により既存の未終了 start が superseded になる（一般化の確認）", () => {
    const matched = matchRuns([
      {
        ts: "2026-07-16T10:00:00+09:00",
        event: "cycle_start",
        cycle: "same-cycle-name",
      },
      {
        ts: "2026-07-16T11:00:00+09:00",
        event: "cycle_start",
        cycle: "same-cycle-name",
      },
    ]);

    expect(matched).toHaveLength(2);
    expect(matched[0]?.superseded).toBe(true);
    expect(matched[0]?.endedAt).toBeUndefined();
    expect(matched[1]?.superseded).toBeFalsy();
  });

  it("start→resume start→end の並びでは、end は最新（2件目）の start にのみ対応付けられ、1件目は superseded のまま endedAt を持たない", () => {
    const matched = matchRuns([
      {
        ts: "2026-07-16T10:00:00+09:00",
        event: "delegate_start",
        challenge: "C-044",
        repo: "net-config",
        session_id: "s1",
      },
      {
        ts: "2026-07-17T09:00:00+09:00",
        event: "delegate_start",
        challenge: "C-044",
        repo: "net-config",
        session_id: "s1",
      },
      {
        ts: "2026-07-17T09:30:00+09:00",
        event: "delegate_end",
        challenge: "C-044",
        repo: "net-config",
        session_id: "s1",
        result: "完了",
      },
    ]);

    expect(matched).toHaveLength(2);
    expect(matched[0]?.superseded).toBe(true);
    expect(matched[0]?.endedAt).toBeUndefined();
    expect(matched[1]?.superseded).toBeFalsy();
    expect(matched[1]?.endedAt).toBe("2026-07-17T09:30:00+09:00");
    expect(matched[1]?.result).toBe("完了");
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

describe("matchRuns の provenance 付与", () => {
  it("delegate_start に file/raw を持つイベントから、RunProvenance（file/event/ts/key/raw/hasEnd:false）が組み立てられる", () => {
    const raw =
      '{"ts":"2026-07-16T10:05:12+09:00","event":"delegate_start","challenge":"C-044","repo":"net-config","session_id":"550e8400-e29b-41d4-a716-446655440000"}';
    const matched = matchRuns([
      {
        ts: "2026-07-16T10:05:12+09:00",
        event: "delegate_start",
        challenge: "C-044",
        repo: "net-config",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        file: ".flywheel/runs.jsonl",
        raw,
      },
    ]);
    const delegate = matched.find((r) => r.kind === "delegate");

    expect(delegate?.provenance).toEqual({
      file: ".flywheel/runs.jsonl",
      event: "delegate_start",
      ts: "2026-07-16T10:05:12+09:00",
      key: "550e8400-e29b-41d4-a716-446655440000",
      raw,
      hasEnd: false,
    });
  });

  it("resume（同一 session_id の再委譲）: superseded になった旧 start の provenance は raw・hasEnd:false のまま残り、新しい start にのみ hasEnd:true が付く（未終了 start の偽陽性診断という機能の動機に直結するケース）", async () => {
    const { events } = await parseRuns(fixture("resume.jsonl"));

    const matched = matchRuns(events);
    const delegates = matched.filter((r) => r.kind === "delegate");

    expect(delegates).toHaveLength(2);
    // 1回目の start（superseded: true・cycle1 で abandoned になった後、end と対応付かない）
    expect(delegates[0]?.superseded).toBe(true);
    expect(delegates[0]?.provenance).toMatchObject({
      event: "delegate_start",
      ts: "2026-07-16T10:05:00+09:00",
      hasEnd: false,
    });
    // 2回目の start（resume。delegate_end と対応付き hasEnd:true になる）
    expect(delegates[1]?.superseded).toBeFalsy();
    expect(delegates[1]?.provenance).toMatchObject({
      event: "delegate_start",
      ts: "2026-07-17T09:01:00+09:00",
      hasEnd: true,
    });
    // 2つの provenance.raw は互いに異なる行（1回目/2回目それぞれの実際の生行）を保持する。
    expect(delegates[0]?.provenance?.raw).not.toBe(
      delegates[1]?.provenance?.raw,
    );
    expect(delegates[0]?.provenance?.raw).toContain(
      "2026-07-16T10:05:00+09:00",
    );
    expect(delegates[1]?.provenance?.raw).toContain(
      "2026-07-17T09:01:00+09:00",
    );
  });

  it("parseRuns の第2引数 provenanceFile を渡すと、provenance.file に読み取りパスではなくその値が使われる（repo ルートからの相対パスを表示用に渡すユースケース）", async () => {
    const { events } = await parseRuns(
      fixture("valid.jsonl"),
      ".flywheel/runs.jsonl",
    );

    const matched = matchRuns(events);
    const delegate = matched.find((r) => r.kind === "delegate");

    expect(delegate?.provenance?.file).toBe(".flywheel/runs.jsonl");
  });

  it("parseRuns の provenanceFile を省略すると、provenance.file には読み取りに使った filePath がそのまま入る（後方互換の既定動作）", async () => {
    const filePath = fixture("valid.jsonl");
    const { events } = await parseRuns(filePath);

    const matched = matchRuns(events);
    const delegate = matched.find((r) => r.kind === "delegate");

    expect(delegate?.provenance?.file).toBe(filePath);
  });

  it("対応する delegate_end が来ると provenance.hasEnd が true に更新される", () => {
    const matched = matchRuns([
      {
        ts: "2026-07-16T10:00:00+09:00",
        event: "delegate_start",
        challenge: "C-044",
        repo: "net-config",
        session_id: "s1",
        file: ".flywheel/runs.jsonl",
        raw: '{"ts":"2026-07-16T10:00:00+09:00","event":"delegate_start","challenge":"C-044","repo":"net-config","session_id":"s1"}',
      },
      {
        ts: "2026-07-16T10:30:00+09:00",
        event: "delegate_end",
        challenge: "C-044",
        repo: "net-config",
        session_id: "s1",
        result: "完了",
      },
    ]);

    expect(matched[0]?.provenance?.hasEnd).toBe(true);
  });

  it("adhoc_start にも同様に provenance が付き、対応する adhoc_end で hasEnd が true になる", () => {
    const matched = matchRuns([
      {
        ts: "2026-07-16T13:02:00+09:00",
        event: "adhoc_start",
        id: "adhoc-1",
        title: "調査",
        file: ".flywheel/runs.jsonl",
        raw: '{"ts":"2026-07-16T13:02:00+09:00","event":"adhoc_start","id":"adhoc-1","title":"調査"}',
      },
    ]);

    expect(matched[0]?.provenance).toEqual({
      file: ".flywheel/runs.jsonl",
      event: "adhoc_start",
      ts: "2026-07-16T13:02:00+09:00",
      key: "adhoc-1",
      raw: '{"ts":"2026-07-16T13:02:00+09:00","event":"adhoc_start","id":"adhoc-1","title":"調査"}',
      hasEnd: false,
    });

    const closed = matchRuns([
      {
        ts: "2026-07-16T13:02:00+09:00",
        event: "adhoc_start",
        id: "adhoc-1",
        title: "調査",
        file: ".flywheel/runs.jsonl",
        raw: '{"ts":"2026-07-16T13:02:00+09:00","event":"adhoc_start","id":"adhoc-1","title":"調査"}',
      },
      {
        ts: "2026-07-16T13:40:00+09:00",
        event: "adhoc_end",
        id: "adhoc-1",
        result: "解決",
      },
    ]);

    expect(closed[0]?.provenance?.hasEnd).toBe(true);
  });

  it("cycle_start/end からは provenance が付かない（kind: cycle は常に undefined）", () => {
    const matched = matchRuns([
      {
        ts: "2026-07-16T10:00:00+09:00",
        event: "cycle_start",
        cycle: "cycle1",
        file: ".flywheel/runs.jsonl",
        raw: '{"ts":"2026-07-16T10:00:00+09:00","event":"cycle_start","cycle":"cycle1"}',
      },
      {
        ts: "2026-07-16T10:45:00+09:00",
        event: "cycle_end",
        cycle: "cycle1",
        result: "completed",
      },
    ]);

    expect(matched[0]?.kind).toBe("cycle");
    expect(matched[0]?.provenance).toBeUndefined();
  });

  it("file/raw を持たない手動構築の RunEvent（既存テスト形式・後方互換）では provenance が undefined のまま", () => {
    const matched = matchRuns([
      {
        ts: "2026-07-16T10:00:00+09:00",
        event: "delegate_start",
        challenge: "C-044",
        repo: "net-config",
        session_id: "s1",
      },
    ]);

    expect(matched[0]?.provenance).toBeUndefined();
  });

  it("parseRuns が返す events は file・raw が実際のフィクスチャの行と一致する（raw はパース時に読み取った生JSON1行そのまま）", async () => {
    const filePath = fixture("valid.jsonl");
    const { events } = await parseRuns(filePath);

    const delegateStart = events[1] as (typeof events)[number];
    expect(delegateStart.event).toBe("delegate_start");
    expect(delegateStart.file).toBe(filePath);
    expect(delegateStart.raw).toBe(
      '{"ts":"2026-07-16T10:05:12+09:00","event":"delegate_start","challenge":"C-044","repo":"net-config","session_id":"550e8400-e29b-41d4-a716-446655440000"}',
    );
    expect(JSON.parse(delegateStart.raw ?? "")).toMatchObject({
      event: "delegate_start",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
    });

    const matched = matchRuns(events);
    const delegate = matched.find((r) => r.kind === "delegate");
    expect(delegate?.provenance?.raw).toBe(delegateStart.raw);
    expect(delegate?.provenance?.file).toBe(filePath);
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

  describe("cycle の stale 判定は最終活動（heartbeat）起点（Issue #154）", () => {
    it("開始からしきい値を大きく超えていても、しきい値内に delegate イベントがあれば cycle は stale にならない", async () => {
      // 実データ由来のフィクスチャ（rupert 2026-08-18: 07:36 cycle_start →
      // 07:44/08:20 で委譲1件完了 → 08:32 から次の委譲が進行中）。
      const { events } = await parseRuns(
        fixture("long-cycle-with-activity.jsonl"),
      );
      const matched = matchRuns(events);

      // cycle 開始から 82 分経過（従来の実装なら stale）だが、最終活動
      // （08:32 の delegate_start）からは 26 分しか経っていない。
      const now = new Date("2026-08-18T08:58:00+09:00");
      const result = deriveRuns(matched, now, 30);

      const cycle = result.find((run) => run.kind === "cycle");
      expect(cycle?.stale).toBe(false);
      expect(cycle?.lastActivityAt).toBe("2026-08-18T08:32:00+09:00");
      expect(deriveCycleStatus(result)).toBe("running");
    });

    it("最終活動からしきい値を超え、実行中の delegate/adhoc も無ければ cycle は stale になる", () => {
      const matched = matchRuns([
        {
          ts: "2026-08-18T07:36:00+09:00",
          event: "cycle_start" as const,
          cycle: "2026-08-18-cycle",
        },
        {
          ts: "2026-08-18T07:44:00+09:00",
          event: "delegate_start" as const,
          challenge: "C-029",
          repo: "board",
          session_id: "s1",
        },
        {
          ts: "2026-08-18T08:20:00+09:00",
          event: "delegate_end" as const,
          challenge: "C-029",
          repo: "board",
          session_id: "s1",
          result: "完了",
        },
      ]);

      // 最終活動（08:20 の delegate_end）から 31 分経過・実行中の子は無い。
      const now = new Date("2026-08-18T08:51:00+09:00");
      const result = deriveRuns(matched, now, 30);

      const cycle = result.find((run) => run.kind === "cycle");
      expect(cycle?.stale).toBe(true);
      expect(cycle?.lastActivityAt).toBe("2026-08-18T08:20:00+09:00");
      expect(deriveCycleStatus(result)).toBe("stale");
    });

    it("イベントが cycle_start だけなら従来どおり開始からの経過で stale になる", () => {
      const matched = matchRuns([
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "cycle_start" as const,
          cycle: "2026-07-16-cycle",
        },
      ]);

      const result = deriveRuns(
        matched,
        new Date("2026-07-16T10:31:00+09:00"),
        30,
      );

      expect(result[0]?.stale).toBe(true);
      expect(result[0]?.lastActivityAt).toBe("2026-07-16T10:00:00+09:00");
    });

    it("実行中の delegate が非 stale の間は cycle も stale にならない（heartbeat は delegate 開始以降にあるため）", () => {
      const matched = matchRuns([
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "cycle_start" as const,
          cycle: "2026-07-16-cycle",
        },
        {
          ts: "2026-07-16T10:25:00+09:00",
          event: "delegate_start" as const,
          challenge: "C-044",
          repo: "net-config",
          session_id: "s1",
        },
      ]);

      // cycle 開始からは 35 分（しきい値 10 分を大きく超過）だが、最終活動
      // （10:25 の delegate_start）からはちょうど 10 分でしきい値以下。
      const result = deriveRuns(
        matched,
        new Date("2026-07-16T10:35:00+09:00"),
        10,
      );

      expect(result.find((run) => run.kind === "delegate")?.stale).toBe(false);
      expect(result.find((run) => run.kind === "cycle")?.stale).toBe(false);
    });

    it("実行中の delegate が stale になると cycle も stale になる（活動が途絶えた状態）", () => {
      const matched = matchRuns([
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "cycle_start" as const,
          cycle: "2026-07-16-cycle",
        },
        {
          ts: "2026-07-16T10:25:00+09:00",
          event: "delegate_start" as const,
          challenge: "C-044",
          repo: "net-config",
          session_id: "s1",
        },
      ]);

      const result = deriveRuns(
        matched,
        new Date("2026-07-16T10:36:00+09:00"),
        10,
      );

      expect(result.find((run) => run.kind === "delegate")?.stale).toBe(true);
      expect(result.find((run) => run.kind === "cycle")?.stale).toBe(true);
    });

    it("cycle 開始より前のイベントは最終活動に数えない", () => {
      const matched = matchRuns([
        {
          ts: "2026-07-16T09:00:00+09:00",
          event: "adhoc_start" as const,
          id: "adhoc-old",
          title: "前サイクルの差し込み",
        },
        {
          ts: "2026-07-16T09:10:00+09:00",
          event: "adhoc_end" as const,
          id: "adhoc-old",
          result: "完了",
        },
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "cycle_start" as const,
          cycle: "2026-07-16-cycle",
        },
      ]);

      const result = deriveRuns(
        matched,
        new Date("2026-07-16T10:31:00+09:00"),
        30,
      );
      const cycle = result.find((run) => run.kind === "cycle");

      expect(cycle?.lastActivityAt).toBe("2026-07-16T10:00:00+09:00");
      expect(cycle?.stale).toBe(true);
    });

    it("終了済みの cycle には lastActivityAt を付けない（stale も false のまま）", () => {
      const matched = matchRuns([
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "cycle_start" as const,
          cycle: "2026-07-16-cycle",
        },
        {
          ts: "2026-07-16T10:45:00+09:00",
          event: "cycle_end" as const,
          cycle: "2026-07-16-cycle",
          result: "completed" as const,
        },
      ]);

      const result = deriveRuns(
        matched,
        new Date("2026-07-16T20:00:00+09:00"),
        30,
      );

      expect(result[0]?.stale).toBe(false);
      expect(result[0]?.lastActivityAt).toBeUndefined();
    });

    it("start 行が壊れてペアにならなかった end イベントの ts も heartbeat に数える（cycle を stale にしない）", async () => {
      // codex 指摘の回帰テスト: heartbeat を matched（start とペアになった end
      // しか持たない）から求めていた頃は、start 行が壊れて ParseError になった
      // 委譲の delegate_end が closeLatestOpenRun に閉じる相手を見つけられず、
      // 直近（08:40）に活動が記録されているのに cycle 開始（07:36）起点で
      // 判定され stale になっていた。
      const { events, errors } = await parseRuns(
        fixture("orphan-end-after-broken-start.jsonl"),
      );

      // 壊れた行は ParseError として残り、valid な end 行はイベントとして残る
      // （パーサは「壊れた行だけを積み、正常な行は活かす」設計）。
      expect(errors).toHaveLength(1);
      expect(errors[0]?.line).toBe(2);
      expect(events.map((e) => e.event)).toEqual([
        "cycle_start",
        "delegate_end",
      ]);

      const matched = matchRuns(events);
      // ペアになる start が無いため delegate の MatchedRun は生成されない
      // （＝matched からは end の ts を復元できない）。
      expect(matched).toHaveLength(1);
      expect(matched[0]?.kind).toBe("cycle");

      // cycle 開始から 84 分（しきい値 30 分超過）だが、最終活動（08:40 の
      // delegate_end）からは 20 分しか経っていない。
      const now = new Date("2026-08-18T09:00:00+09:00");
      const result = deriveRuns(matched, now, 30);

      const cycle = result.find((run) => run.kind === "cycle");
      expect(cycle?.lastActivityAt).toBe("2026-08-18T08:40:00+09:00");
      expect(cycle?.stale).toBe(false);
      expect(deriveCycleStatus(result)).toBe("running");
      expect(deriveCycleLastActivityAt(result)).toBe(
        "2026-08-18T08:40:00+09:00",
      );
    });

    it("ペアにならなかった end からもしきい値を超えていれば cycle は stale になる", async () => {
      // 取りこぼしを直した結果として「常に非 stale」になるわけではないことの確認
      // （heartbeat が前へ進むだけで、判定そのものは従来どおり経過で行う）。
      const { events } = await parseRuns(
        fixture("orphan-end-after-broken-start.jsonl"),
      );
      const matched = matchRuns(events);

      // 最終活動（08:40）から 31 分経過。
      const result = deriveRuns(
        matched,
        new Date("2026-08-18T09:11:00+09:00"),
        30,
      );

      const cycle = result.find((run) => run.kind === "cycle");
      expect(cycle?.lastActivityAt).toBe("2026-08-18T08:40:00+09:00");
      expect(cycle?.stale).toBe(true);
      expect(deriveCycleStatus(result)).toBe("stale");
    });
  });
});

describe("deriveCycleLastActivityAt", () => {
  it("実行中の cycle が無ければ undefined", () => {
    const runs = deriveRuns(
      matchRuns([
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "adhoc_start" as const,
          id: "adhoc-1",
          title: "調査",
        },
      ]),
      new Date("2026-07-16T10:10:00+09:00"),
      30,
    );

    expect(deriveCycleLastActivityAt(runs)).toBeUndefined();
  });

  it("実行中の cycle の最終活動時刻を返す", () => {
    const runs = deriveRuns(
      matchRuns([
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "cycle_start" as const,
          cycle: "2026-07-16-cycle",
        },
        {
          ts: "2026-07-16T10:20:00+09:00",
          event: "adhoc_start" as const,
          id: "adhoc-1",
          title: "調査",
        },
      ]),
      new Date("2026-07-16T10:30:00+09:00"),
      30,
    );

    expect(deriveCycleLastActivityAt(runs)).toBe("2026-07-16T10:20:00+09:00");
  });

  it("supersede された（新しい cycle_start が来た）古い cycle は対象にしない", () => {
    const runs = deriveRuns(
      matchRuns([
        {
          ts: "2026-07-16T10:00:00+09:00",
          event: "cycle_start" as const,
          cycle: "same-cycle",
        },
        {
          ts: "2026-07-16T11:00:00+09:00",
          event: "cycle_start" as const,
          cycle: "same-cycle",
        },
      ]),
      new Date("2026-07-16T11:10:00+09:00"),
      30,
    );

    expect(deriveCycleLastActivityAt(runs)).toBe("2026-07-16T11:00:00+09:00");
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

  it("デフォルトは60分（Issue #154 で 30 分から延長）", () => {
    expect(DEFAULT_STALE_MINUTES).toBe(60);
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

  it("override が0（環境変数なし）なら既定値にフォールバックする（override にも環境変数と同じ正数チェックを適用）", () => {
    delete process.env[ENV_KEY];
    expect(resolveStaleMinutes(0)).toBe(DEFAULT_STALE_MINUTES);
  });

  it("override が負数（環境変数なし）なら既定値にフォールバックする", () => {
    delete process.env[ENV_KEY];
    expect(resolveStaleMinutes(-5)).toBe(DEFAULT_STALE_MINUTES);
  });

  it("override が NaN（環境変数なし）なら既定値にフォールバックする", () => {
    delete process.env[ENV_KEY];
    expect(resolveStaleMinutes(Number.NaN)).toBe(DEFAULT_STALE_MINUTES);
  });

  it("override が不正（0）で環境変数が有効な場合は環境変数の値にフォールバックする（override 無指定時と同じ優先順位で扱う）", () => {
    process.env[ENV_KEY] = "45";
    expect(resolveStaleMinutes(0)).toBe(45);
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
  it("日付のみ（journal 由来）はローカル日の深夜として扱う（TZ境界バグ修正: UTC深夜固定だと +09:00 環境で同日午前の runs イベントより後ろに逆転してしまうため）", () => {
    const entry: LogEntry = { ts: "2026-07-16", source: "journal", text: "x" };

    expect(logEntrySortKey(entry)).toBe(new Date(2026, 6, 16).getTime());
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
        // ホストローカル時刻の同日午前として動的に組み立てる（TZ非依存化。
        // 詳細は下の isoAtLocalTime のコメント参照）。
        ts: isoAtLocalTime(2026, 7, 16, 10, 5),
        source: "runs",
        text: "runs 側",
      },
    ];

    const merged = mergeLogEntries(journalEntries, runsEntries);

    expect(merged.map((e) => e.text)).toEqual(["journal 側", "runs 側"]);
  });

  // ホストのローカルタイムゾーンにおける "YYYY-MM-DDTHH:mm:00±HH:MM" 文字列を組み立てる。
  // セルフレビュー指摘対応: 当初この回帰テストは runs 側の ts に "+09:00" を
  // ハードコードしていたため、ホストのローカルTZ（journal 側の基準）と
  // runs 側のオフセットが食い違い、JST 以外のホスト（例: TZ=UTC）ではテストが
  // 失敗する問題があった（実際に TZ=UTC で再現・FAIL を確認済み）。
  // ホストの実際のオフセットで動的に組み立てることで、どの実行環境でも
  // 「同一暦日内では journal が runs より先」という不変条件を検証できるようにする。
  function isoAtLocalTime(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
  ): string {
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00${sign}${pad(
      Math.floor(abs / 60),
    )}:${pad(abs % 60)}`;
  }

  it("TZ境界の回帰テスト: 同日午前のホストローカル時刻の runs イベントより、journal(日付のみ)の当日マーカーが必ず先に来る（UTC深夜固定だと 2026-07-18T08:00+09:00 は 2026-07-17T23:00Z となり、journal の UTC 深夜より前に逆転してしまっていたバグの修正確認。runs 側 ts はホストの実オフセットで動的に組み立て、どのホストTZでも再現できるようにする）", () => {
    const journalEntries: LogEntry[] = [
      { ts: "2026-07-18", source: "journal", text: "journal マーカー" },
    ];
    const runsEntries: LogEntry[] = [
      {
        ts: isoAtLocalTime(2026, 7, 18, 8, 0),
        source: "runs",
        text: "runs イベント（同日午前）",
      },
    ];

    const merged = mergeLogEntries(journalEntries, runsEntries);

    expect(merged.map((e) => e.text)).toEqual([
      "journal マーカー",
      "runs イベント（同日午前）",
    ]);
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
