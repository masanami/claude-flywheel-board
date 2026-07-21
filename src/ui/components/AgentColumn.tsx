import { useEffect, useRef, useState } from "react";
import type { AgentBoard, AgentCycleStatus, Run } from "../board-types.ts";
import { formatElapsed } from "../lib/format-elapsed.ts";
import {
  type AdjacentChallenge,
  type Placement,
  buildInsertInstruction,
  buildReorderInstruction,
} from "../lib/instruction.ts";
import {
  buildResumeCommand,
  isResumableDelegateRun,
} from "../lib/resume-command.ts";
import { prefill } from "../terminal-control.ts";
import { ErrorCard } from "./ErrorCard.tsx";
import {
  AGENT_NAME_DRAG_MIME,
  CHALLENGE_DRAG_MIME,
  type ReorderDirection,
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
// 実行中カードに操作ボタンは基本置かないが、応答なし（stale）の delegate
// 実行中セッションに限り「再開コマンドを挿入」ボタンを表示する（#31・FR-12）。
// クリティカル設計決定（親 #28 / #2）: prefill するのみで Enter 送信・自動実行
// はしない。
function RunningRunRow({ run, agentName }: { run: Run; agentName: string }) {
  const elapsed = formatElapsed(run.startedAt, new Date());
  // 再開ボタンの対象判定は isResumableDelegateRun に一元化する
  // （CardDetailModal 側の findStaleDelegateRun と判定基準を共有）。
  // resumeRepo に代入することで、以降の JSX では repo の truthy チェックが
  // そのまま TypeScript の型絞り込みとしても機能する（as string キャスト不要）。
  const resumeRepo = isResumableDelegateRun(run) ? run.repo : undefined;
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
      {resumeRepo && (
        <button
          type="button"
          className="agent-column-running-run-resume-button"
          onClick={() =>
            prefill(agentName, buildResumeCommand(resumeRepo, run.key))
          }
        >
          再開コマンドを挿入
        </button>
      )}
    </div>
  );
}

type AgentColumnProps = {
  agent: AgentBoard;
  // アーカイブビュー（Issue #50 ①）。true の間は agent.challenges ではなく
  // agent.archivedChallenges をミニマル表示（既存 TaskCard の流用）し、
  // 実行中セクション・並べ替え・差し込み等のライブ操作導線はすべて隠す。
  archiveMode?: boolean;
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
// キーボードでの並べ替え（#25）: 移動先を「スロット」0..N（N = challenges.length）
// で表現する。スロット i（i<N）は「現在の challenges[i] の直前に置く」、
// スロット N は「末尾（最下位）に置く」を意味する。並べ替え対象自身の位置に
// 戻ってしまう（結果的に何も変わらない）スロットは自動的にスキップする。
// basisAdjacentId / basisPlacement: スロット確定時に「読み上げた（＝ユーザーが
// 意図した）隣接課題」を固定するための基準値。並べ替えモード中に監視更新
// （fs-watch/WS）で challenges が挿入・並び替えされると、スロット番号自体は
// 範囲内・no-opでなくても、そのスロットが指す隣接課題の中身がすり替わる
// ことがある（CodeRabbit Major指摘 #1）。確定時にこの基準値と現在の
// challenges から導いた隣接課題を突き合わせ、一致しない場合はキャンセルする。
type ReorderState = {
  challengeId: string;
  slot: number;
  basisAdjacentId: string | undefined;
  basisPlacement: Placement;
} | null;

// スロット slot が対象カード自身（selfIndex）にとって no-op かどうか。
// slot === selfIndex（自分の直前に自分を置く）、
// slot === selfIndex + 1（自分を取り除いた直後の位置に戻すだけ）の
// いずれも見た目上の並びは変化しない。
function isNoOpSlot(slot: number, selfIndex: number): boolean {
  return slot === selfIndex || slot === selfIndex + 1;
}

// 現在のスロット current から direction 方向へ、no-op スロットを飛ばして
// 次に止まれるスロットを探す。範囲外（0未満・maxSlot超）に達したら、それ以上
// 進めないため current のまま返す（境界で足踏みする＝最上位/最下位で止まる）。
function findNextSlot(
  current: number,
  direction: 1 | -1,
  selfIndex: number,
  maxSlot: number,
): number {
  let candidate = current + direction;
  while (candidate >= 0 && candidate <= maxSlot) {
    if (!isNoOpSlot(candidate, selfIndex)) {
      return candidate;
    }
    candidate += direction;
  }
  return current;
}

export function AgentColumn({ agent, archiveMode }: AgentColumnProps) {
  const firstNeedsHumanIndex = agent.challenges.findIndex((c) => c.needsHuman);
  const [isInsertOpen, setIsInsertOpen] = useState(false);
  const [insertContent, setInsertContent] = useState("");
  const [dropTargetKey, setDropTargetKey] = useState<DropTargetKey>(null);
  const [reorderState, setReorderState] = useState<ReorderState>(null);
  // aria-live="polite" で読み上げる案内文（#25）。視覚的には非表示。
  const [liveMessage, setLiveMessage] = useState("");
  const ghostInputRef = useRef<HTMLInputElement | null>(null);
  // ゴースト破棄時（Escape・確定後）にフォーカスを戻す先（CodeRabbit Major
  // 指摘 #4）。ゴースト入力欄はゴーストの消滅と共に DOM から外れるため、
  // 何もしなければフォーカスが失われる（キーボード操作の連続性が途切れる）。
  const insertButtonRef = useRef<HTMLButtonElement | null>(null);

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
    // ゴースト入力欄は次の描画で DOM から消えるため、直前にフォーカスが
    // 無効化される前に「＋ 差し込み」ボタンへ明示的に戻す
    // （CodeRabbit Major指摘 #4）。
    insertButtonRef.current?.focus();
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

  // スロット slot（0..N）の読み上げ文を組み立てる（#25）。
  // 0=最上位、N=最下位、それ以外は「直前に置く隣接カードの上」を案内する。
  // 隣接カードの取得は既存の adjacentChallengeAt に揃える（D&D と同じ基準）。
  const describeReorderSlot = (slot: number, maxSlot: number): string => {
    if (slot === 0) {
      return "並べ替え: 最上位";
    }
    if (slot === maxSlot) {
      return "並べ替え: 最下位";
    }
    const adjacent = adjacentChallengeAt(slot);
    return adjacent
      ? `並べ替え: 移動先は${adjacent.id}の上`
      : "並べ替え: 最下位";
  };

  // スロット slot（0..maxSlot）が指す隣接課題＋配置を求める。並べ替えの
  // 「基準」記録（handleReorderMove）と確定時の再検証（handleReorderConfirm）
  // の両方で同じ導出ロジックを使うことで、両者のズレを防ぐ。
  const resolveSlotTarget = (
    slot: number,
    maxSlot: number,
  ): { adjacent: AdjacentChallenge | undefined; placement: Placement } => {
    if (slot === maxSlot) {
      return {
        adjacent: bottomAdjacent,
        placement: bottomAdjacent ? "bottom" : "before",
      };
    }
    return { adjacent: adjacentChallengeAt(slot), placement: "before" };
  };

  // Alt+ArrowUp/Down（#25）。まだ並べ替えモードでなければ開始し、既に対象
  // カードで並べ替えモード中ならそのまま移動先スロットを動かす。
  const handleReorderMove = (
    challengeId: string,
    direction: ReorderDirection,
  ) => {
    const selfIndex = agent.challenges.findIndex((c) => c.id === challengeId);
    if (selfIndex === -1) {
      return;
    }
    const maxSlot = agent.challenges.length;
    const alreadyReordering = reorderState?.challengeId === challengeId;
    const current = alreadyReordering ? reorderState.slot : selfIndex;
    const next = findNextSlot(
      current,
      direction === "up" ? -1 : 1,
      selfIndex,
      maxSlot,
    );
    if (next === current && !alreadyReordering) {
      // 移動できるスロットが1つも無い（例: カラムに要素が1件のみ）。
      // この場合は並べ替えモード自体を開始しない。
      return;
    }
    // このスロットが現時点で指している隣接課題を「基準」として記録する。
    // ユーザーがこの読み上げ（aria-live）を聞いて Enter を押す前提のため、
    // 確定時にはこの基準と現在の隣接課題が一致しているかを再検証する。
    const { adjacent, placement } = resolveSlotTarget(next, maxSlot);
    setReorderState({
      challengeId,
      slot: next,
      basisAdjacentId: adjacent?.id,
      basisPlacement: placement,
    });
    setLiveMessage(describeReorderSlot(next, maxSlot));
  };

  // 並べ替えモード中の Enter による確定（#25）。スロットを隣接カード＋
  // placement に変換し、既存の buildReorderInstruction → prefill 経路へ渡す。
  // challenges 配列自体は書き換えない（楽観更新禁止・NFR-01）。
  //
  // 安全弁1（範囲・no-op）: モード開始後に fs-watch 経由で agent.challenges
  // が変化している可能性があるため、確定の瞬間に selfIndex を必ず取り直し、
  // 保持していた slot が新しい配列上でも依然として有効（no-op でない）かを
  // isNoOpSlot で再検証する。無効化されていれば prefill せずモードだけ終了
  // する。
  //
  // 安全弁2（隣接課題の厳密な再検証・CodeRabbit Major指摘 #1）: 安全弁1の
  // 範囲・no-op チェックだけでは「スロット番号自体は依然有効だが、そのスロット
  // が指す隣接課題が挿入・並び替えにより別の課題にすり替わっている」ケースを
  // 検知できない。これを見逃すと、ユーザーが読み上げ（aria-live）で聞いた
  // 課題とは別の課題を基準にした指示文を生成してしまう。そのため、モード
  // 開始/移動時に記録した基準（basisAdjacentId/basisPlacement）と、確定時に
  // 現在の challenges から導いた隣接課題を突き合わせ、不一致ならキャンセル
  // 扱いにする。
  const handleReorderConfirm = (challengeId: string) => {
    if (!reorderState || reorderState.challengeId !== challengeId) {
      setReorderState(null);
      return;
    }
    const { slot, basisAdjacentId, basisPlacement } = reorderState;
    const selfIndex = agent.challenges.findIndex((c) => c.id === challengeId);
    const maxSlot = agent.challenges.length;
    setReorderState(null);
    if (selfIndex === -1 || slot > maxSlot || isNoOpSlot(slot, selfIndex)) {
      return;
    }
    const { adjacent, placement } = resolveSlotTarget(slot, maxSlot);
    if (adjacent?.id !== basisAdjacentId || placement !== basisPlacement) {
      setLiveMessage("カードの並びが変わったため並べ替えをキャンセルしました");
      return;
    }
    prefill(
      agent.name,
      buildReorderInstruction(challengeId, adjacent, placement),
    );
    // NFR-01: prefill はターミナルへの入力に留まり、実行（Enter 送信）は
    // 人間が行う。「移動しました」は完了済みと誤解させるため、未実行が
    // 伝わる文言にする（CodeRabbit Major指摘 #2）。
    setLiveMessage("並べ替え指示をターミナルに入力しました（Enter で実行）");
  };

  // 並べ替えモード中の Escape によるキャンセル（#25）。prefill せずモードだけ
  // 終了する。フォーカスはカード自身に残したままなので何もしなくてよい。
  const handleReorderCancel = () => {
    setReorderState(null);
    setLiveMessage("並べ替えをキャンセルしました");
  };

  // 並べ替えモード中に agent.challenges が変化した場合の整合性維持（#25）。
  // board は状態ファイルの fs-watch／WebSocket 経由で agent.challenges を
  // 常時最新化して再 props するため、並べ替えモード中（Enter/Escape で
  // 確定/キャンセルする前）に対象課題が消える・配列の並びが変わって保持中の
  // slot が no-op になる、といった事態が起こり得る。見えないまま
  // モードが残留し続ける（インジケータは消えるが isReordering は true の
  // まま＝素の Enter が誤って並べ替え確定に化ける）事故を防ぐため、
  // 無効化を検知したら静かにモードを終了する。
  useEffect(() => {
    if (!reorderState) {
      return;
    }
    const selfIndex = agent.challenges.findIndex(
      (c) => c.id === reorderState.challengeId,
    );
    const maxSlot = agent.challenges.length;
    if (
      selfIndex === -1 ||
      reorderState.slot > maxSlot ||
      isNoOpSlot(reorderState.slot, selfIndex)
    ) {
      setReorderState(null);
    }
  }, [agent.challenges, reorderState]);

  // アーカイブビュー（Issue #50 ①）: ライブ盤面（D&D 並べ替え・差し込み・実行中
  // セクション）とは独立した読み取り専用の表示に切り替える。すべてのフックは
  // 上で無条件に呼び出し済みのため、ここで早期 return しても Rules of Hooks に
  // 反しない。表示粒度はミニマル（既存 TaskCard をそのまま流用。id/title/status
  // 相当のみで、runningRuns 等ライブ専用の追加情報は渡さない）。
  if (archiveMode) {
    return (
      <section className="agent-column">
        <div className="agent-column-header">
          <h2 className="agent-column-title">{agent.name}</h2>
        </div>
        <div className="agent-column-body">
          {agent.archivedChallenges.map((challenge) => (
            <div key={challenge.id} className="agent-column-row-group">
              <div
                className="agent-column-row"
                data-testid={`agent-column-archive-row-${challenge.id}`}
              >
                <TaskCard
                  challenge={challenge}
                  agentName={agent.name}
                  readOnly
                />
              </div>
            </div>
          ))}
          {/* アーカイブ読み込みの非ENOENT 実エラー（権限不足等）も、アーカイブ
              表示中に気づけるよう当該ビューで可視化する（受入基準「非ENOENT の
              実エラーは可視化される」をライブ表示切替なしで満たす）。 */}
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
      {/* キーボードでの並べ替え（#25）の状態変化をスクリーンリーダーへ伝える、
          視覚的に隠れた読み上げ専用領域。見た目には一切影響しない。 */}
      <div
        aria-live="polite"
        data-testid="agent-column-live-region"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {liveMessage}
      </div>
      <div className="agent-column-header">
        <h2 className="agent-column-title">{agent.name}</h2>
        <CycleStatusIndicator cycleStatus={agent.cycleStatus} />
        <button
          ref={insertButtonRef}
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
              <RunningRunRow
                key={`${run.kind}:${run.key}`}
                run={run}
                agentName={agent.name}
              />
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
              // キーボードでの確定経路（#25）: Enter で既定位置（スタック先頭）
              // へ確定、Escape でゴーストを破棄する。D&D と同じ「空内容は
              // 無視」ガードを踏襲する。
              onKeyDown={(event) => {
                // IME変換中のガード（CodeRabbit Major指摘 #3）: 変換確定の
                // ために押した Enter が prefill 確定に化けたり、変換候補を
                // 打ち消すための Escape がゴースト破棄に化けたりしないよう、
                // isComposing 中はこのハンドラの対象キーを無視する。
                if (event.nativeEvent.isComposing) {
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!insertContent.trim()) {
                    return;
                  }
                  prefill(
                    agent.name,
                    buildInsertInstruction(
                      insertContent,
                      adjacentChallengeAt(0),
                      "before",
                    ),
                  );
                  closeGhost();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeGhost();
                }
              }}
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
              data-drop-target={
                dropTargetKey === challenge.id ||
                reorderState?.slot === index ||
                undefined
              }
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
              <TaskCard
                challenge={challenge}
                agentName={agent.name}
                runningRuns={agent.runningRuns}
                isReordering={reorderState?.challengeId === challenge.id}
                onReorderMove={(direction: ReorderDirection) =>
                  handleReorderMove(challenge.id, direction)
                }
                onReorderConfirm={() => handleReorderConfirm(challenge.id)}
                onReorderCancel={handleReorderCancel}
              />
            </div>
          </div>
        ))}
        <div
          className="agent-column-row agent-column-bottom-drop-zone"
          data-testid="agent-column-bottom-drop-zone"
          data-drop-target={
            dropTargetKey === "bottom" ||
            reorderState?.slot === agent.challenges.length ||
            undefined
          }
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
