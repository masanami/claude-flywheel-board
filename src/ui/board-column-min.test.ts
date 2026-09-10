import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// エージェントカラムの下限幅は「grid-auto-columns の下限」と
// 「.board-columns の min-width」の 2 箇所が同じ値に依存する（#178）。
// 実値を直接書くと片方だけ更新されて取り残されるため、両者が同じ CSS 変数
// （--board-column-min）を参照していることを機械で固定する。
// **値そのもの（320px）ではなく「2 箇所が連動していること」を検査対象にする**
// ので、将来の値変更でこのテストを書き換える必要はない。
const stylesPath = join(process.cwd(), "src/ui/styles.css");

const COLUMN_MIN_VAR = "--board-column-min";

/** コメント内の記述で検査が誤って通る（空虚に真になる）のを防ぐため、
 *  コメントを落とした CSS を検査対象にする。 */
function loadStyles(): string {
  return readFileSync(stylesPath, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** `selector { ... }` の宣言ブロック本文を取り出す。 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `${selector} の宣言ブロックが見つからない`).not.toBeNull();
  return match?.[1] ?? "";
}

/** 宣言ブロック本文から 1 プロパティの値を取り出す。 */
function declarationValue(body: string, property: string): string {
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*);`));
  expect(match, `${property} の宣言が見つからない`).not.toBeNull();
  return (match?.[1] ?? "").trim();
}

describe("エージェントカラムの下限幅", () => {
  it(`:root が ${COLUMN_MIN_VAR} を長さとして定義している`, () => {
    const root = ruleBody(loadStyles(), ":root");
    expect(declarationValue(root, COLUMN_MIN_VAR)).toMatch(/^\d+(\.\d+)?px$/);
  });

  it("grid-auto-columns の下限が実値ではなく変数を参照している", () => {
    const body = ruleBody(loadStyles(), ".board-columns");
    const value = declarationValue(body, "grid-auto-columns");
    // minmax() の第1引数（＝トラック最小サイズ）が変数であること。
    // 上限（第2引数）は #41 由来の意図で実値のまま据え置くため検査しない。
    expect(value).toMatch(
      new RegExp(`^minmax\\(\\s*var\\(${COLUMN_MIN_VAR}\\)\\s*,`),
    );
  });

  it(".board-columns の min-width が実値ではなく変数を参照している", () => {
    const body = ruleBody(loadStyles(), ".board-columns");
    const value = declarationValue(body, "min-width");
    expect(value).toContain(`var(${COLUMN_MIN_VAR})`);
    // padding 相当の上乗せ（rem）は許すが、px の実値が混ざっていたら
    // 変数と二重管理になっているので落とす。
    expect(value).not.toMatch(/\d+(\.\d+)?px/);
  });
});
