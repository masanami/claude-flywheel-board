import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";

// favicon.test.ts と同じ理由で、Vite のアセットURL変換に巻き込まれない
// process.cwd()（プロジェクトルート）基準の素朴なパス結合で参照する。
const PROJECT_ROOT = process.cwd();
const publicDirPath = join(PROJECT_ROOT, "src/ui/public");
const indexHtmlPath = join(PROJECT_ROOT, "src/ui/index.html");
const manifestPath = join(publicDirPath, "manifest.webmanifest");

/** Chrome が「アプリとしてインストール」時のアイコンに要求する最小サイズ（Issue #150）。 */
const REQUIRED_ICON_SIZES = [192, 512];

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

type ManifestIcon = { src: string; sizes: string; type: string };

/**
 * PNG の実バイト列から実寸を読む。宣言（manifest の `sizes`）ではなく実体を見るのが
 * 目的なので、画像ライブラリを足さずに IHDR チャンクを直接読む。
 * PNG のバイト構造は固定: シグネチャ8B + チャンク長4B + "IHDR" 4B + 幅4B + 高さ4B（BE）。
 */
function readPngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  name?: string;
  display?: string;
  icons?: ManifestIcon[];
};

describe("Web App Manifest", () => {
  it("index.html が manifest を link として参照している", () => {
    // favicon.test.ts と同様、属性の並び順・空白に対して脆くならないよう
    // タグの存在と必須属性の個別マッチで検証する。
    const html = readFileSync(indexHtmlPath, "utf-8");
    const manifestLink =
      html.match(/<link[^>]*rel="manifest"[^>]*>/)?.[0] ?? null;
    expect(manifestLink).not.toBeNull();
    expect(manifestLink).toContain('href="/manifest.webmanifest"');
  });

  it("既存の favicon link は manifest 追加後も残っている", () => {
    // 受入基準「既存のタブ用 favicon の挙動は変わらない」（Issue #150）。
    // manifest の icons はタブの favicon を置き換えないため、両方が必要。
    const html = readFileSync(indexHtmlPath, "utf-8");
    expect(html).toMatch(
      /<link[^>]*rel="icon"[^>]*href="\/favicon\.svg"[^>]*>/,
    );
  });

  it("インストール可能な最小構成のフィールドを持つ", () => {
    // name は Dock・アプリ切り替えでの表示名になるため空だと目的を達しない。
    expect(manifest.name).toBeTruthy();
    // standalone でないとブラウザ UI 付きのウィンドウになり「アプリ」扱いにならない。
    expect(manifest.display).toBe("standalone");
  });

  it("icons が 192px / 512px の PNG を宣言している", () => {
    const declared = (manifest.icons ?? []).map((icon) => icon.sizes);
    for (const size of REQUIRED_ICON_SIZES) {
      expect(declared).toContain(`${size}x${size}`);
    }
  });

  it("icons の宣言が実ファイルと一致する（存在・実寸・フォーマット）", () => {
    const icons = manifest.icons ?? [];
    expect(icons.length).toBeGreaterThan(0);

    for (const icon of icons) {
      // src はルート絶対パスであること。相対パスだと board の URL によって
      // 解決先が変わり、ルート以外を開いた状態でのインストールで 404 になる。
      expect(icon.src.startsWith("/")).toBe(true);

      // 宣言された src が public/ 配下の実ファイルとして存在すること
      // （欠けていればビルド成果物にも入らず、インストール時 404 になる）。
      const bytes = readFileSync(join(publicDirPath, icon.src.slice(1)));

      // 宣言 type と実体が一致すること（.png という名前だけの別形式を弾く）。
      expect(icon.type).toBe("image/png");
      const { width, height } = readPngSize(bytes);

      // 宣言 sizes と実寸が一致すること。ここがズレると Chrome が要求サイズの
      // アイコンを見つけられず、汎用アイコンにフォールバックする（Issue #150 の症状）。
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });

  it("manifest とアイコンが Vite の publicDir 配下にある（ビルド成果物に入る）", async () => {
    // publicDir 配下のファイルはビルド時に outDir 直下へそのままコピーされる。
    // 「src/ui/public に置いたつもり」を設定側の実値で確かめるため、パスを
    // ハードコードで比較せず Vite に解決させる。
    const config = await resolveConfig(
      { configFile: join(PROJECT_ROOT, "vite.config.ts") },
      "build",
    );
    expect(config.publicDir).toBe(publicDirPath);

    for (const src of [
      "/manifest.webmanifest",
      ...REQUIRED_ICON_SIZES.map((s) => `/icon-${s}.png`),
    ]) {
      expect(() =>
        readFileSync(join(config.publicDir, src.slice(1))),
      ).not.toThrow();
    }
  });
});
