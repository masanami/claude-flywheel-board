import { useEffect, useRef, useState } from "react";
import type { Challenge, LogEntry } from "../board-types.ts";

type CardDetailModalProps = {
  challenge: Challenge;
  agentName: string;
  onClose: () => void;
};

type LogState =
  | { status: "loading" }
  | { status: "success"; entries: LogEntry[] }
  | { status: "error" };

// カード詳細モーダル（読み取り専用・NFR-01）: 台帳の全項目と作業ログタイムラインを
// 表示するのみで、編集・承認・実行等の操作ボタンは一切持たない。作業ログは
// GET /api/log?agent&challenge をモーダルを開いたタイミングでオンデマンド取得する。
//
// ネイティブ <dialog> + showModal() を採用し、フォーカストラップ・ESC・背景 inert は
// ブラウザ実装に委ねる（自前実装はしない）。「閉じるボタン」「ESC」「オーバーレイ
// （dialog 自身）クリック」の3経路はすべて dialog.close() → ネイティブの "close"
// イベントへ収束させ、そこで一度だけ onClose を呼ぶ。
export function CardDetailModal({
  challenge,
  agentName,
  onClose,
}: CardDetailModalProps) {
  const [logState, setLogState] = useState<LogState>({ status: "loading" });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mouseDownOnDialog = useRef(false);
  // onClose は呼び出し元（TaskCard）の再レンダーのたびに新しい関数参照になりうる。
  // dialog.showModal() の呼び出しはマウント時の1回だけにしたいため（既に開いている
  // dialog に showModal() を再度呼ぶと例外になる）、常に最新の onClose を参照できる
  // よう ref 経由で保持し、effect の依存配列には含めない。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // dialog を開き、close イベント（閉じるボタン / ESC / オーバーレイクリックの
  // いずれから来ても最終的にここへ集約する）を onClose に橋渡しする。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    dialog.showModal();

    const handleClose = () => {
      onCloseRef.current();
    };
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
    };
  }, []);

  // 作業ログのオンデマンド取得。
  useEffect(() => {
    let cancelled = false;
    setLogState({ status: "loading" });

    fetch(
      `/api/log?agent=${encodeURIComponent(agentName)}&challenge=${encodeURIComponent(challenge.id)}`,
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(`unexpected status: ${response.status}`);
        }
        return response.json() as Promise<LogEntry[]>;
      })
      .then((entries) => {
        if (!cancelled) {
          setLogState({ status: "success", entries });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLogState({ status: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentName, challenge.id]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: オーバーレイ（dialog 自身）のクリック閉じはポインタ操作のみの補助的な導線であり、キーボードでの閉じ方はネイティブ ESC ハンドリングで確保している
    <dialog
      ref={dialogRef}
      className="card-detail-modal"
      data-testid="modal-overlay"
      aria-labelledby="card-detail-modal-title"
      onMouseDown={(event) => {
        // 押下（mousedown）が dialog 自身（オーバーレイ相当）から始まった場合のみ
        // 「クリックで閉じる」候補として記録する。ダイアログ内で始めたテキスト
        // 選択ドラッグの終点が外側にずれても、誤って閉じないようにするため。
        mouseDownOnDialog.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (mouseDownOnDialog.current && event.target === event.currentTarget) {
          dialogRef.current?.close();
        }
        mouseDownOnDialog.current = false;
      }}
    >
      <div
        className="card-detail-modal-content"
        data-testid="card-detail-content"
      >
        <div className="card-detail-modal-header">
          <h2 id="card-detail-modal-title" className="card-detail-modal-title">
            {challenge.title}
          </h2>
          <button
            type="button"
            className="modal-close-button"
            onClick={() => dialogRef.current?.close()}
          >
            閉じる
          </button>
        </div>

        <dl className="card-detail-fields">
          <dt>ID</dt>
          <dd>{challenge.id}</dd>
          <dt>タイトル</dt>
          <dd>{challenge.title}</dd>
          <dt>ステータス</dt>
          <dd>{challenge.status}</dd>
          <dt>優先度</dt>
          <dd>{challenge.priority ?? "-"}</dd>
          <dt>担当ポジション</dt>
          <dd>{challenge.position ?? "-"}</dd>
          <dt>要対応</dt>
          <dd>{challenge.needsHuman ? "はい" : "いいえ"}</dd>
          <dt>要約</dt>
          <dd>{challenge.summary ?? "-"}</dd>
        </dl>

        <h3 className="card-detail-log-heading">作業ログ</h3>
        {logState.status === "loading" && (
          <div className="card-detail-log-loading">読み込み中...</div>
        )}
        {logState.status === "error" && (
          <div className="card-detail-log-error">
            作業ログの取得に失敗しました
          </div>
        )}
        {logState.status === "success" && (
          <div className="card-detail-log-timeline">
            {logState.entries.length === 0 ? (
              <div className="card-detail-log-empty">作業ログはありません</div>
            ) : (
              logState.entries.map((entry, index) => (
                <div className="log-entry-row" key={`${entry.ts}-${index}`}>
                  <span className="log-entry-ts">{entry.ts}</span>
                  <span className="log-source-badge" data-source={entry.source}>
                    {entry.source}
                  </span>
                  <span className="log-entry-text">{entry.text}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}
