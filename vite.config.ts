/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type UserConfig, defineConfig } from "vite";
import { resolveBoardPortFromEnv } from "./src/server/port.ts";

/**
 * board の Vite 設定を組み立てる。**転送先ポートは引数で受け取る**（環境変数を
 * 直接読まない）。
 *
 * かつてはモジュールスコープで `const BOARD_PORT = resolveBoardPort()` と解決して
 * いたが、それだと `vite.config.ts` を import したテストが実行環境の
 * `FLYWHEEL_BOARD_PORT` をそのまま被り、非既定値を設定している開発者
 * （＝この上書き機能の唯一の利用者）だけがテスト赤になった（Issue #175）。
 * ポートを引数に切り出したことで、テストは実行環境に左右されず
 * `buildViteConfig(4317)` のように**注入して**検証できる。
 *
 * @param boardPort dev proxy の転送先 Node サーバのポート。
 */
export function buildViteConfig(boardPort: number): UserConfig {
  return {
    // UI ソースは src/ui/ 配下。ビルド成果物は dist/ui/ にまとめ、
    // 本番時は Hono サーバ (src/server/index.ts) がここを静的配信する。
    root: fileURLToPath(new URL("./src/ui", import.meta.url)),
    plugins: [react()],
    server: {
      // NFR-03: UI 開発サーバも 127.0.0.1 固定。外部から上書きできる口は作らない。
      host: "127.0.0.1",
      // dev(5173) と Node サーバ(既定 4317) は別オリジンのため、/api・/ws を明示的に
      // Node サーバへ転送する（本番ビルド後は Hono が同一オリジン配信するため不要）。
      // 転送先ホストは常に 127.0.0.1 固定（NFR-03）。ポートのみ boardPort に従う。
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${boardPort}`,
          changeOrigin: true,
        },
        // WS は正規表現キーで `^/ws$` `^/ws/terminal` にスコープする。
        // 単純な文字列プレフィックス "/ws" だと、Board.tsx が import する
        // `/ws.ts`（Vite が実際にリクエストするソースモジュールの静的アセットパス）
        // まで巻き込んでしまい、そちらが 404 になって画面が白くなる（既知の落とし穴）。
        "^/ws$": {
          target: `ws://127.0.0.1:${boardPort}`,
          ws: true,
        },
        "^/ws/terminal": {
          target: `ws://127.0.0.1:${boardPort}`,
          ws: true,
        },
      },
    },
    build: {
      outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
      emptyOutDir: true,
    },
    test: {
      // dev server 用の `root`（src/ui）から独立させ、プロジェクトルート基準で
      // src/server・src/ui 両方のテストを拾う。
      root: fileURLToPath(new URL(".", import.meta.url)),
      // server 側（node組込みAPI依存）は node、UI 側（DOM依存）は jsdom を使う。
      // Vitest 4 では environmentMatchGlobs が廃止されたため、projects でエリアごとに
      // environment を切り替える（`extends: true` でルート設定を継承）。
      projects: [
        {
          extends: true,
          test: {
            name: "server",
            environment: "node",
            // scripts/ は開発用ツール（vendoring の同期チェック等）。node 環境で
            // 動かす点は server 側と同じなので、同じプロジェクトで拾う。
            include: ["src/server/**/*.test.ts", "scripts/**/*.test.ts"],
          },
        },
        {
          extends: true,
          test: {
            name: "ui",
            environment: "jsdom",
            include: ["src/ui/**/*.test.ts", "src/ui/**/*.test.tsx"],
            setupFiles: ["src/ui/test-setup.ts"],
          },
        },
      ],
    },
  };
}

// 環境変数の読み取りは **defineConfig のコールバック内**＝設定が実際に必要になった
// 時点まで遅延させる。モジュールスコープで読むと、import しただけのテストが
// 実行環境の環境変数を被る（Issue #175）。
export default defineConfig(() => buildViteConfig(resolveBoardPortFromEnv()));
