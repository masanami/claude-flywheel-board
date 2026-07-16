import { useEffect, useState } from "react";
import type { AgentBoard } from "../board-types.ts";
import { connectBoardSocket } from "../ws.ts";
import { AgentColumn } from "./AgentColumn.tsx";
import type { BoardFilter } from "./FilterBar.tsx";
import { FilterBar } from "./FilterBar.tsx";

function buildWebSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function upsertAgent(agents: AgentBoard[], updated: AgentBoard): AgentBoard[] {
  const index = agents.findIndex((a) => a.name === updated.name);
  if (index === -1) {
    return [...agents, updated];
  }
  const next = [...agents];
  next[index] = updated;
  return next;
}

// トップレベルの状態管理（WS接続・snapshot/agent_update反映・フィルタ）。
// board は状態ファイルへ一切書き込まない（NFR-01）。本コンポーネントは
// 受信・表示のみを行い、サーバへメッセージを送る処理は持たない。
export function Board() {
  const [agents, setAgents] = useState<AgentBoard[] | undefined>(undefined);
  const [filter, setFilter] = useState<BoardFilter>("all");

  useEffect(() => {
    const socket = connectBoardSocket({
      url: buildWebSocketUrl(),
      onSnapshot: (board) => {
        setAgents(board.agents);
      },
      onAgentUpdate: (agent) => {
        setAgents((prev) => upsertAgent(prev ?? [], agent));
      },
    });

    return () => {
      socket.close();
    };
  }, []);

  if (agents === undefined) {
    return <div className="board-loading">読み込み中...</div>;
  }

  return (
    <div className="board">
      <FilterBar value={filter} onChange={setFilter} />
      <div className="board-columns">
        {agents.map((agent) => (
          <AgentColumn
            key={agent.name}
            agent={
              filter === "needsHuman"
                ? {
                    ...agent,
                    challenges: agent.challenges.filter((c) => c.needsHuman),
                  }
                : agent
            }
          />
        ))}
      </div>
    </div>
  );
}
