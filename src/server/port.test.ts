import { describe, expect, it } from "vitest";
import { BOARD_PORT_ENV_KEY, DEFAULT_PORT, resolveBoardPort } from "./port.ts";

describe("resolveBoardPort", () => {
  it("未設定なら既定ポート（4317）を返す", () => {
    expect(resolveBoardPort(undefined)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(4317);
  });

  it("空文字・空白のみは未設定と同じ扱いにする", () => {
    expect(resolveBoardPort("")).toBe(DEFAULT_PORT);
    expect(resolveBoardPort("   ")).toBe(DEFAULT_PORT);
  });

  it("整数文字列を解決する（前後の空白は許容する）", () => {
    expect(resolveBoardPort("4318")).toBe(4318);
    expect(resolveBoardPort(" 8080 ")).toBe(8080);
    expect(resolveBoardPort("1")).toBe(1);
    expect(resolveBoardPort("65535")).toBe(65535);
  });

  it("環境変数が未設定なら既定ポートを返す（既定引数の経路）", () => {
    const saved = process.env[BOARD_PORT_ENV_KEY];
    delete process.env[BOARD_PORT_ENV_KEY];
    try {
      expect(resolveBoardPort()).toBe(DEFAULT_PORT);
    } finally {
      if (saved !== undefined) {
        process.env[BOARD_PORT_ENV_KEY] = saved;
      }
    }
  });

  it("環境変数から読み取る（既定引数の経路）", () => {
    const saved = process.env[BOARD_PORT_ENV_KEY];
    process.env[BOARD_PORT_ENV_KEY] = "4319";
    try {
      expect(resolveBoardPort()).toBe(4319);
    } finally {
      if (saved === undefined) {
        delete process.env[BOARD_PORT_ENV_KEY];
      } else {
        process.env[BOARD_PORT_ENV_KEY] = saved;
      }
    }
  });

  // 既定へフォールバックすると「別ポートのつもりが 4317 に戻り、先に動いていた
  // 別アカウントの board へ繋がる」サイレントな取り違えになるため、必ず throw する。
  it.each(["abc", "4318abc", "80.5", "-1", "0x1f", "+4318", "1 2"])(
    "整数として解釈できない値 %j は throw する",
    (raw) => {
      expect(() => resolveBoardPort(raw)).toThrow(BOARD_PORT_ENV_KEY);
    },
  );

  it.each(["0", "65536", "99999999999"])(
    "範囲外の値 %j は throw する",
    (raw) => {
      expect(() => resolveBoardPort(raw)).toThrow(BOARD_PORT_ENV_KEY);
    },
  );
});
