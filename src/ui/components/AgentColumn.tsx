import type { AgentBoard } from "../board-types.ts";
import { ErrorCard } from "./ErrorCard.tsx";
import { TaskCard } from "./TaskCard.tsx";

type AgentColumnProps = {
  agent: AgentBoard;
};

// カラム＝1エージェント。ヘッダはエージェント名のみ（サイクル状態・実行中段は
// P3 スコープのためここでは実装しない）。challenges は既に呼び出し元
// （サーバの sortChallenges）でソート済みのため、そのままの順で描画する。
export function AgentColumn({ agent }: AgentColumnProps) {
  const firstNeedsHumanIndex = agent.challenges.findIndex((c) => c.needsHuman);

  return (
    <section className="agent-column">
      <h2 className="agent-column-header">{agent.name}</h2>
      <div className="agent-column-body">
        {agent.challenges.map((challenge, index) => (
          <div key={challenge.id}>
            {index === firstNeedsHumanIndex && (
              <div className="agent-column-needs-human-heading">
                🔔 承認待ち
              </div>
            )}
            <TaskCard challenge={challenge} agentName={agent.name} />
          </div>
        ))}
        {agent.parseErrors.map((error) => (
          <ErrorCard
            key={`${error.file}:${error.line ?? "?"}:${error.raw}`}
            error={error}
          />
        ))}
      </div>
    </section>
  );
}
