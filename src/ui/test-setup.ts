import { afterEach } from "vitest";

// UI（jsdom環境）でのみ DOM 用の追加マッチャーと自動クリーンアップを設定する。
// このファイルは ui プロジェクト（vite.config.ts の test.projects）にのみ
// setupFiles として登録されるため、server 側テストには影響しない。
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");
  // @testing-library/react はグローバルに `afterEach` が生えている場合のみ
  // 自動クリーンアップを登録する（test.globals を有効化していない本プロジェクトでは
  // 発火しないため）、明示的に登録して各テスト間の DOM 状態を分離する。
  afterEach(() => {
    cleanup();
  });
}
