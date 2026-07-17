import { useState } from "react";
import type { AgentBoard } from "../board-types.ts";
import {
  type AdjacentChallenge,
  type Placement,
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
// handleDrop 側でもこのキーの有無を分岐に使う（isInsertOpen だけで分岐すると、
// ゴーストを開いた状態のまま外部テキスト/ファイル等の無関係なドラッグがドロップ
// された場合にも誤って prefill してしまうため、GHOST_DRAG_MIME の有無で
// 「実際にこのゴースト行から開始されたドラッグか」を確認する）。
const GHOST_DRAG_MIME = "application/x-flywheel-ghost";

// ドラッグ中の要素がどの行に重なっているかを示す識別子。
// "ghost" はゴーストカード自身の行、"bottom" はスタック末尾のドロップ領域、
// それ以外は課題ID。
type DropTargetKey = string | "ghost" | "bottom" | null;

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

  // スタック末尾のドロップ領域（#16 最下位への配置）向けの隣接カード。
  // 現在の最下位カードを指す。challenges が空の場合は隣接カードなし（最上位と
  // 同じ唯一の枠）として扱う。
  const lastChallenge = agent.challenges[agent.challenges.length - 1];
  const bottomAdjacent: AdjacentChallenge | undefined = lastChallenge
    ? { id: lastChallenge.id, priority: lastChallenge.priority }
    : undefined;

  const handleBottomDrop = (event: React.DragEvent<HTMLElement>) => {
    handleDrop(event, bottomAdjacent, bottomAdjacent ? "bottom" : "before");
  };

  const handleDrop = (
    event: React.DragEvent<HTMLElement>,
    adjacent: AdjacentChallenge | undefined,
    placement: Placement = "before",
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
        buildReorderInstruction(draggedChallengeId, adjacent, placement),
      );
      return;
    }

    // ゴースト由来のドロップかどうかは isInsertOpen だけでなく GHOST_DRAG_MIME
    // の有無でも確認する。ゴーストを開いた状態のまま外部テキスト/ファイル等の
    // 無関係なドラッグがドロップされても prefill してしまわないようにするため。
    if (isInsertOpen && event.dataTransfer.getData(GHOST_DRAG_MIME)) {
      // 空内容（trim 後に空文字）での差し込みは中止し、ゴーストを維持する。
      if (!insertContent.trim()) {
        return;
      }
      prefill(
        agent.name,
        buildInsertInstruction(insertContent, adjacent, placement),
      );
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
        <div
          className="agent-column-row agent-column-bottom-drop-zone"
          data-testid="agent-column-bottom-drop-zone"
          data-drop-target={dropTargetKey === "bottom" || undefined}
          onDragOver={(event) => {
            event.preventDefault();
            setDropTargetKey("bottom");
          }}
          onDragLeave={() =>
            setDropTargetKey((current) =>
              current === "bottom" ? null : current,
            )
          }
          onDrop={handleBottomDrop}
          onDragEnd={() => setDropTargetKey(null)}
        />
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
