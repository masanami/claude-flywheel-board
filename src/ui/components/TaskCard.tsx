import { useId, useRef, useState } from "react";
import type { Challenge } from "../board-types.ts";
import { CardDetailModal } from "./CardDetailModal.tsx";

type TaskCardProps = {
  challenge: Challenge;
  agentName: string;
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
export function TaskCard({ challenge, agentName }: TaskCardProps) {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
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
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onDragStart={(event) => {
          event.dataTransfer.setData(CHALLENGE_DRAG_MIME, challenge.id);
          event.dataTransfer.setData(AGENT_NAME_DRAG_MIME, agentName);
          event.dataTransfer.effectAllowed = "move";
        }}
        onClick={openModal}
        onKeyDown={(event) => {
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
        />
      )}
    </>
  );
}
