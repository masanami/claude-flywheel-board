import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Vite の `new URL("./x.svg", import.meta.url)` はアセットURL変換の対象になり
// テスト実行時に file スキーム以外へ書き換わってしまうため、ここでは
// process.cwd()（プロジェクトルート）基準の素朴なパス結合で参照する。
const indexHtmlPath = join(process.cwd(), "src/ui/index.html");
const faviconPath = join(process.cwd(), "src/ui/public/favicon.svg");

describe("favicon", () => {
  it("index.html が favicon.svg を icon link として参照している", () => {
    // 属性の並び順・空白の変更に対して脆くならないよう、完全一致ではなく
    // <link> タグの存在と必須属性（rel/type/href）の個別マッチで検証する。
    const html = readFileSync(indexHtmlPath, "utf-8");
    const iconLinkMatch = html.match(/<link[^>]*rel="icon"[^>]*>/);
    expect(iconLinkMatch).not.toBeNull();
    const iconLink = iconLinkMatch?.[0] ?? "";
    expect(iconLink).toContain('type="image/svg+xml"');
    expect(iconLink).toContain('href="/favicon.svg"');
  });

  it("favicon.svg が存在し、有効なSVG文書である", () => {
    const svg = readFileSync(faviconPath, "utf-8");
    expect(svg.trim().startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("viewBox");
  });
});
