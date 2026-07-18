import { describe, expect, it } from "vitest";
import { formatElapsed } from "./format-elapsed.ts";

describe("formatElapsed", () => {
  it("40分経過している場合は「40分」と表示する", () => {
    const startedAt = "2026-07-16T09:00:00.000Z";
    const now = new Date("2026-07-16T09:40:00.000Z");

    expect(formatElapsed(startedAt, now)).toBe("40分");
  });

  it("90分経過している場合は「1時間30分」と表示する", () => {
    const startedAt = "2026-07-16T09:00:00.000Z";
    const now = new Date("2026-07-16T10:30:00.000Z");

    expect(formatElapsed(startedAt, now)).toBe("1時間30分");
  });

  it("ちょうど60分経過している場合は「1時間0分」と表示する（境界値）", () => {
    const startedAt = "2026-07-16T09:00:00.000Z";
    const now = new Date("2026-07-16T10:00:00.000Z");

    expect(formatElapsed(startedAt, now)).toBe("1時間0分");
  });

  it("経過0分（同時刻）の場合は「0分」と表示する（境界値）", () => {
    const startedAt = "2026-07-16T09:00:00.000Z";
    const now = new Date("2026-07-16T09:00:00.000Z");

    expect(formatElapsed(startedAt, now)).toBe("0分");
  });
});
