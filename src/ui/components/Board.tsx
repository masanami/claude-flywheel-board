import { useEffect, useState } from "react";
import type { AgentBoard, Challenge, LedgerStatus } from "../board-types.ts";
import { connectBoardSocket } from "../ws.ts";
import { AgentColumn } from "./AgentColumn.tsx";
import type { BoardFilter } from "./FilterBar.tsx";
import { FilterBar } from "./FilterBar.tsx";

// 完了ステータスのデフォルト非表示（Issue #50 ②）。防波堤としての表示フィルタ
// であり、台帳の書き込み・パース挙動には一切影響しない（NFR-01）。
const COMPLETED_STATUS: LedgerStatus = "完了";

// showCompleted トグルと needsHuman フィルタは互いに独立して適用する
// （needsHuman 選択時は元々 完了 が除外されているため実質的な効果は
// 「すべて」表示時に限られるが、組み合わせても破綻しないようにする）。
function visibleChallenges(
  challenges: Challenge[],
  filter: BoardFilter,
  showCompleted: boolean,
): Challenge[] {
  let result = challenges;
  if (!showCompleted) {
    result = result.filter((c) => c.status !== COMPLETED_STATUS);
  }
  if (filter === "needsHuman") {
    result = result.filter((c) => c.needsHuman);
  }
  return result;
}

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
  // 完了ステータスのデフォルト非表示（Issue #50 ②）。default false。
  const [showCompleted, setShowCompleted] = useState(false);

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
      <FilterBar
        value={filter}
        onChange={setFilter}
        showCompleted={showCompleted}
        onShowCompletedChange={setShowCompleted}
      />
      <div className="board-columns">
        {agents.map((agent) => (
          <AgentColumn
            key={agent.name}
            agent={{
              ...agent,
              challenges: visibleChallenges(
                agent.challenges,
                filter,
                showCompleted,
              ),
              // 承認待ちフィルタ選択時は実行中セクションも隠す（P3-2）。
              runningRuns: filter === "needsHuman" ? [] : agent.runningRuns,
            }}
          />
        ))}
      </div>
    </div>
  );
}
