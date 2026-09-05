import { describe, expect, it, vi } from "vitest";
import {
  BOARD_PORT_ENV_KEY,
  DEFAULT_PORT,
  resolveBoardPort,
  resolveBoardPortFromEnv,
} from "./port.ts";

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

  // Issue #175: ここは以前 process.env を直接書き換えて検証していたため、実行環境に
  // FLYWHEEL_BOARD_PORT が設定されていると別のテストが巻き添えで落ちた。env を引数で
  // 注入し、実行環境の環境変数から完全に切り離す。
  it("env に未設定なら既定ポートを返す", () => {
    expect(resolveBoardPortFromEnv({})).toBe(DEFAULT_PORT);
  });

  it("env から読み取る", () => {
    expect(resolveBoardPortFromEnv({ [BOARD_PORT_ENV_KEY]: "4319" })).toBe(
      4319,
    );
  });

  it("env の不正値は throw する（既定へ黙って戻さない）", () => {
    expect(() =>
      resolveBoardPortFromEnv({ [BOARD_PORT_ENV_KEY]: "abc" }),
    ).toThrow(BOARD_PORT_ENV_KEY);
  });

  // 回帰の本体（Issue #175）: 実行環境に FLYWHEEL_BOARD_PORT が設定されていても、
  // 引数を渡した呼び出しは環境変数へ落ちてはならない。JS の既定引数は「明示的に渡した
  // undefined」でも発火するため、以前は resolveBoardPort(undefined) が env を読んでいた。
  it("実行環境の環境変数に左右されない（設定の有無で結果が変わらない）", () => {
    vi.stubEnv(BOARD_PORT_ENV_KEY, "4318");
    try {
      expect(resolveBoardPort(undefined)).toBe(DEFAULT_PORT);
      expect(resolveBoardPort("")).toBe(DEFAULT_PORT);
      expect(resolveBoardPort("8080")).toBe(8080);
      expect(resolveBoardPortFromEnv({})).toBe(DEFAULT_PORT);
    } finally {
      vi.unstubAllEnvs();
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
