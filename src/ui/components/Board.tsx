import { useEffect, useRef, useState } from "react";
import type { AgentBoard, Challenge, LedgerStatus } from "../board-types.ts";
import {
  type MdLiveChannel,
  createNoopMdLiveChannel,
} from "../md-live-channel.ts";
import {
  notifyAgentAddFailed,
  notifyAgentAddRequested,
  notifyAgentAdded,
} from "../terminal-control.ts";
import { connectBoardSocket } from "../ws.ts";
import type { AddAgentInput, AddAgentSubmitResult } from "./AddAgentForm.tsx";
import { AddAgentForm } from "./AddAgentForm.tsx";
import { AgentColumn } from "./AgentColumn.tsx";
import type { BoardFilter } from "./FilterBar.tsx";
import { FilterBar } from "./FilterBar.tsx";
import type { PreviewPanelOpenRequest } from "./PreviewPanel.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";

// 完了ステータスのデフォルト非表示（Issue #50 ②）。防波堤としての表示フィルタ
// であり、台帳の書き込み・パース挙動には一切影響しない（NFR-01）。
const COMPLETED_STATUS: LedgerStatus = "完了";

// Issue #135: 優先度方針バッジのクリックで、既存の md プレビューパネルへ
// priority-policy.md を開く。ファイル名はエージェントワークスペース直下
// 固定（正本: src/server/watcher.ts の PRIORITY_POLICY_FILE_NAME・
// claude-flywheel 側 masanami/claude-flywheel#75 / PR #76
// templates/priority-policy.md）。UI 側は server の value export を
// 直接 import しない（server コード（node:fs 等）がブラウザバンドルへ
// 混入するのを避けるための既存方針。board-types.ts 冒頭コメント参照）ため、
// ここにローカル定数として重複させる。ドリフト検知は Board.test.tsx の
// 専用テスト（server 側の同名定数との一致を確認）に委ねる（セルフレビュー
// 指摘対応）。
export const PRIORITY_POLICY_FILE_NAME = "priority-policy.md";

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

// エージェント追加フォームの送信ハンドラ（Issue #124）。POST /api/fleet/agents
// を叩くのみで、成功応答の body を使って agents state を直接更新することは
// しない（二重更新の防止）。サーバ側（src/server/api.ts の該当ハンドラ）は
// 追加成功時に addFleetEntry → fleetWatcher.addAgentWatch の内部で scan・
// broadcastAgentUpdate まで行い WS agent_update を配信するため、新カラムの
// 出現は既存の onAgentUpdate → upsertAgent 経路が自然に処理する。
//
// board が実行するのは HTTP 呼び出しのみであり、fs への書き込みは行わない。
// fleet.tsv への書き込みはサーバ側 API の境界内で完結している（NFR-01 の
// 対象はエージェントの状態ファイル＝台帳・journal・memory・runs.jsonl であり、
// board 自身の設定である fleet.tsv・エージェント用ディレクトリ作成はその対象外
// という整理は親 Issue #119 系列で確定し、docs/requirements.md・
// docs/architecture.md に反映済み）。
//
// Issue #125（設計の経緯は terminal-control.ts 冒頭コメントが正本）:
// このフォーム送信こそが
// 「新規エージェントが追加された」ことを因果的に確定できる唯一の瞬間である
// ため、notifyAgentAddRequested(input.name) をここで呼び、TerminalPane 側へ
// 「次にこの名前が agent_update で届いたら claude を一度だけ prefill してよい」
// と伝える。fetch() を開始する前（ネットワーク I/O 前）に呼ぶのは、サーバが
// fleet 追記→scan→broadcastAgentUpdate まで完了してから HTTP レスポンスを
// 返すため（src/server/api.ts の `POST /api/fleet/agents` ハンドラ:
// `await addFleetEntry(...)` の内部で scan・broadcastAgentUpdate まで行った
// 後に `return c.json(...)` している）、fetch 成功後にマークすると
// WS 経由の agent_update がこの関数のレスポンスより先にブラウザへ届くレースで
// 取り逃しうるため。送信が失敗した場合（この name のエージェントは作られない）
// は notifyAgentAddFailed で確実にマークを取り消す（取り消さないと、同名の
// 既存エージェントが後で通常の agent_update を受け取った際に誤って新規追加と
// 判定され、稼働中セッションへ claude を誤 prefill しうる）。新しい WS 接続・
// ポーリングは追加していない（既存の POST /api/fleet/agents 呼び出しに乗せて
// いるだけ。親 Issue #119 クリティカル設計決定④）。
async function submitAddAgent(
  input: AddAgentInput,
): Promise<AddAgentSubmitResult> {
  notifyAgentAddRequested(input.name);

  let response: Response;
  try {
    response = await fetch("/api/fleet/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    notifyAgentAddFailed(input.name);
    return {
      ok: false,
      error: "エージェントの追加に失敗しました（通信エラー）",
    };
  }

  if (response.ok) {
    return { ok: true };
  }

  notifyAgentAddFailed(input.name);
  let error = `エージェントの追加に失敗しました（status: ${response.status}）`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error !== "") {
      error = body.error;
    }
  } catch {
    // レスポンスボディが JSON でない場合はフォールバックメッセージのまま。
  }
  return { ok: false, error };
}

// 新規エージェント追加フォームのパス欄初期値。ブラウザの JS からは OS の
// ホームディレクトリを取得できないため、既存 fleet エージェントのうち
// 絶対パスを持つ最初の1件（fleet.tsv の記載順。fleet.tsv 自体は既存エントリの
// 相対パスも許容するため、先頭が相対パスの場合はスキップして次を見る。
// src/server/manifest.ts 参照）の実際の絶対パス（AgentBoard.path）から
// 親ディレクトリを算出して使う（"~" のハードコードはサーバ側の絶対パス限定
// バリデーションと必ず不整合になる。AddAgentForm.tsx 冒頭コメント参照）。
// あくまで手動編集可能な補完ヒントであり、fleet 全体の最長共通接頭辞等の
// 厳密な算出は行わない（YAGNI）。絶対パスを持つ既存エージェントが1件も
// 無い場合は空文字を返し、パス欄は空のまま始まる（ユーザーが絶対パスを
// 直接入力する）。
function computeBasePathHint(agents: AgentBoard[]): string {
  const withAbsolutePath = agents.find((a) => a.path.startsWith("/"));
  if (!withAbsolutePath) {
    return "";
  }
  // セルフレビュー指摘: fleet.tsv は人間が手書きする設定ファイルで、読み込み時の
  // 正規化は trim のみ（src/server/manifest.ts）のため、末尾に "/" が残った
  // パスがそのまま AgentBoard.path に載りうる。末尾スラッシュを除去せずに
  // lastIndexOf("/") で親ディレクトリを算出すると、既存エージェント自身の
  // ディレクトリを親ディレクトリと誤認し、その配下に新規エージェント用の
  // ディレクトリ・git init が作られてしまう（既存エージェントの観測に影響
  // しないという AC-3 を損なう）。
  const trimmedPath = withAbsolutePath.path.replace(/\/+$/, "");
  const separatorIndex = trimmedPath.lastIndexOf("/");
  return separatorIndex <= 0 ? "/" : trimmedPath.slice(0, separatorIndex);
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
// board は状態ファイル（台帳・journal・memory・runs.jsonl）へは一切書き込まない
// （NFR-01）。サーバへの書き込み要求は、自分自身の設定である fleet.tsv への
// 追記を行う POST /api/fleet/agents（submitAddAgent。Issue #124）に限る
// （NFR-01 と fleet.tsv 書き込みの境界整理は submitAddAgent 直上のコメント
// 参照）。それ以外のデータ（台帳の課題等）は WS 経由の受信・表示のみを行う。
export function Board() {
  const [agents, setAgents] = useState<AgentBoard[] | undefined>(undefined);
  const [filter, setFilter] = useState<BoardFilter>("all");
  // 完了ステータスのデフォルト非表示（Issue #50 ②）。default false。
  const [showCompleted, setShowCompleted] = useState(false);
  // アーカイブビュー（Issue #50 ①）。true の間は盤面全体をライブ台帳から
  // challenge-archive*.md 表示へ切り替える。default false。
  const [archiveMode, setArchiveMode] = useState(false);
  // 「＋ エージェント追加」フォームの開閉状態（Issue #123）。
  const [addAgentFormOpen, setAddAgentFormOpen] = useState(false);

  // 優先度方針バッジ→プレビュー接続（Issue #135）。PreviewPanel 側は
  // openRequest.requestId の変化のみをトリガーに開閉・選択ファイルを
  // 切り替える（セルフレビュー指摘対応: 当初はオブジェクト参照の変化
  // （Object.is 不一致）に依存していたが、それは型で強制できない暗黙の
  // 呼び出し規約だった。requestId を型に持たせ「クリックのたびに単調増加
  // させる」という契約を明示することで、将来 openRequest がメモ化されても
  // requestId さえ増分すれば確実に再発火する）。
  const policyPreviewRequestIdRef = useRef(0);
  const [policyPreviewRequest, setPolicyPreviewRequest] =
    useState<PreviewPanelOpenRequest | null>(null);
  const handleOpenPriorityPolicy = (agentName: string) => {
    policyPreviewRequestIdRef.current += 1;
    setPolicyPreviewRequest({
      repo: agentName,
      path: PRIORITY_POLICY_FILE_NAME,
      requestId: policyPreviewRequestIdRef.current,
    });
  };

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
        // セルフレビュー指摘（Issue #124）: TerminalPane は mount 時に1回だけ
        // /api/board を読んでタブ一覧を確定しており、Board が保有する WS
        // agent_update を購読していない。そのため、agents state の更新だけでは
        // 新規エージェントのターミナルタブが board 再起動なしで出現しない。
        // 新しい WS 接続・ポーリングを追加せず（親 Issue #119 クリティカル
        // 設計決定）に解消するため、prefill と同じ疎結合レジストリ
        // （terminal-control.ts）経由で TerminalPane 側のタブ一覧へ反映する。
        // 既に一覧にある名前は TerminalPane 側で無視される（冪等）ため、
        // 新規追加以外の通常の agent_update（既存エージェントの状態更新）でも
        // 無条件に呼んでよい。
        notifyAgentAdded(agent.name);
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
        onAddAgentClick={() => setAddAgentFormOpen(true)}
      />
      {addAgentFormOpen && (
        <AddAgentForm
          onClose={() => setAddAgentFormOpen(false)}
          onSubmit={submitAddAgent}
          basePath={computeBasePathHint(agents)}
        />
      )}
      {/* 左サイドパネル（PreviewPanel）は flex でボードカラム領域を圧縮して
          確保する（下部ターミナル領域の高さ・幅には一切影響しない。
          docs/features/markdown-preview.md「機能全体の設計」節）。この行
          （board-main-row）のみを横並びにし、FilterBar は従来通り縦積みの
          最上部に残す（#64）。#112 でファイルツリーを IDE の慣例に合わせ
          画面左端へ寄せるため、パネルをボードカラムの前に配置する。 */}
      <div className="board-main-row">
        <PreviewPanel
          mdLive={mdLiveRef.current}
          openRequest={policyPreviewRequest}
        />
        <div className="board-columns">
          {agents.map((agent) => (
            <AgentColumn
              key={agent.name}
              archiveMode={archiveMode}
              onOpenPriorityPolicy={handleOpenPriorityPolicy}
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
      </div>
    </div>
  );
}
