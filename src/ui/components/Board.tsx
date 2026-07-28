import { useEffect, useRef, useState } from "react";
import type { AgentBoard, Challenge, LedgerStatus } from "../board-types.ts";
import {
  type MdLiveChannel,
  createNoopMdLiveChannel,
} from "../md-live-channel.ts";
import { connectBoardSocket } from "../ws.ts";
import { AgentColumn } from "./AgentColumn.tsx";
import type { BoardFilter } from "./FilterBar.tsx";
import { FilterBar } from "./FilterBar.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";

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
  // アーカイブビュー（Issue #50 ①）。true の間は盤面全体をライブ台帳から
  // challenge-archive*.md 表示へ切り替える。default false。
  const [archiveMode, setArchiveMode] = useState(false);

  // Issue #70: PreviewPanel との橋渡し（md-live-channel.ts 参照）。Board が
  // 保有する唯一の WS 接続の subscribeMd/unsubscribeMd をそのまま転送し、
  // WS から届いた md_file_changed/md_subscribe_error は mdLive.handlers の
  // 現在の差し替え先へ転送するだけに留める（「一致するファイルか」の判定・
  // 再フェッチ・注記表示は PreviewPanel 側の責務）。
  const mdLiveRef = useRef<MdLiveChannel>(createNoopMdLiveChannel());

  useEffect(() => {
    const socket = connectBoardSocket({
      url: buildWebSocketUrl(),
      onSnapshot: (board) => {
        setAgents(board.agents);
      },
      onAgentUpdate: (agent) => {
        setAgents((prev) => upsertAgent(prev ?? [], agent));
      },
      onMdFileChanged: (message) => {
        mdLiveRef.current.handlers.onFileChanged?.(message);
      },
      onMdSubscribeError: (message) => {
        mdLiveRef.current.handlers.onSubscribeError?.(message);
      },
      // セルフレビュー指摘: WS は切断されると自動再接続するが、サーバ側の
      // 購読は接続単位で保持されるため、再接続後の新しい接続には以前の
      // md_subscribe が引き継がれない（無警告のままライブ更新が恒久的に
      // 止まる）。open に遷移するたび（初回接続・再接続の両方）に
      // onReconnected を呼び、PreviewPanel が選択中のファイルを再購読する
      // 機会を与える。
      onStatusChange: (status) => {
        if (status === "open") {
          mdLiveRef.current.handlers.onReconnected?.();
        }
      },
    });
    mdLiveRef.current.subscribe = socket.subscribeMd;
    mdLiveRef.current.unsubscribe = socket.unsubscribeMd;

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
        archiveMode={archiveMode}
        onArchiveModeChange={setArchiveMode}
      />
      {/* 右サイドパネル（PreviewPanel）は flex でボードカラム領域を圧縮して
          確保する（下部ターミナル領域の高さ・幅には一切影響しない。
          docs/features/markdown-preview.md「機能全体の設計」節）。この行
          （board-main-row）のみを横並びにし、FilterBar は従来通り縦積みの
          最上部に残す（#64）。 */}
      <div className="board-main-row">
        <div className="board-columns">
          {agents.map((agent) => (
            <AgentColumn
              key={agent.name}
              archiveMode={archiveMode}
              agent={
                archiveMode
                  ? agent
                  : {
                      ...agent,
                      challenges: visibleChallenges(
                        agent.challenges,
                        filter,
                        showCompleted,
                      ),
                      // 承認待ちフィルタ選択時は実行中セクションも隠す（P3-2）。
                      runningRuns:
                        filter === "needsHuman" ? [] : agent.runningRuns,
                    }
              }
            />
          ))}
        </div>
        <PreviewPanel mdLive={mdLiveRef.current} />
      </div>
    </div>
  );
}
