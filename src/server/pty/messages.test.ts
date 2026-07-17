import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./messages.ts";

describe("parseClientMessage", () => {
  it("input メッセージを解釈する", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "input", data: "ls -la\n" }),
    );

    expect(message).toEqual({ type: "input", data: "ls -la\n" });
  });

  it("resize メッセージを解釈する", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
    );

    expect(message).toEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("prefill メッセージを解釈する", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "prefill", command: "git status" }),
    );

    expect(message).toEqual({ type: "prefill", command: "git status" });
  });

  it("不正な JSON は undefined を返す", () => {
    expect(parseClientMessage("not-json")).toBeUndefined();
  });

  it("未知の type は undefined を返す", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "enter", data: "\n" })),
    ).toBeUndefined();
  });

  it("input で data が文字列でない場合は undefined を返す", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "input", data: 123 })),
    ).toBeUndefined();
  });

  it("resize で cols/rows が数値でない場合は undefined を返す", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "resize", cols: "120", rows: 40 }),
      ),
    ).toBeUndefined();
  });

  it("resize で cols/rows が 0 以下の場合は undefined を返す（不正な pty サイズを弾く）", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "resize", cols: 0, rows: 40 })),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({ type: "resize", cols: 80, rows: -1 }),
      ),
    ).toBeUndefined();
  });

  it("resize で cols/rows が整数でない場合は undefined を返す", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "resize", cols: 80.5, rows: 24 }),
      ),
    ).toBeUndefined();
  });

  it("resize で cols/rows が上限（1000）を超える場合は undefined を返す（node-pty への巨大値渡しを防ぐ）", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "resize", cols: 1_000_000_000, rows: 24 }),
      ),
    ).toBeUndefined();
    expect(
      parseClientMessage(
        JSON.stringify({ type: "resize", cols: 80, rows: 1001 }),
      ),
    ).toBeUndefined();
  });

  it("resize で cols/rows が上限ちょうど（1000）は許可する", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "resize", cols: 1000, rows: 1000 }),
      ),
    ).toEqual({ type: "resize", cols: 1000, rows: 1000 });
  });

  it("prefill で command が文字列でない場合は undefined を返す", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "prefill", command: null })),
    ).toBeUndefined();
  });

  it("prefill で command に改行 (\\n) が含まれる場合は undefined を返す（belt-and-braces。tmux 層の stripNewlines とは別に、プロトコル層でも拒否する）", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "prefill", command: "git status\n" }),
      ),
    ).toBeUndefined();
  });

  it("prefill で command に CRLF (\\r\\n) が含まれる場合は undefined を返す", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "prefill", command: "git status\r\n" }),
      ),
    ).toBeUndefined();
  });

  it("prefill で command の途中に単独の \\r が含まれる場合も undefined を返す", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "prefill", command: "git\rstatus" }),
      ),
    ).toBeUndefined();
  });

  it("配列やプリミティブなど object でない JSON は undefined を返す", () => {
    expect(parseClientMessage(JSON.stringify(["input"]))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify("input"))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify(null))).toBeUndefined();
  });
});
