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

  // jsdom は HTMLDialogElement の showModal / close / ESC 自動クローズを
  // 実装していない（2026-07 時点）。CardDetailModal は <dialog> + showModal()
  // でネイティブのフォーカストラップ・ESC・背景 inert を得る設計のため、
  // テスト環境限定で実ブラウザの挙動を模した最小限のポリフィルを当てる
  // （本番コードには一切含めない・テストの土台のみに閉じる）。
  if (
    typeof HTMLDialogElement !== "undefined" &&
    typeof HTMLDialogElement.prototype.showModal !== "function"
  ) {
    const escapeHandlers = new WeakMap<
      HTMLDialogElement,
      (event: KeyboardEvent) => void
    >();

    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      // 実ブラウザ同様、open 済みへの showModal() は InvalidStateError
      // （StrictMode の setup → cleanup → setup 二重実行の回帰を検出するため）
      if (this.hasAttribute("open")) {
        throw new DOMException(
          "Failed to execute 'showModal' on 'HTMLDialogElement': The dialog is already open.",
          "InvalidStateError",
        );
      }
      this.setAttribute("open", "");
      const focusable = this.querySelector<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]",
      );
      (focusable ?? this).focus();

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          this.close();
        }
      };
      escapeHandlers.set(this, handleKeyDown);
      document.addEventListener("keydown", handleKeyDown);
    };

    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      if (!this.hasAttribute("open")) {
        return;
      }
      this.removeAttribute("open");
      const handleKeyDown = escapeHandlers.get(this);
      if (handleKeyDown) {
        document.removeEventListener("keydown", handleKeyDown);
        escapeHandlers.delete(this);
      }
      this.dispatchEvent(new Event("close"));
    };
  }
}
