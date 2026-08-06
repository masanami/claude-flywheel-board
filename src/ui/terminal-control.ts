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
// notifyAgentAdded を呼ぶ（Board.tsx 参照）。addAgent はタブ一覧への追加を
// 無条件・冪等に行う（新規追加か既存エージェントの通常更新かを区別しない）。
//
// Issue #125: 新規タブに一度だけ claude を prefill する要件を追加するにあたり、
// 「addAgent 呼び出し（＝agent_update ストリーム）だけを唯一の入力にして
// クライアント側で新規性を推論する」設計を最初に試みたが、agent_update
// ストリームは「本当に新規追加された」ケースと「サーバ起動直後の fullScan が
// 既存エージェントを1件ずつ広報しているだけ」のケースを区別する情報を持たない
// と判明した（src/server/index.ts は起動時の fullScan 完了を待たずに HTTP
// listen を開始するため、GET /api/board が 200 で空／部分的なロースターを
// 返した直後に既存エージェントの agent_update が届きうる。実サーバコードで
// 再現経路を確認済み）。この方式はクライアント側の推論だけでは原理的に安全性を
// 保証できない。そのため、真に「新規追加」であることを因果的に確定できる
// 信号——「＋ エージェント追加」フォームが実際に送信された瞬間（Board.tsx の
// submitAddAgent）——を新たに公開する markPendingNewAgent/clearPendingNewAgent
// （notifyAgentAddRequested/notifyAgentAddFailed）経由でレジストリに伝える
// 方式へ変更した。POST /api/fleet/agents という既存の HTTP 呼び出しに乗せて
// いるだけで、新しい WS 接続・ポーリングは追加していない（親 Issue #119
// クリティカル設計決定④）。
export type TerminalController = {
  prefill(agent: string, command: string): void;
  addAgent(name: string): void;
  /** Issue #125: agent 追加フォームの送信を起点に「新規」を確定させる。 */
  markPendingNewAgent(name: string): void;
  /** Issue #125: 上記マーク後に送信が失敗した場合、取り消す。 */
  clearPendingNewAgent(name: string): void;
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
 *
 * Issue #125: これに加えて、事前に notifyAgentAddRequested(name) でマークされた
 * 名前が初めてここに渡された場合に限り、TerminalPane 側で claude を一度だけ
 * prefill する（タブの展開・アクティブ化・接続確立を伴う）。マークが無い名前
 * （通常の agent_update・WS 再接続相当の重複呼び出し・サーバ起動直後の
 * fullScan によるキャッチアップ配信）では prefill は発火しない。
 */
export function notifyAgentAdded(name: string): void {
  currentController?.addAgent(name);
}

/**
 * 「＋ エージェント追加」フォームが実際に送信されたことを起点に、この name が
 * 次に notifyAgentAdded 経由で addAgent へ渡されたとき claude を一度だけ
 * prefill してよいとマークする（Issue #125）。Board.tsx の submitAddAgent から、
 * ネットワーク I/O を開始する前の最も早いタイミングで呼ぶことを想定する
 * （サーバは fleet 追記→scan→broadcastAgentUpdate まで完了してから HTTP
 * レスポンスを返すため、fetch() 成功後にマークすると WS 経由の agent_update が
 * レスポンスより先に届くレースで取り逃しうる）。未登録時は何もしない。
 */
export function notifyAgentAddRequested(name: string): void {
  currentController?.markPendingNewAgent(name);
}

/**
 * notifyAgentAddRequested でマークした後、実際の追加（POST /api/fleet/agents）が
 * 失敗した場合に呼び、マークを取り消す（Issue #125）。取り消さないと、同名の
 * 既存エージェント（例: 重複名エラー）が後で通常の agent_update を受け取った際に
 * 誤って新規追加と判定されうる。未登録時は何もしない。
 */
export function notifyAgentAddFailed(name: string): void {
  currentController?.clearPendingNewAgent(name);
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
