import { useId, useRef, useState } from "react";
import type { Challenge, Run } from "../board-types.ts";
import { CardDetailModal } from "./CardDetailModal.tsx";

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
};

// D&D 並べ替え（#16）でドラッグ中の課題IDを伝搬するための dataTransfer キー。
// AgentColumn 側のドロップハンドラも同じキーで読み取る。
export const CHALLENGE_DRAG_MIME = "application/x-flywheel-challenge-id";

// ドラッグ元エージェント名を伝搬する dataTransfer キー。課題IDはエージェント内
// でのみ一意（architecture.md §3.3）なため、ドロップ先カラムのエージェント名と
// 突き合わせて「別カラムへの誤ドロップ」を弾く判定に使う。
export const AGENT_NAME_DRAG_MIME = "application/x-flywheel-agent-name";

// 観測専用カード（NFR-01）: 状態を変更する実ボタン・書き込み系の操作は一切持たない。
// ホバー/フォーカスで summary をツールチップ表示し、クリック/Enter で読み取り専用の
// 詳細モーダル（CardDetailModal）を開く（#8）。
//
// draggable（#16）: ドラッグ操作自体は「並べ替えの指示文生成 → prefill」の
// 起点にすぎず、台帳を書き換えるものではない（NFR-01）。承認待ちカード
// （needsHuman）も観測対象として draggable にするが、新規のクリック可能な
// ボタン要素は増やさない（FR-20 の趣旨＝承認は対話のみ、を維持）。
export function TaskCard({
  challenge,
  agentName,
  runningRuns,
  isReordering,
  onReorderMove,
  onReorderConfirm,
  onReorderCancel,
}: TaskCardProps) {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  // カードがフォーカス中のみ、並べ替えのキー操作ヒントを表示する（#25）。
  // ツールチップ表示（summary の有無に依存）とは独立に管理する。
  const [isFocused, setIsFocused] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();

  const showTooltip = () => {
    if (challenge.summary) {
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="task-card"
        draggable
        data-needs-human={challenge.needsHuman || undefined}
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
          event.dataTransfer.setData(CHALLENGE_DRAG_MIME, challenge.id);
          event.dataTransfer.setData(AGENT_NAME_DRAG_MIME, agentName);
          event.dataTransfer.effectAllowed = "move";
        }}
        onClick={openModal}
        onKeyDown={(event) => {
          // キーボードでの並べ替え（#25）: Alt+ArrowUp/Down は isReordering の
          // 値に関わらず常に通知する（最初の押下がモード開始を兼ねるため、
          // 開始判定自体は呼び出し元の AgentColumn に委ねる）。
          if (
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
        {isFocused && (
          <div className="task-card-reorder-hint">Alt+↑/↓ で並べ替え</div>
        )}
        {tooltipVisible && (
          <div id={tooltipId} className="task-card-tooltip" role="tooltip">
            {challenge.summary}
          </div>
        )}
      </button>
      {isModalOpen && (
        <CardDetailModal
          challenge={challenge}
          agentName={agentName}
          onClose={closeModal}
          runningRuns={runningRuns}
        />
      )}
    </>
  );
}
