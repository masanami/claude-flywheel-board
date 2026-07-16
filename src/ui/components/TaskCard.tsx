import type { Challenge } from "../board-types.ts";

type TaskCardProps = {
  challenge: Challenge;
};

// 観測専用カード（NFR-01）: 状態を変更するボタン・書き込み系の操作は一切持たない。
// カード詳細モーダル・ホバー要約は別チケット #8 のスコープ（本コンポーネントでは未実装）。
export function TaskCard({ challenge }: TaskCardProps) {
  return (
    <div
      className="task-card"
      data-needs-human={challenge.needsHuman || undefined}
    >
      <div className="task-card-title">{challenge.title}</div>
      <div className="task-card-meta">
        <span className="status-dot" data-status={challenge.status} />
        <span className="task-card-id">{challenge.id}</span>
        <span className="task-card-status">{challenge.status}</span>
        {challenge.position && (
          <span className="task-card-position" data-testid="task-card-position">
            {challenge.position}
          </span>
        )}
      </div>
    </div>
  );
}
