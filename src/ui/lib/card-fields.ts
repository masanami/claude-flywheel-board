import type { Challenge } from "../board-types.ts";

/**
 * カードの 4 項目（claude-flywheel `docs/challenge-ledger-format.md` §カードの 4 項目）の
 * うち、値があるものだけを [ラベル, 値] の組で返す。順序は台帳の規定どおり
 * 一言で・位置づけ・いまの状態・次に人間がすること。ラベルは台帳のフィールド名を
 * そのまま使う（board 側で言い換えない。NFR-05）。
 *
 * 4 項目はいずれも任意。1 つも無ければ空配列＝カードの面・詳細とも従来の表示のまま。
 */
export function cardFieldItems(
  challenge: Challenge,
): Array<readonly [label: string, value: string]> {
  const items: Array<readonly [string, string | undefined]> = [
    ["一言で", challenge.oneLiner],
    ["位置づけ", challenge.positioning],
    ["いまの状態", challenge.currentState],
    ["次に人間がすること", challenge.nextHumanAction],
  ];
  return items.filter(
    (item): item is readonly [string, string] => item[1] !== undefined,
  );
}
