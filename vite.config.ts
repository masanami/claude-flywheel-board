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
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
  test: {
    // dev server 用の `root`（src/ui）から独立させ、プロジェクトルート基準で
    // src/server・src/ui 両方のテストを拾う。
    root: fileURLToPath(new URL(".", import.meta.url)),
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
