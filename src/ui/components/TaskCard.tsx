import { useState } from "react";
import type { Challenge } from "../board-types.ts";
import { CardDetailModal } from "./CardDetailModal.tsx";

type TaskCardProps = {
  challenge: Challenge;
  agentName: string;
};

// 観測専用カード（NFR-01）: 状態を変更する実ボタン・書き込み系の操作は一切持たない。
// ホバー/フォーカスで summary をツールチップ表示し、クリック/Enter で読み取り専用の
// 詳細モーダル（CardDetailModal）を開く（#8）。
export function TaskCard({ challenge, agentName }: TaskCardProps) {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const showTooltip = () => {
    if (challenge.summary) {
      setIsTooltipVisible(true);
    }
  };
  const hideTooltip = () => setIsTooltipVisible(false);

  const openModal = () => setIsModalOpen(true);
  const closeModal = () => setIsModalOpen(false);

  return (
    <>
      <button
        type="button"
        className="task-card"
        data-needs-human={challenge.needsHuman || undefined}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
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
        {isTooltipVisible && challenge.summary && (
          <div className="task-card-tooltip" role="tooltip">
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
