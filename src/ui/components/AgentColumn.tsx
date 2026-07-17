import { useState } from "react";
import type { AgentBoard } from "../board-types.ts";
import {
  type AdjacentChallenge,
  buildInsertInstruction,
  buildReorderInstruction,
} from "../lib/instruction.ts";
import { prefill } from "../terminal-control.ts";
import { ErrorCard } from "./ErrorCard.tsx";
import {
  AGENT_NAME_DRAG_MIME,
  CHALLENGE_DRAG_MIME,
  TaskCard,
} from "./TaskCard.tsx";

type AgentColumnProps = {
  agent: AgentBoard;
};

// ゴーストカードのドラッグを識別する dataTransfer キー
// （既存カードの CHALLENGE_DRAG_MIME と区別するため別キーにする）。
// Firefox は dragstart ハンドラ内で setData を呼ばないとドラッグ操作自体が
// 開始されないため、このキー自体は handleDrop 側で読み取って分岐には使わない
// （分岐は isInsertOpen で行う）が、ドラッグ開始の実ブラウザ挙動保証として残す。
const GHOST_DRAG_MIME = "application/x-flywheel-ghost";

// ドラッグ中の要素がどの行に重なっているかを示す識別子。
// "ghost" はゴーストカード自身の行、それ以外は課題ID。
type DropTargetKey = string | "ghost" | null;

// カラム＝1エージェント。ヘッダはエージェント名のみ（サイクル状態・実行中段は
// P3 スコープのためここでは実装しない）。challenges は既に呼び出し元
// （サーバの sortChallenges）でソート済みのため、そのままの順で描画する。
//
// D&D 並べ替え・「＋差し込み」ゴースト（#16）: board は台帳を書かない（NFR-01）。
// ドロップ確定で行うのは「指示文の生成 → prefill」のみであり、challenges 配列
// 自体を並べ替えるような楽観更新は行わない（渡された順のまま描画し続け、実際の
// 並び替えは台帳更新の fs-watch 反映を待つ）。
export function AgentColumn({ agent }: AgentColumnProps) {
  const firstNeedsHumanIndex = agent.challenges.findIndex((c) => c.needsHuman);
  const [isInsertOpen, setIsInsertOpen] = useState(false);
  const [insertContent, setInsertContent] = useState("");
  const [dropTargetKey, setDropTargetKey] = useState<DropTargetKey>(null);

  const closeGhost = () => {
    setIsInsertOpen(false);
    setInsertContent("");
  };

  // 隣接カード（ドロップ先の直下に来る既存カード）を、行のインデックスから求める。
  // 該当する既存カードが無い場合（＝隣接カードなし＝最優先位置）は undefined。
  const adjacentChallengeAt = (
    index: number,
  ): AdjacentChallenge | undefined => {
    const target = agent.challenges[index];
    if (!target) {
      return undefined;
    }
    return { id: target.id, priority: target.priority };
  };

  const handleDrop = (
    event: React.DragEvent<HTMLElement>,
    adjacent: AdjacentChallenge | undefined,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTargetKey(null);

    const draggedChallengeId = event.dataTransfer.getData(CHALLENGE_DRAG_MIME);
    if (draggedChallengeId) {
      // 課題IDはエージェント内でのみ一意（architecture.md §3.3）。ドラッグ元と
      // ドロップ先カラムのエージェントが異なる場合は誤った課題を指す指示文に
      // なるため、並べ替えとして扱わずに無視する（カラム跨ぎの D&D は非対応）。
      const draggedAgentName = event.dataTransfer.getData(AGENT_NAME_DRAG_MIME);
      if (draggedAgentName !== agent.name) {
        return;
      }
      // 自分自身の行へのドロップは意味を持たないため無視する。
      if (draggedChallengeId === adjacent?.id) {
        return;
      }
      prefill(
        agent.name,
        buildReorderInstruction(draggedChallengeId, adjacent),
      );
      return;
    }

    if (isInsertOpen) {
      prefill(agent.name, buildInsertInstruction(insertContent, adjacent));
      closeGhost();
    }
  };

  return (
    <section className="agent-column">
      <div className="agent-column-header">
        <h2 className="agent-column-title">{agent.name}</h2>
        <button
          type="button"
          className="agent-column-insert-button"
          onClick={() => (isInsertOpen ? closeGhost() : setIsInsertOpen(true))}
        >
          ＋ 差し込み
        </button>
      </div>
      <div className="agent-column-body">
        {isInsertOpen && (
          <div
            className="agent-column-row agent-column-ghost-row"
            data-testid="agent-column-ghost-row"
            draggable
            data-drop-target={dropTargetKey === "ghost" || undefined}
            onDragStart={(event) => {
              event.dataTransfer.setData(GHOST_DRAG_MIME, "1");
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTargetKey("ghost");
            }}
            onDragLeave={() =>
              setDropTargetKey((current) =>
                current === "ghost" ? null : current,
              )
            }
            onDrop={(event) => handleDrop(event, adjacentChallengeAt(0))}
            onDragEnd={() => setDropTargetKey(null)}
          >
            <input
              type="text"
              className="agent-column-ghost-input"
              placeholder="課題の内容"
              value={insertContent}
              onChange={(event) => setInsertContent(event.target.value)}
              // 親行が draggable のため、テキスト選択・カーソル移動のドラッグ操作が
              // 行のドラッグ開始と競合しないよう入力欄自体は draggable にしない。
              draggable={false}
            />
            <p className="agent-column-ghost-hint">
              ドラッグで位置＝優先度を指定
            </p>
          </div>
        )}
        {agent.challenges.map((challenge, index) => (
          <div
            key={challenge.id}
            className="agent-column-row"
            data-testid={`agent-column-row-${challenge.id}`}
            data-drop-target={dropTargetKey === challenge.id || undefined}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTargetKey(challenge.id);
            }}
            onDragLeave={() =>
              setDropTargetKey((current) =>
                current === challenge.id ? null : current,
              )
            }
            onDrop={(event) => handleDrop(event, adjacentChallengeAt(index))}
            onDragEnd={() => setDropTargetKey(null)}
          >
            {index === firstNeedsHumanIndex && (
              <h3 className="agent-column-needs-human-heading">🔔 承認待ち</h3>
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
