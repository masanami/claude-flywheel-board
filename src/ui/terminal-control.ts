// #16（ボードの D&D／＋差し込み動線）が呼び出す prefill 公開 API。
// TerminalPane（実際に接続を持つコンポーネント）と疎結合にするため、
// モジュールスコープの簡易レジストリとして提供する。
//
// クリティカル設計決定（親 Issue #2 / #14）: ここで公開する操作は「未実行の
// 文字列を流し込む」prefill のみ。Enter 送信・自動実行の API をここに足さない。

export type TerminalController = {
  prefill(agent: string, command: string): void;
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
