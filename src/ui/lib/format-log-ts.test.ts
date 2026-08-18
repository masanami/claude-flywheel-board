import { describe, expect, it, vi } from "vitest";
import { formatLogTimestamp } from "./format-log-ts.ts";

describe("formatLogTimestamp（Issue #152）", () => {
  it("フル ISO 8601（オフセット付き）を分精度の短い形式に整形する", () => {
    // ローカルタイムゾーン基準で整形されるため、期待値も同じ基準で組み立てる
    // （CI・開発機の TZ に依存しないアサーションにする）。
    const ts = "2026-08-14T09:05:27+09:00";
    const local = new Date(Date.parse(ts));
    const pad = (value: number) => String(value).padStart(2, "0");
    const expected = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`;

    expect(formatLogTimestamp(ts)).toBe(expected);
    // 秒・オフセットは表示から落ちる（幅の圧迫を解消するのが目的）。
    expect(formatLogTimestamp(ts)).not.toContain("27");
    expect(formatLogTimestamp(ts)).not.toContain("+09:00");
  });

  it("+09:00 環境では ISO の時刻がそのまま分精度になる", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    try {
      expect(formatLogTimestamp("2026-08-14T09:05:27+09:00")).toBe(
        "2026-08-14 09:05",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("journal 由来の日付のみ ts はそのまま返す（00:00 を捏造しない）", () => {
    expect(formatLogTimestamp("2026-08-14")).toBe("2026-08-14");
  });

  it("パースできない ts は無加工でそのまま返す", () => {
    expect(formatLogTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
  });
});
