import { describe, expect, it } from "vitest";
import { createAttachInputGate } from "./attach-input-gate.ts";

// tmux attach 時の再生ノイズ対策（#27 フォローアップ）。
// xterm.js の onData は「自動応答（DA1/DA2/DSR 等）」と「ユーザーの実操作」を
// 区別できないため、DOM 上の実操作イベントを観測するまで input 送信を抑止する
// ゲート本体の単体テスト。

describe("createAttachInputGate", () => {
  it("生成直後は isOpen() が false（実操作を未観測）", () => {
    const target = document.createElement("div");
    const gate = createAttachInputGate(target);

    expect(gate.isOpen()).toBe(false);
  });

  it("keydown を観測すると isOpen() が true になる", () => {
    const target = document.createElement("div");
    const gate = createAttachInputGate(target);

    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    expect(gate.isOpen()).toBe(true);
  });

  it("paste を観測すると isOpen() が true になる", () => {
    const target = document.createElement("div");
    const gate = createAttachInputGate(target);

    target.dispatchEvent(new Event("paste", { bubbles: true }));

    expect(gate.isOpen()).toBe(true);
  });

  it("compositionstart（IME変換開始）を観測すると isOpen() が true になる", () => {
    const target = document.createElement("div");
    const gate = createAttachInputGate(target);

    target.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    expect(gate.isOpen()).toBe(true);
  });

  it("reset() すると再び isOpen() が false に戻る", () => {
    const target = document.createElement("div");
    const gate = createAttachInputGate(target);
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
    expect(gate.isOpen()).toBe(true);

    gate.reset();

    expect(gate.isOpen()).toBe(false);
  });

  it("dispose() 後は keydown を観測しても isOpen() が true にならない（イベント購読解除）", () => {
    const target = document.createElement("div");
    const gate = createAttachInputGate(target);

    gate.dispose();
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    expect(gate.isOpen()).toBe(false);
  });

  it("子要素で発火した keydown（バブリング）も観測できる（container 直下の textarea を想定）", () => {
    const target = document.createElement("div");
    const child = document.createElement("textarea");
    target.appendChild(child);
    const gate = createAttachInputGate(target);

    child.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    expect(gate.isOpen()).toBe(true);
  });

  it("capture フェーズで解錠するため、target フェーズの他リスナより先に isOpen() が true になる", () => {
    const target = document.createElement("div");
    const child = document.createElement("textarea");
    target.appendChild(child);
    const gate = createAttachInputGate(target);

    let openObservedInsideTargetListener = false;
    // xterm.js 自身が textarea へ張る target フェーズのリスナを模す。
    child.addEventListener("keydown", () => {
      openObservedInsideTargetListener = gate.isOpen();
    });

    child.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    expect(openObservedInsideTargetListener).toBe(true);
  });
});
