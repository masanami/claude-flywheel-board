// #16（ボードの D&D／＋差し込み動線）が呼び出す prefill 公開 API。
// TerminalPane（実際に接続を持つコンポーネント）と疎結合にするため、
// モジュールスコープの簡易レジストリとして提供する。
//
// クリティカル設計決定（親 Issue #2 / #14）: ここで公開する操作は「未実行の
// 文字列を流し込む」prefill のみ。Enter 送信・自動実行の API をここに足さない。
//
// Issue #124 セルフレビュー指摘: TerminalPane は mount 時に1回だけ /api/board を
// 読んでタブ一覧を確定しており（二重の WS 接続を避けるため意図的に REST の
// 1回読みに留めている。TerminalPane.tsx 冒頭コメント参照）、Board.tsx が
// 保有する WS agent_update を購読していない。そのため board を再起動しない限り
// 新規エージェントのタブが出現しない欠落があった。新しい WS 接続・ポーリングを
// 追加せず（親 Issue #119 クリティカル設計決定）に解消するため、prefill と同じ
// 疎結合レジストリへ addAgent を追加し、Board.tsx の onAgentUpdate から
// notifyAgentAdded を呼ぶ（Board.tsx 参照）。タブ一覧への追加のみを行い、
// 自動でそのタブを開く・接続する・コマンドを流し込むことはしない
// （#125 の prefill スコープとは独立）。
export type TerminalController = {
  prefill(agent: string, command: string): void;
  addAgent(name: string): void;
};

let currentController: TerminalController | undefined;

/** TerminalPane が mount 時に自身を登録する。 */
export function registerTerminalController(
  controller: TerminalController,
): void {
  currentController = controller;
}

/**
 * TerminalPane が unmount 時に呼ぶ。現在登録中のものと一致する場合のみクリアする
 * （StrictMode の二重 mount/unmount や、古いインスタンスからの誤クリアを防ぐ）。
 */
export function unregisterTerminalController(
  controller: TerminalController,
): void {
  if (currentController === controller) {
    currentController = undefined;
  }
}

/**
 * 指定 agent のタブに command を prefill する。
 * 未登録時（TerminalPane が mount されていない等）は何もしない
 * （board が落ちないことを優先する）。
 */
export function prefill(agent: string, command: string): void {
  currentController?.prefill(agent, command);
}

/**
 * 新規エージェントをタブ一覧へ追加する（Issue #124）。既に一覧にある名前は
 * TerminalPane 側で無視される（冪等）。未登録時（TerminalPane が mount
 * されていない等）は何もしない（board が落ちないことを優先する）。
 */
export function notifyAgentAdded(name: string): void {
  currentController?.addAgent(name);
}

/**
 * テスト専用: 現在の登録内容を問わず、レジストリを強制的に空にする。
 *
 * unregisterTerminalController は「現在登録中のものと一致する場合のみ
 * クリアする」契約のため、呼び出し元が登録済みインスタンスの参照を
 * 持たない afterEach 等からは確実にクリアできない（一致しない別インスタンスを
 * 渡しても無視されるだけで、レジストリの汚染がテスト間に漏れ得る）。
 * 本番コードから呼ばれることは想定しない。
 */
export function resetTerminalControllerForTest(): void {
  currentController = undefined;
}
