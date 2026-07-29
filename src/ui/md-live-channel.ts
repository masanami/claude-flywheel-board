import type {
  MdFileChangedMessage,
  MdSubscribeErrorMessage,
} from "./board-types.ts";

// Issue #70: Board.tsx（WS 接続を所有）と PreviewPanel.tsx（プレビュー対象の
// 選択・ライブ更新の表示反映を担当）を疎に結ぶための最小限の受け口。
//
// 両者は直接の親子関係だが状態を共有していない（Board.tsx が
// `<PreviewPanel />` を呼び出すだけ）。PreviewPanel が独自の WS 接続を
// 新設するのは親要件チケット #61 の方針（既存の唯一の /ws 接続にメッセージ
// 種別を足すだけ）に反するため、Board が保有する WS 接続の送受信を
// このオブジェクト経由で PreviewPanel へ橋渡しする。
//
// 汎用的な pub/sub 基盤（複数購読者・購読解除IDの管理など）は導入しない。
// PreviewPanel が唯一の購読者であることを前提にした、差し替え可能な単一
// ハンドラスロットに留める（KISS）。「自分が開いているファイルと一致する
// 場合のみ再フェッチする」「md_subscribe_error 受信時にライブ更新無効の
// 注記を出す」という判定ロジックは PreviewPanel 側に閉じ込め、Board 側は
// WS からの転送のみを担う（関心の分離）。
export type MdLiveHandlers = {
  onFileChanged?: (message: MdFileChangedMessage) => void;
  onSubscribeError?: (message: MdSubscribeErrorMessage) => void;
  /**
   * セルフレビュー指摘: WS は切断されると自動再接続する（src/ui/ws.ts の
   * 既存ロジック）が、サーバ側の購読はクライアント接続単位で保持される
   * ため（src/server/md/watch.ts の subscriptionByClient）、再接続後の
   * 新しい接続には以前の購読が引き継がれない。selectedFile 自体は変化
   * しないため、subscribe effect（[selectedFile, mdLive] 依存）は再実行
   * されず、無警告のままライブ更新が恒久的に止まってしまう。
   * Board 側は WS が open 状態になるたび（初回接続・再接続の両方）に
   * このハンドラを呼び、PreviewPanel は現在選択中のファイルがあれば
   * 再度 subscribe し直す。
   */
  onReconnected?: () => void;
};

export type MdLiveChannel = {
  /** プレビュー対象ファイルの購読を要求する（md_subscribe を送信する）。 */
  subscribe(repo: string, path: string): void;
  /** プレビュー対象ファイルの購読解除を要求する（md_unsubscribe を送信する）。 */
  unsubscribe(repo: string, path: string): void;
  /**
   * PreviewPanel が現在の選択ファイルに応じてハンドラを都度差し替える
   * 受け口。Board 側はこのオブジェクトを（生成時点で固定した参照のまま）
   * 保持し、WS から届いたメッセージをその時点の handlers へ転送する。
   */
  handlers: MdLiveHandlers;
};

/**
 * mdLive prop を渡さずに PreviewPanel を単体レンダリングする既存テスト
 * （Board.tsx を経由しない場合）向けの何もしないチャネル。呼び出しごとに
 * 新しいオブジェクトを生成するため、テスト間で state が漏れ出さない。
 */
export function createNoopMdLiveChannel(): MdLiveChannel {
  return {
    subscribe: () => {},
    unsubscribe: () => {},
    handlers: {},
  };
}
