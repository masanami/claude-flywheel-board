import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ApprovalKind, Challenge, Run } from "../board-types.ts";
import {
  ApprovalControl,
  type ApproveSubmitResult,
} from "./ApprovalControl.tsx";
import { CardDetailModal } from "./CardDetailModal.tsx";

// ApprovalControl.tsx が正本（#171 で TaskCard から抽出）。既存の import 元
// （AgentColumn.tsx / Board.tsx / TaskCard.test.tsx 等）を張り替えず、この
// 再 export で従来どおり "./TaskCard.tsx" から参照できるようにしている。
export type { ApproveSubmitResult } from "./ApprovalControl.tsx";

// キーボードでの並べ替え（#25）で Alt+ArrowUp/Down が押された向き。
// AgentColumn 側で +1/-1 のスロット移動量に変換する。
export type ReorderDirection = "up" | "down";

type TaskCardProps = {
  challenge: Challenge;
  agentName: string;
  // AgentColumn の agent.runningRuns をそのまま中継する（#31・FR-12）。
  // CardDetailModal 側で対象課題に stale な delegate run があるかを判定する。
  runningRuns?: Run[];
  // このカードが現在「並べ替えモード」の対象かどうか（#25）。true の間は
  // 素の Enter を「モーダルを開く」ではなく「並べ替えを確定する」に切り替える。
  isReordering?: boolean;
  // Alt+ArrowUp/Down 押下の通知。並べ替えモードの開始・移動先スロットの
  // 移動はいずれも AgentColumn 側の状態として管理する（この値は isReordering
  // に関わらず常に呼ばれる。最初の Alt+矢印がモード開始を兼ねるため）。
  onReorderMove?: (direction: ReorderDirection) => void;
  // 並べ替えモード中の Enter による確定通知。
  onReorderConfirm?: () => void;
  // 並べ替えモード中の Escape によるキャンセル通知。
  onReorderCancel?: () => void;
  // 読み取り専用表示（アーカイブビュー #50 ①）。true のときドラッグ・並べ替え
  // といったライブ操作アフォーダンス（draggable / Alt+↑↓ ヒント）を抑止する。
  // アーカイブ側は並べ替えハンドラを結線しないため、これらは無反応の空振り
  // アフォーダンスになり、スクリーンリーダーへの誤告知にもなるため隠す。
  // クリックでの詳細モーダル表示（読み取り）は維持する。
  readOnly?: boolean;
  // 承認ボタン（#165・FR-20）の送信ハンドラ。未指定なら承認ボタンを描画しない
  // （アーカイブビュー等、承認導線を持たない呼び出し元のため）。
  onApprove?: (
    challengeId: string,
    kind: ApprovalKind,
  ) => Promise<ApproveSubmitResult>;
};

// D&D 並べ替え（#16）でドラッグ中の課題IDを伝搬するための dataTransfer キー。
// AgentColumn 側のドロップハンドラも同じキーで読み取る。
export const CHALLENGE_DRAG_MIME = "application/x-flywheel-challenge-id";

// ドラッグ元エージェント名を伝搬する dataTransfer キー。課題IDはエージェント内
// でのみ一意（architecture.md §3.3）なため、ドロップ先カラムのエージェント名と
// 突き合わせて「別カラムへの誤ドロップ」を弾く判定に使う。
export const AGENT_NAME_DRAG_MIME = "application/x-flywheel-agent-name";

// ツールチップとカードの間隔（px）。
const TOOLTIP_GAP = 6;
// 上出しの可否を判定するための想定高さ（px）。ツールチップは max-width 240px の
// 短文なので実測せずこの概算で足りる（外れても被るのは数px）。
const TOOLTIP_ESTIMATED_HEIGHT = 72;

// ツールチップの viewport 基準の配置。position: fixed で使う。
// 上出し（above）は bottom 基準にすることで、描画前に高さを測らずに済む。
type TooltipPosition =
  | { left: number; top: number; bottom?: undefined }
  | { left: number; bottom: number; top?: undefined };

function computeTooltipPosition(card: HTMLElement): TooltipPosition {
  const rect = card.getBoundingClientRect();
  // カード内padding（0.65rem）に合わせて左端を揃える。
  const left = rect.left + 10;
  // 上出しが収まる下限はカラム本体の上端。ここを越えるとカラムヘッダー
  //（"<エージェント名> idle ＋差し込み"）に被るので下出しへ回す（#41）。
  const columnBody = card.closest(".agent-column-body");
  const boundaryTop = columnBody ? columnBody.getBoundingClientRect().top : 0;
  if (rect.top - TOOLTIP_GAP - TOOLTIP_ESTIMATED_HEIGHT >= boundaryTop) {
    return { left, bottom: window.innerHeight - rect.top + TOOLTIP_GAP };
  }
  return { left, top: rect.bottom + TOOLTIP_GAP };
}

// カードの操作（#165 で FR-20 / NFR-01 の線引きを改訂）: ホバー/フォーカスで
// summary をツールチップ表示し、クリック/Enter で詳細モーダル（CardDetailModal）を
// 開く（#8）。モーダルは台帳の編集・実行など board が書き込みを行う操作導線を
// 承認だけを例外として持たない（次項・#171。再開コマンドのプリフィルは書き込み
// ではなく該当タブへの挿入に留まるため対象外）。
//
// 承認ボタン（FR-20 改訂）: **board 上の操作はすべて人間の操作として扱う**ため、
// 承認待ちカードには承認ボタンを置く。以前この位置には「新規のクリック可能な
// ボタン要素は増やさない（承認は対話のみ）」という制約を書いていたが、#165 で
// 線引きを「board が書くか否か」から「何を書くか」へ引き直したことにより撤回した。
// board が書いてよいのは NFR-01 の区分②（人間の入力）＝承認チェックボックスまでで、
// **区分③（ステータス・分類欄・journal・memory・runs.jsonl）には引き続き書かない**。
// この制約は server 側（ledger-approval.ts）で担保しており、UI からは種別
// （plan / completion）と対象課題 ID しか送らない。
//
// 誤操作対策: 承認は git コミットを伴い、押した瞬間に台帳へ反映される。カードは
// draggable でクリック領域が広いため、承認ボタンは**2 段階**（押す → 確認 → 承認）に
// する。1 クリック目では何も書き込まない。
//
// 承認 UI の実体（#171）: 判定・2段階フロー・エラー表示は ApprovalControl.tsx へ
// 抽出済み。CardDetailModal も同じコンポーネント・同じ onApprove を共有しており、
// board 上のどこから承認しても同一経路・同一 API（server 側は一切変更しない）。
//
// draggable（#16）: ドラッグ操作自体は「並べ替えの指示文生成 → prefill」の
// 起点にすぎず、台帳を書き換えるものではない（優先度の並べ替えの直接書き込み化は
// #165 でスコープ外と決定済み。requirements.md §3.2）。
export function TaskCard({
  challenge,
  agentName,
  runningRuns,
  isReordering,
  onReorderMove,
  onReorderConfirm,
  onReorderCancel,
  readOnly,
  onApprove,
}: TaskCardProps) {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // カードがフォーカス中のみ、並べ替えのキー操作ヒントを表示する（#25）。
  // ツールチップ表示（summary の有無に依存）とは独立に管理する。
  const [isFocused, setIsFocused] = useState(false);
  // ツールチップの位置決めはカード（コンテナ）の矩形を基準にする（#169）。
  // 内側のクリック領域ではなくコンテナを基準にすることで、承認ブロックを
  // 含めた高さで上下を判定でき、下出しのときに承認ボタンへ被らない。
  const cardRef = useRef<HTMLDivElement>(null);
  // モーダルを閉じたときのフォーカス復帰先。実際にフォーカスを受け取れるのは
  // 内側のクリック領域（.task-card-body）であってコンテナではない。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();

  // ツールチップは overflow をもつ .agent-column-body / .agent-column の外へ
  // portal し、position: fixed で配置する（#41）。カラム内に absolute のまま
  // 置くと z-index に関わらず overflow ボックスに切り取られるため。
  const [tooltipPosition, setTooltipPosition] =
    useState<TooltipPosition | null>(null);

  const updateTooltipPosition = useCallback(() => {
    if (cardRef.current) {
      setTooltipPosition(computeTooltipPosition(cardRef.current));
    }
  }, []);

  const showTooltip = () => {
    if (challenge.summary) {
      updateTooltipPosition();
      setIsTooltipVisible(true);
    }
  };
  const hideTooltip = () => setIsTooltipVisible(false);

  const openModal = () => setIsModalOpen(true);
  // モーダルを閉じる3経路（閉じるボタン / ESC / バックドロップクリック）は
  // すべて CardDetailModal の onClose 経由でここへ集約されるため、
  // トリガー（このカード）へのフォーカス復帰も一箇所にまとめられる。
  const closeModal = () => {
    setIsModalOpen(false);
    triggerRef.current?.focus();
  };

  const tooltipVisible = isTooltipVisible && Boolean(challenge.summary);

  // fixed 配置は viewport 基準なので、カラムのスクロールやウィンドウの
  // リサイズで追従させないとカードから離れてしまう。表示中のみ購読する。
  // scroll は capture で拾う（.agent-column-body のスクロールは bubble しない）。
  useEffect(() => {
    if (!tooltipVisible) {
      return;
    }
    window.addEventListener("scroll", updateTooltipPosition, true);
    window.addEventListener("resize", updateTooltipPosition);
    return () => {
      window.removeEventListener("scroll", updateTooltipPosition, true);
      window.removeEventListener("resize", updateTooltipPosition);
    };
  }, [tooltipVisible, updateTooltipPosition]);

  return (
    <>
      {/* カード（#169）: 「見た目のコンテナ」と「内側のクリック領域」に分ける。
       * 承認ボタンをカードの**中**へ置くために必要な分割で、こうしないと
       * <button> の入れ子（不正な HTML。キーボード操作と支援技術の挙動が壊れる）
       * になる。コンテナ自身はクリック不可の <div> で、操作（モーダル・ドラッグ・
       * キーボード並べ替え）はすべて内側の .task-card-body が持つ。 */}
      <div
        ref={cardRef}
        className="task-card"
        data-needs-human={challenge.needsHuman || undefined}
      >
        <button
          ref={triggerRef}
          type="button"
          className="task-card-body"
          draggable={!readOnly}
          aria-describedby={tooltipVisible ? tooltipId : undefined}
          onMouseEnter={showTooltip}
          onMouseLeave={hideTooltip}
          onFocus={() => {
            showTooltip();
            setIsFocused(true);
          }}
          onBlur={() => {
            hideTooltip();
            setIsFocused(false);
            // フォーカスを失った時点で並べ替えモード中なら、見えないまま
            // モードが残留する事故（#25 レビュー指摘）を防ぐため暗黙的に
            // キャンセルする。ヒント表示は blur で消えるが isReordering は
            // 呼び出し元（AgentColumn）の状態なので、ここで明示的に知らせる。
            if (isReordering) {
              onReorderCancel?.();
            }
          }}
          onDragStart={(event) => {
            if (readOnly) {
              return;
            }
            event.dataTransfer.setData(CHALLENGE_DRAG_MIME, challenge.id);
            event.dataTransfer.setData(AGENT_NAME_DRAG_MIME, agentName);
            event.dataTransfer.effectAllowed = "move";
          }}
          onClick={openModal}
          onKeyDown={(event) => {
            // キーボードでの並べ替え（#25）: Alt+ArrowUp/Down は isReordering の
            // 値に関わらず常に通知する（最初の押下がモード開始を兼ねるため、
            // 開始判定自体は呼び出し元の AgentColumn に委ねる）。
            // 読み取り専用（アーカイブ）では並べ替え自体を無効化する。
            if (
              !readOnly &&
              event.altKey &&
              (event.key === "ArrowUp" || event.key === "ArrowDown")
            ) {
              event.preventDefault();
              onReorderMove?.(event.key === "ArrowUp" ? "up" : "down");
              return;
            }
            if (isReordering) {
              // 並べ替えモード中は、素の Enter を「モーダルを開く」処理へ
              // 発火させてはならない（既存の openModal 分岐より先に確定/
              // キャンセルへ振り分ける）。
              if (event.key === "Enter") {
                event.preventDefault();
                onReorderConfirm?.();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onReorderCancel?.();
                return;
              }
            }
            if (event.key === "Enter") {
              event.preventDefault();
              openModal();
            }
          }}
        >
          <div className="task-card-title">{challenge.title}</div>
          <div className="task-card-meta">
            <span className="status-dot" data-status={challenge.status} />
            <span className="task-card-id">{challenge.id}</span>
            <span className="task-card-status">{challenge.status}</span>
            {challenge.position && (
              <span
                className="task-card-position"
                data-testid="task-card-position"
              >
                {challenge.position}
              </span>
            )}
          </div>
          {isFocused && !readOnly && (
            <div className="task-card-reorder-hint">Alt+↑/↓ で並べ替え</div>
          )}
        </button>
        <ApprovalControl
          challenge={challenge}
          readOnly={readOnly}
          onApprove={onApprove}
          className="task-card-approval"
        />
      </div>
      {tooltipVisible &&
        tooltipPosition &&
        createPortal(
          <div
            id={tooltipId}
            className="task-card-tooltip"
            role="tooltip"
            style={tooltipPosition}
          >
            {challenge.summary}
          </div>,
          document.body,
        )}
      {isModalOpen && (
        <CardDetailModal
          challenge={challenge}
          agentName={agentName}
          onClose={closeModal}
          runningRuns={runningRuns}
          readOnly={readOnly}
          onApprove={onApprove}
        />
      )}
    </>
  );
}
