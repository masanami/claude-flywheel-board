/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// UI ソースは src/ui/ 配下。ビルド成果物は dist/ui/ にまとめ、
// 本番時は Hono サーバ (src/server/index.ts) がここを静的配信する。
export default defineConfig({
  root: fileURLToPath(new URL("./src/ui", import.meta.url)),
  plugins: [react()],
  server: {
    // NFR-03: UI 開発サーバも 127.0.0.1 固定。外部から上書きできる口は作らない。
    host: "127.0.0.1",
    // dev(5173) と Node サーバ(4317) は別オリジンのため、/api・/ws を明示的に
    // Node サーバへ転送する（本番ビルド後は Hono が同一オリジン配信するため不要）。
    // 転送先は常に 127.0.0.1 固定（NFR-03）。
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
      },
      // WS は正規表現キーで `^/ws$` `^/ws/terminal` にスコープする。
      // 単純な文字列プレフィックス "/ws" だと、Board.tsx が import する
      // `/ws.ts`（Vite が実際にリクエストするソースモジュールの静的アセットパス）
      // まで巻き込んでしまい、そちらが 404 になって画面が白くなる（既知の落とし穴）。
      "^/ws$": {
        target: "ws://127.0.0.1:4317",
        ws: true,
      },
      "^/ws/terminal": {
        target: "ws://127.0.0.1:4317",
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
          include: ["src/server/**/*.test.ts"],
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
});
