import { useState } from "react";

// board 右サイドの開閉式パネル（マークダウンプレビュー機能全体の設計 —
// docs/features/markdown-preview.md「機能全体の設計」節）のシェルのみを
// 実装する（#64）。中身（ファイルツリー・Markdownレンダリング・ライブ更新）は
// 後続チケット（#68/#69/#70）のスコープであり、ここでは placeholder のみ置く。
//
// 右サイドパネルは flex でボードカラム領域を圧縮して確保する
// （下部ターミナル領域の高さ・幅には一切影響しない）。組み込み側は
// Board.tsx を参照。本コンポーネント自体は自分の幅のみを inline style で
// 制御し、周囲のレイアウトには関与しない（KISS）。
//
// board は状態ファイルへ一切書き込まない（NFR-01）。本コンポーネントは
// 開閉・幅ドラッグの UI 状態のみを持ち、API 呼び出し・書き込み経路は
// 一切持たない。
//
// clamp() は TerminalPane.tsx にも同名の実装がある（セルフレビュー指摘:
// DRY違反）が、本チケットの制約で TerminalPane.tsx 自体には一切触れられない
// ため、共有ヘルパへ切り出しても TerminalPane 側の重複は解消できない
// （唯一の利用者のまま lib 層へ切り出す実益が薄い）。2行の純関数のため、
// YAGNI/KISS を優先しここではあえてローカルに留める。

const MIN_WIDTH_PX = 240;
const MAX_WIDTH_PX = 800;
const DEFAULT_WIDTH_PX = 360;
const RESIZE_STEP_PX = 32;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function PreviewPanel() {
  // 初期状態は閉じておく。中身は後続チケットまで placeholder のため、
  // 起動直後から中身の無い広いパネルを占有させないための判断（設計判断は
  // セルフレビュー時に説明可能: プレースホルダ表示より初期非表示を優先）。
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH_PX);

  const handleResizeMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    // ドラッグ中にテキスト選択が始まらないようにする（TerminalPane の
    // 既存パターンに合わせる。#44/#51 のコピー/ペースト体験を壊さないため）。
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // パネルは画面右端に位置し、ハンドルは左端にある。ハンドルを左へ
      // ドラッグする（delta が負）ほどパネル幅が増える。
      const delta = moveEvent.clientX - startX;
      setWidth(clamp(startWidth - delta, MIN_WIDTH_PX, MAX_WIDTH_PX));
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // マウスドラッグの代替経路（TerminalPane の既存パターンに合わせる）。
    // セルフレビュー指摘: 当初 ArrowRight で増加としていたが、マウスドラッグ
    // （右へドラッグ＝ハンドルが右へ移動＝パネル幅は減る）と方向が逆だった。
    // ハンドルの物理的な移動方向とキー方向を一致させ、マウス・キーボード両
    // 経路で同じ向きになるよう ArrowRight で減少・ArrowLeft で増加にする。
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setWidth((prev) =>
        clamp(prev - RESIZE_STEP_PX, MIN_WIDTH_PX, MAX_WIDTH_PX),
      );
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setWidth((prev) =>
        clamp(prev + RESIZE_STEP_PX, MIN_WIDTH_PX, MAX_WIDTH_PX),
      );
    }
  };

  return (
    <div
      className="preview-panel"
      data-testid="preview-panel"
      style={{ width: open ? `${width}px` : undefined }}
    >
      {open && (
        <div
          className="preview-panel-resize-handle"
          data-testid="preview-panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH_PX}
          aria-valuemax={MAX_WIDTH_PX}
          aria-label="プレビューパネルの幅"
          tabIndex={0}
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
        />
      )}
      <div className="preview-panel-content">
        <div className="preview-panel-header">
          {open && <span className="preview-panel-title">プレビュー</span>}
          {open && (
            <button
              type="button"
              className="preview-panel-refresh-button"
              data-testid="preview-panel-refresh-button"
              aria-label="ファイルツリーを更新"
              // 結線は FileTree タスク（#68）で行うため、現時点では no-op
              // （チケット #64 の完了条件で明示的に許容されている）。
              // title でユーザーに準備中であることを伝える（セルフレビュー
              // 指摘: 押しても無反応であることの手掛かりが無かった）。
              title="ファイルツリーの更新（準備中）"
              onClick={() => {}}
            >
              ⟳
            </button>
          )}
          <button
            type="button"
            className="preview-panel-toggle-button"
            aria-label={
              open ? "プレビューパネルを閉じる" : "プレビューパネルを開く"
            }
            aria-expanded={open}
            aria-controls={open ? "preview-panel-body" : undefined}
            onClick={() => setOpen((prev) => !prev)}
          >
            {/* セルフレビュー指摘: 日本語フルテキストのボタンだと閉じている
                間も ~170px 前後の横幅を常時占有し、「閉じたらボードへ幅を
                返す」という狙いに反する。TerminalPane の折りたたみボタン
                （アイコン + aria-label）と同じパターンにし、閉状態の
                footprint を最小化する。 */}
            {open ? "▸" : "◂"}
          </button>
        </div>
        {open && (
          <div
            className="preview-panel-body"
            data-testid="preview-panel-body"
            id="preview-panel-body"
          >
            プレビューはここに表示されます（準備中）
          </div>
        )}
      </div>
    </div>
  );
}
