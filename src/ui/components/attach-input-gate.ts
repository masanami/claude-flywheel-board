// tmux は attach 時、既存ペインの内容（シェル起動時に p10k/zsh 等が発した端末
// 問い合わせシーケンスを含み得る）を再生する。xterm.js はその再生内容を通常の
// pty 出力として解釈し、DA1/DA2/DSR/OSC 等の問い合わせに対して自動応答を返す。
// xterm.js の onData は「この自動応答」と「ユーザーの実際のキー入力」を区別
// できないため、そのまま WS → pty へ転送すると、過去の問い合わせへの応答が
// 現在のシェルへの入力として扱われてしまう（#27 フォローアップ）。
//
// 本モジュールは、タブの attach（WS 接続）ごとに「ユーザーの実操作イベント」
// （ターミナル要素上の keydown / paste / IME 変換開始）が DOM 上で観測される
// まで onData→input 送信を抑止するためのゲート状態を提供する。実操作の検出は
// xterm の onData ではなく DOM イベントで行う（xterm の onData だけでは
// 自動応答と実操作を区別できないため）。
//
// 既知の限界: 検出対象は keydown / paste / compositionstart のみ。これらを
// 伴わない実操作（例: ドラッグ&ドロップによるテキスト投入）が attach 後最初の
// 操作だった場合、その1回分だけ抑止され得る。xterm.js は既定でドロップ
// ペーストを持たないため実害は小さいと判断し、安全側（抑止側）に倒している。

export type AttachInputGate = {
  /** ゲートが開いている（＝ユーザーの実操作を観測済み）なら true。false の間は input を送ってはいけない。 */
  isOpen(): boolean;
  /** attach・再接続のたびに呼び、ゲートを閉じ直す（再接続時も再生ノイズが起きるため）。 */
  reset(): void;
  /** イベント購読を解除する（接続の後始末時に呼ぶ）。 */
  dispose(): void;
};

const OPEN_TRIGGER_EVENT_TYPES = [
  "keydown",
  "paste",
  "compositionstart",
] as const;

export function createAttachInputGate(target: HTMLElement): AttachInputGate {
  let open = false;

  const openGate = () => {
    open = true;
  };

  // capture: true が必須。xterm.js は自身が open() 時にアタッチした内部
  // textarea（target の子孫）へ target/bubble フェーズで keydown リスナを貼り、
  // そこで同期的に onData を発火させる。ゲート側リスナを bubble で取ると、
  // 同一のキー入力イベントに対して「ゲートを開く」ことが「onData 発火」より
  // 後になり、attach 後最初の本物のキー入力そのものを取りこぼしてしまう。
  // capture フェーズは必ず target/bubble フェーズより先に実行されるため、
  // この順序問題を回避できる。
  for (const type of OPEN_TRIGGER_EVENT_TYPES) {
    target.addEventListener(type, openGate, { capture: true });
  }

  return {
    isOpen() {
      return open;
    },
    reset() {
      open = false;
    },
    dispose() {
      for (const type of OPEN_TRIGGER_EVENT_TYPES) {
        target.removeEventListener(type, openGate, { capture: true });
      }
    },
  };
}
