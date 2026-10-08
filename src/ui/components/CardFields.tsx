import type { Challenge } from "../board-types.ts";
import { cardFieldItems } from "../lib/card-fields.ts";

/**
 * カードの 4 項目（一言で・位置づけ・いまの状態・次に人間がすること。Issue #185）を
 * 値があるものだけラベル付きで並べる。カードの面（TaskCard）と詳細（CardDetailModal）
 * の双方で同じ見え方にするための共通部品。1 項目も無ければ何も描画しない。
 *
 * 台帳の値は 1 行のプレーンテキスト。markdown として再解釈せず、そのまま出す
 * （board は消費者に徹する。NFR-05）。
 */
export function CardFields({
  challenge,
  className,
  testId,
}: {
  challenge: Challenge;
  className: string;
  testId: string;
}) {
  const items = cardFieldItems(challenge);
  if (items.length === 0) {
    return null;
  }
  return (
    <dl className={className} data-testid={testId}>
      {items.map(([label, value]) => (
        <div key={label} className={`${className}-item`}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
