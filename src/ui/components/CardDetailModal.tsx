import { type RefObject, useEffect, useRef, useState } from "react";
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

type DialogBodyProps = {
  challenge: Challenge;
  logState: LogState;
  closeButtonRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
};

// 台帳全項目＋作業ログタイムラインの表示本体。標準 <dialog> 要素は showModal() 前提の
// backdrop（::backdrop 疑似要素）を伴い、本コンポーネント独自の ESC・オーバーレイ
// クリック制御と噛み合わないため、role="dialog" + aria-modal を明示付与する div
// ベースの自前実装を採用する（フォーカストラップは実装しない。開いたら閉じるボタンへ
// フォーカスを移すのみ）。
function DialogBody({
  challenge,
  logState,
  closeButtonRef,
  onClose,
}: DialogBodyProps) {
  return (
    <div
      className="card-detail-modal"
      // biome-ignore lint/a11y/useSemanticElements: 上記コメントの通り、自前実装のため <dialog> 要素へは置き換えない
      role="dialog"
      aria-modal="true"
      aria-labelledby="card-detail-modal-title"
    >
      <div className="card-detail-modal-header">
        <h2 id="card-detail-modal-title" className="card-detail-modal-title">
          {challenge.title}
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          className="modal-close-button"
          onClick={onClose}
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
  );
}

// カード詳細モーダル（読み取り専用・NFR-01）: 台帳の全項目と作業ログタイムラインを
// 表示するのみで、編集・承認・実行等の操作ボタンは一切持たない。作業ログは
// GET /api/log?agent&challenge をモーダルを開いたタイミングでオンデマンド取得する。
export function CardDetailModal({
  challenge,
  agentName,
  onClose,
}: CardDetailModalProps) {
  const [logState, setLogState] = useState<LogState>({ status: "loading" });
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mouseDownOnOverlay = useRef(false);

  // フォーカス管理: モーダルを開いたら閉じるボタンへフォーカスを移す。
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  // ESC キーで閉じる。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

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
    // biome-ignore lint/a11y/useKeyWithClickEvents: オーバーレイのクリック閉じはポインタ操作のみの補助的な導線であり、キーボードでの閉じ方は ESC（上の useEffect）で確保している
    <div
      className="modal-overlay"
      data-testid="modal-overlay"
      onMouseDown={(event) => {
        // 押下（mousedown）がオーバーレイ自身から始まった場合のみ「クリックで閉じる」
        // 候補として記録する。ダイアログ内で始めたテキスト選択ドラッグの終点が
        // オーバーレイ側にずれても、誤って閉じないようにするため。
        mouseDownOnOverlay.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // オーバーレイ自身への押下＋クリックの両方が揃った場合のみ閉じる（内側の
        // モーダル本体へのクリックや、内側発のドラッグ選択では閉じない）。
        if (
          mouseDownOnOverlay.current &&
          event.target === event.currentTarget
        ) {
          onClose();
        }
        mouseDownOnOverlay.current = false;
      }}
    >
      <DialogBody
        challenge={challenge}
        logState={logState}
        closeButtonRef={closeButtonRef}
        onClose={onClose}
      />
    </div>
  );
}
