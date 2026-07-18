import { useEffect, useRef, useState } from "react";
import type { AgentBoard, AgentCycleStatus, Run } from "../board-types.ts";
import { formatElapsed } from "../lib/format-elapsed.ts";
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

// カラムヘッダのサイクル状態表示（P3-2）。cycleStatus は cache.ts の
// getSnapshot が都度算出する値で、board 側は表示するだけ（NFR-01）。
const CYCLE_STATUS_LABEL: Record<AgentCycleStatus, string> = {
  running: "サイクル実行中",
  idle: "idle",
  stale: "⚠ 応答なし",
};

function CycleStatusIndicator({
  cycleStatus,
}: {
  cycleStatus: AgentCycleStatus | undefined;
}) {
  const status = cycleStatus ?? "idle";
  return (
    <span className="agent-column-cycle-status" data-cycle-status={status}>
      <span className="agent-column-cycle-status-dot" aria-hidden="true" />
      {CYCLE_STATUS_LABEL[status]}
    </span>
  );
}

// 実行中セクション（P3-2）: runningRuns（kind: delegate | adhoc の実行中 Run
// のみ。cycle は cycleStatus 側で表現するためサーバ側で除外済み）を表示する。
// 実行中カードに操作ボタンは一切置かない（resume ボタン等は別チケット #31）。
function RunningRunRow({ run }: { run: Run }) {
  const elapsed = formatElapsed(run.startedAt, new Date());
  return (
    <div
      className="agent-column-running-run"
      data-testid={`running-run-${run.key}`}
      data-stale={run.stale || undefined}
    >
      <div className="agent-column-running-run-subject">
        {run.kind === "delegate" ? (
          <>
            <span className="agent-column-running-run-challenge">
              {run.challenge}
            </span>
            <span className="agent-column-running-run-arrow">→ {run.repo}</span>
          </>
        ) : (
          <span className="agent-column-running-run-title">{run.title}</span>
        )}
      </div>
      <span className="agent-column-running-run-elapsed">{elapsed}</span>
      {run.stale && (
        <div className="agent-column-running-run-stale-warning">
          ⚠ 応答なし（要確認）
        </div>
      )}
    </div>
  );
}

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

// カラム＝1エージェント。ヘッダにはエージェント名＋サイクル状態
// （CycleStatusIndicator）を表示する。challenges は既に呼び出し元
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
  const ghostInputRef = useRef<HTMLInputElement | null>(null);

  // ゴースト表示直後、フォーカスが直前の要素（ターミナル等）に残ったままだと
  // タイプした文字がそちらへ流れてしまう（#27）。表示された瞬間に入力欄へ
  // フォーカスを移すことで、素直にタイプを続けられるようにする。
  // 注: JSX の autoFocus 属性は biome の a11y ルールでエラーになるため、
  // useEffect + ref で明示的に focus() する。
  useEffect(() => {
    if (isInsertOpen) {
      ghostInputRef.current?.focus();
    }
  }, [isInsertOpen]);

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
        <CycleStatusIndicator cycleStatus={agent.cycleStatus} />
        <button
          type="button"
          className="agent-column-insert-button"
          onClick={() => (isInsertOpen ? closeGhost() : setIsInsertOpen(true))}
        >
          ＋ 差し込み
        </button>
      </div>
      <div className="agent-column-body">
        {agent.runningRuns && agent.runningRuns.length > 0 && (
          <section className="agent-column-running-section">
            <h3 className="agent-column-running-heading">⚡ 実行中</h3>
            {agent.runningRuns.map((run) => (
              <RunningRunRow key={`${run.kind}:${run.key}`} run={run} />
            ))}
          </section>
        )}
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
              ref={ghostInputRef}
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
          <div key={challenge.id} className="agent-column-row-group">
            {index === firstNeedsHumanIndex && (
              <h3 className="agent-column-needs-human-heading">🔔 承認待ち</h3>
            )}
            <div
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
              <TaskCard challenge={challenge} agentName={agent.name} />
            </div>
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
