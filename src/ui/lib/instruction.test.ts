import { describe, expect, it } from "vitest";
import {
  buildInsertInstruction,
  buildReorderInstruction,
} from "./instruction.ts";

describe("buildReorderInstruction", () => {
  it("隣接カードに優先度がある場合、優先度の値を明記した文言を生成する", () => {
    const instruction = buildReorderInstruction("C-047", {
      id: "C-044",
      priority: "P1",
    });

    expect(instruction).toBe(
      "課題 C-047 の優先度を C-044 より上（P1 以上）に変更してください",
    );
  });

  it("隣接カードに優先度が無い場合、「適切な優先度で」にフォールバックする", () => {
    const instruction = buildReorderInstruction("C-047", { id: "C-044" });

    expect(instruction).toBe(
      "課題 C-047 の優先度を C-044 より上（適切な優先度で）に変更してください",
    );
  });

  it("隣接カードが無い場合（最優先位置）、最上位への変更を指示する文言を生成する", () => {
    const instruction = buildReorderInstruction("C-047", undefined);

    expect(instruction).toBe("課題 C-047 の優先度を最上位に変更してください");
  });

  it("placement が bottom の場合、対象カードより下（最低優先度）への変更を指示する文言を生成する", () => {
    const instruction = buildReorderInstruction(
      "C-047",
      { id: "C-099" },
      "bottom",
    );

    expect(instruction).toBe(
      "課題 C-047 の優先度を C-099 より下（最低優先度）に変更してください",
    );
  });

  it("placement を省略した場合は既定で before（隣接カードより上）として扱う", () => {
    const withPlacement = buildReorderInstruction(
      "C-047",
      { id: "C-044", priority: "P1" },
      "before",
    );
    const withoutPlacement = buildReorderInstruction("C-047", {
      id: "C-044",
      priority: "P1",
    });

    expect(withoutPlacement).toBe(withPlacement);
  });
});

describe("buildInsertInstruction", () => {
  it("隣接カードに優先度がある場合、優先度の値を明記した文言を生成する", () => {
    const instruction = buildInsertInstruction("新しい課題の内容", {
      id: "C-044",
      priority: "P1",
    });

    expect(instruction).toBe(
      "差し込み: 「新しい課題の内容」を課題台帳に追加してください。優先度は C-044 より上（P1 相当）でお願いします",
    );
  });

  it("隣接カードに優先度が無い場合、「適切な優先度で」にフォールバックする", () => {
    const instruction = buildInsertInstruction("新しい課題の内容", {
      id: "C-044",
    });

    expect(instruction).toBe(
      "差し込み: 「新しい課題の内容」を課題台帳に追加してください。優先度は C-044 より上（適切な優先度で）でお願いします",
    );
  });

  it("隣接カードが無い場合（最優先位置）、最上位への追加を指示する文言を生成する", () => {
    const instruction = buildInsertInstruction("新しい課題の内容", undefined);

    expect(instruction).toBe(
      "差し込み: 「新しい課題の内容」を課題台帳に追加してください。優先度は最上位でお願いします",
    );
  });

  it("placement が bottom の場合、対象カードより下（最低優先度）への追加を指示する文言を生成する", () => {
    const instruction = buildInsertInstruction(
      "新しい課題の内容",
      { id: "C-099" },
      "bottom",
    );

    expect(instruction).toBe(
      "差し込み: 「新しい課題の内容」を課題台帳に追加してください。優先度は C-099 より下（最低優先度）でお願いします",
    );
  });
});
