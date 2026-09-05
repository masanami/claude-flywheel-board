import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerTerminalController,
  unregisterTerminalController,
} from "../terminal-control.ts";
import type { TerminalController } from "../terminal-control.ts";
import { connectTerminalSocket } from "../terminal-ws.ts";
import type { TerminalSocket } from "../terminal-ws.ts";
import { createAttachInputGate } from "./attach-input-gate.ts";
import type { AttachInputGate } from "./attach-input-gate.ts";
import { createXtermInstance } from "./xterm-adapter.ts";
import type { CreateXtermInstance, XtermInstance } from "./xterm-adapter.ts";

// 画面下部を占有する常設ターミナル領域（FR-09〜FR-11・FR-13・FR-20）。
// board は状態ファイルへ一切書き込まない（NFR-01）。本コンポーネントは
// タブ初回アクティブ時の pty WS 接続と xterm.js の描画に徹し、
// コマンドの自動実行（Enter 送信）はしない（prefill は未実行の文字列を
// 流し込むだけ）。
//
// #57（ターミナルペインの縦分割）: 各エージェントタブは「左=エージェント
// （kind=agent）／右=手動シェル（kind=shell）」の常時2分割で表示する。
// 別々の WS 接続（＝別々の tmux セッション）を張るため、prefill は
// エージェント側の接続にのみ配線し、shell 側の接続オブジェクトへは
// 本コンポーネントから一切 prefill を呼び出さない（サーバ側でも構造的に
// 弾かれる。src/server/pty/bridge.ts の allowPrefill 参照）。

// Issue #125: 「＋ エージェント追加」フォーム経由で出現した新規タブに一度だけ
// prefill する文字列。クリティカル設計決定（親 Issue #119）: ここで行うのは
// 「claude」という未実行の文字列を流し込むことのみ。Enter 送信・trust 応答・
// `/claude-flywheel:flywheel-init` の自動実行は一切行わない（人間が埋め込み
// ターミナル内で操作する）。
const CLAUDE_PREFILL_COMMAND = "claude";

const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 800;
const DEFAULT_HEIGHT_PX = 320;

// エージェント（左）ペインの幅（px）。シェル（右）ペインは残り幅を flex で埋める。
// 高さの調整ハンドル（上端バー）と同じ「固定 px を人間が直接動かす」設計にし、
// 分割比率を pixel 単位で扱うことでコンテナ幅の実測（getBoundingClientRect）に
// 依存しない、テスト容易でシンプルな実装にする（KISS）。
const MIN_AGENT_PANE_WIDTH_PX = 200;
const MAX_AGENT_PANE_WIDTH_PX = 1200;
// #72: 初期値480pxは内容が折り返して見づらいという報告があり、720px（約1.5倍、
// 既存 MAX=1200px の範囲内）に拡大した。
const DEFAULT_AGENT_PANE_WIDTH_PX = 720;
const SPLIT_STEP_PX = 32;

// #72: ユーザーがリサイズした agentPaneWidth を記憶する localStorage キー。
// エージェントごとの記憶は作らない（YAGNI）。全エージェント共通の単一値。
const AGENT_PANE_WIDTH_STORAGE_KEY = "terminal-pane.agent-pane-width";

type PaneKind = "agent" | "shell";
const PANE_KINDS: readonly PaneKind[] = ["agent", "shell"];

function buildTerminalWebSocketUrl(agent: string, kind: PaneKind): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/terminal?agent=${encodeURIComponent(agent)}&kind=${kind}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// #72: マウント時に localStorage から前回リサイズ幅を復元する。保存値が
// 欠損・非数値・範囲外（パース不能な文字列を含む）な場合は必ずデフォルトへ
// フォールバックする。localStorage 自体が例外を投げる環境（プライベート
// ブラウジング等）でも board を落とさないよう try/catch で保護する。
function readStoredAgentPaneWidth(): number {
  try {
    const raw = window.localStorage.getItem(AGENT_PANE_WIDTH_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_AGENT_PANE_WIDTH_PX;
    }
    const parsed = Number(raw);
    if (
      !Number.isFinite(parsed) ||
      parsed < MIN_AGENT_PANE_WIDTH_PX ||
      parsed > MAX_AGENT_PANE_WIDTH_PX
    ) {
      return DEFAULT_AGENT_PANE_WIDTH_PX;
    }
    return parsed;
  } catch {
    return DEFAULT_AGENT_PANE_WIDTH_PX;
  }
}

/** agent + kind の複合キー。ペインごとの接続・xterm・container ref を一意に識別する。 */
function connectionKey(agent: string, kind: PaneKind): string {
  return `${agent}::${kind}`;
}

type BoardAgentsResponse = {
  agents?: { name: string }[];
};

async function defaultFetchAgents(): Promise<string[]> {
  try {
    const response = await fetch("/api/board");
    if (!response.ok) {
      return [];
    }
    const board = (await response.json()) as BoardAgentsResponse;
    return (board.agents ?? []).map((agent) => agent.name);
  } catch {
    // 取得失敗時はタブなし（空領域）で構わない。board 自体は落とさない。
    return [];
  }
}

export type TerminalPaneProps = {
  createXterm?: CreateXtermInstance;
  connect?: typeof connectTerminalSocket;
  fetchAgents?: () => Promise<string[]>;
};

type AgentConnection = {
  socket: TerminalSocket;
  xterm: XtermInstance;
  gate: AttachInputGate;
};

export function TerminalPane({
  createXterm = createXtermInstance,
  connect = connectTerminalSocket,
  fetchAgents = defaultFetchAgents,
}: TerminalPaneProps) {
  const [agents, setAgents] = useState<string[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | undefined>(undefined);
  const [openedAgents, setOpenedAgents] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [collapsed, setCollapsed] = useState(false);
  // height は #72 のスコープ外のため意図的に非永続（毎回 DEFAULT_HEIGHT_PX から
  // 開始する）。agentPaneWidth のみ localStorage で記憶する（下記）。
  const [height, setHeight] = useState(DEFAULT_HEIGHT_PX);
  const [agentPaneWidth, setAgentPaneWidth] = useState<number>(
    readStoredAgentPaneWidth,
  );

  const connectionsRef = useRef<Map<string, AgentConnection>>(new Map());
  const containerRefCallbacksRef = useRef<
    Map<string, (el: HTMLDivElement | null) => void>
  >(new Map());
  // agent（左＝エージェント接続）がまだ opened になっていないうちに呼ばれた
  // prefill を、接続確立（container mount）まで一時的に保持する。
  // 単一の値ではなく配列キューにしているのは、接続確立前に連続して prefill が
  // 呼ばれた場合に後勝ちで上書きせず、全件を届いた順番のまま流し込むため。
  // shell 側は prefill の対象にならないため、このキューはエージェント接続専用。
  const pendingPrefillsRef = useRef<Map<string, string[]>>(new Map());
  // board からターミナルへ操作を受け渡す時点（タブクリック・prefill）では、
  // (a) まだ接続が確立していない（＝connectionsRef に存在しない）、
  // (b) 接続はあるが対象ペインがまだ可視でない（タブ切替の setActiveAgent が
  // まだ再レンダーへ反映されておらず .terminal-pane-split が display:none の
  // まま）、のいずれかでフォーカスが実際には効かないことがある（Issue #164）。
  // 「接続確立・可視化のどちらも揃った時点でフォーカスすべき connectionKey」を
  // 一時的に覚えておくための ref。pendingPrefillsRef と異なり単一値でよい
  // （後勝ち。フォーカスは「直近の受け渡し点」にだけ効けば十分で、複数の
  // 受け渡しが連続しても最後の1件だけが実際に表示されているタブになる）。
  const pendingFocusRef = useRef<{ agent: string; kind: PaneKind } | null>(
    null,
  );
  // terminal-control 経由の prefill が、タブ一覧に無い agent 名を受け取った場合に
  // 弾くためのガード（サーバ側 resolveAgentEntry も未登録名を拒否するが、
  // クライアント側で無用な再接続ループを作らないよう二重に防御する）。
  const agentsRef = useRef<string[]>([]);
  // Issue #125: 「エージェント追加フォーム経由で出現した新タブ」にのみ claude を
  // 一度だけ prefill するための同期レジストリ。Board.tsx の submitAddAgent が
  // notifyAgentAddRequested(name)/notifyAgentAddFailed(name) 経由でこの
  // レジストリへ直接書き込む（addAgent 自身は agent_update ストリームだけを
  // 見て判定しない）。この設計に至った経緯・なぜ agent_update ストリームだけの
  // 推論では安全性を保証できないか（サーバ起動直後の fullScan キャッチアップ
  // 配信との区別が原理的につかない）は terminal-control.ts 冒頭コメントが正本。
  const pendingNewAgentNamesRef = useRef<Set<string>>(new Set());

  const openAgent = useCallback((agent: string) => {
    setOpenedAgents((prev) => {
      if (prev.has(agent)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(agent);
      return next;
    });
  }, []);

  const ensureConnection = (
    agent: string,
    kind: PaneKind,
    container: HTMLDivElement,
  ): AgentConnection => {
    const key = connectionKey(agent, kind);
    const existing = connectionsRef.current.get(key);
    if (existing) {
      return existing;
    }

    const xterm = createXterm(container);
    // tmux は attach のたびに既存ペインの内容（シェル起動時の端末問い合わせ
    // シーケンスを含み得る）を再生し、xterm.js がそれへ自動応答（DA1/DA2/DSR
    // 等）してしまうことがある。xterm の onData は自動応答とユーザーの実操作を
    // 区別できないため、実操作（keydown/paste/IME変換開始）を観測するまで
    // input 送信を抑止するゲートを挟む（#27 フォローアップ）。エージェント・
    // シェルの各ペインは独立した container を持つため、ゲートも独立に働く。
    const gate = createAttachInputGate(container);
    // 初回の open（接続確立直後）は下の同期呼び出しで既に fit/resize 済みのため
    // 再送しない。2回目以降の open（切断→再接続）でのみ再 fit+resize する。
    // pty は再接続のたびに新規 spawn され既定サイズ（80x24）に戻るため
    // （src/server/pty/pty-process.ts）、現在の表示サイズを送り直す必要がある。
    let hasOpenedOnce = false;
    const socket = connect({
      url: buildTerminalWebSocketUrl(agent, kind),
      onData: (data) => {
        xterm.write(data);
      },
      onStatusChange: (status) => {
        if (status !== "open") {
          return;
        }
        // 再接続（＝再 attach）のたびに tmux の再生ノイズが起き得るため、
        // 初回・再接続を問わず毎回ゲートを閉じ直す。
        gate.reset();
        if (hasOpenedOnce) {
          const { cols, rows } = xterm.fit();
          socket.resize(cols, rows);
        }
        hasOpenedOnce = true;
      },
    });
    xterm.onData((data) => {
      if (!gate.isOpen()) {
        return;
      }
      socket.sendInput(data);
    });

    const connection: AgentConnection = { socket, xterm, gate };
    connectionsRef.current.set(key, connection);

    const { cols, rows } = xterm.fit();
    socket.resize(cols, rows);

    // prefill の宛先は常にエージェント（kind: "agent"）接続のみ。shell 接続
    // （kind: "shell"）は pendingPrefillsRef を一切参照しない（#57 クリティカル
    // 設計決定: shell ペインは prefill レジストリに登録しない）。
    if (kind === "agent") {
      const pendingCommands = pendingPrefillsRef.current.get(agent);
      if (pendingCommands !== undefined) {
        for (const command of pendingCommands) {
          socket.prefill(command);
        }
        pendingPrefillsRef.current.delete(agent);
      }
    }

    // ここでは pendingFocusRef を消化しない（Issue #164）。ref コールバックが
    // 走るこの時点ではまだ「対象タブが可視か」（activeAgent の再レンダーが
    // 反映済みか）を判定できないコミット中のタイミングであり、下の
    // useEffect(flushPendingFocus)（依存配列なし＝毎レンダー後に実行）が
    // 接続確立後・可視化後のいずれの順序で条件が揃っても確実に拾う。

    return connection;
  };

  // 予約されたフォーカス要求（pendingFocusRef）を、(1) 接続が確立済みで
  // (2) 対象ペインが現在可視（collapsed でなく、対象 agent が activeAgent と
  // 一致）の両方が揃っている場合にのみ消化する（Issue #164）。
  //
  // 【重要】可視判定を DOM の実レイアウト（getBoundingClientRect・
  // style.display の実測）ではなく React state（collapsed・activeAgent）から
  // 行っているのは、setActiveAgent 等の state 更新は React の再レンダーが
  // コミットされるまで DOM に反映されない一方、この関数自身は「state 更新
  // 直後・再レンダー前」に呼ばれることもあるため（後述）。state を直接見れば
  // 「これから可視になる」ことを DOM 更新を待たずに判定できる。
  //
  // 実ブラウザでは display:none の要素（の子孫である xterm.js の隠し
  // textarea）へはフォーカスできない。可視判定を入れずに毎回同期
  // focus() すると、タブ切替（setActiveAgent 直後、まだ再レンダーが
  // コミットされておらず対象ペインの .terminal-pane-split が旧レンダーの
  // display:none のままの瞬間）に focus() を呼んでしまい、実ブラウザでは
  // 効果が無いまま Issue #164 の症状が残る（jsdom はフォーカス時に
  // 要素の可視性を検証しないためこの不具合を検出できない）。
  const flushPendingFocus = useCallback(() => {
    const pending = pendingFocusRef.current;
    if (pending === null) {
      return;
    }
    const connection = connectionsRef.current.get(
      connectionKey(pending.agent, pending.kind),
    );
    if (!connection) {
      // 接続がまだ無い。ensureConnection 完了後の次の再レンダーで
      // このエフェクトが再度走り、その時点で拾われる。
      return;
    }
    if (collapsed || pending.agent !== activeAgent) {
      // まだ可視でない。activeAgent／collapsed が変わって条件が揃うと
      // 再レンダーが起き、このエフェクトが再度走って拾われる。
      return;
    }
    pendingFocusRef.current = null;
    connection.xterm.focus();
  }, [collapsed, activeAgent]);

  // 毎レンダー後に予約消化を試みる（依存配列なし＝全レンダーで実行）。
  // requestPaneFocus 自身も呼び出し直後に同期的に一度消化を試みるため
  // （既に可視な対象への mousedown・既にアクティブなタブへの再クリック等、
  // 再レンダーを伴わない経路を同期的に救う）、このエフェクトは主に
  // 「呼び出し時点ではまだ条件が揃っていなかった」ケース（未接続タブの
  // 初回オープン、非アクティブタブへの切替）を再レンダー後に拾うためのもの。
  useEffect(() => {
    flushPendingFocus();
  });

  // board からターミナルへの受け渡し点（タブクリック・prefill・パネルへの
  // mousedown）から呼ぶ、フォーカス要求の唯一の入口（Issue #164）。
  // useCallback で安定した参照にしているのは、下の terminal-control 登録
  // useEffect の依存配列に含める必要があるため。
  const requestPaneFocus = useCallback(
    (agent: string, kind: PaneKind) => {
      pendingFocusRef.current = { agent, kind };
      flushPendingFocus();
    },
    [flushPendingFocus],
  );

  const getContainerRefCallback = (agent: string, kind: PaneKind) => {
    const key = connectionKey(agent, kind);
    let callback = containerRefCallbacksRef.current.get(key);
    if (!callback) {
      callback = (el) => {
        if (!el) {
          return;
        }
        ensureConnection(agent, kind, el);
      };
      containerRefCallbacksRef.current.set(key, callback);
    }
    return callback;
  };

  // mount 時に1回だけ /api/board を読み、タブ一覧を確定する（Board.tsx の WS
  // 購読とは独立。二重の WS 接続を避けるため意図的に REST の1回読みに留める）。
  useEffect(() => {
    let cancelled = false;
    fetchAgents()
      .then((names) => {
        if (!cancelled) {
          // セルフレビュー指摘（Issue #124）: この fetch が解決する前に
          // notifyAgentAdded 経由で addAgent が呼ばれていた場合（mount 直後の
          // ごく短いウィンドウで、新規エージェント追加の agent_update が
          // /api/board の応答より先に届くレアケース）、setAgents(names) の
          // 単純上書きだとその追加分を消してしまう。PLAUSIBLE指摘（5分毎の
          // フル再スキャンで自然回復するため実害は限定的）だが、追加分を
          // 残すマージにしても実装コストが小さいため対応する。
          setAgents((prev) => {
            const merged = [...names];
            for (const name of prev) {
              if (!merged.includes(name)) {
                merged.push(name);
              }
            }
            return merged;
          });
        }
      })
      .catch(() => {
        // 取得失敗時はタブなし（空領域）で構わない。board 自体は落とさない。
        // ただし setAgents([]) による単純上書きはしない。上の成功経路と同じ
        // レース（notifyAgentAdded が先に addAgent でタブを追加し、この
        // fetchAgents の reject が後から解決する）が起き得るため、空配列で
        // 上書きすると先行追加分のタブと消費済みの prefill マークが失われ、
        // claude の prefill が再実行されないまま黙って消える（レビュー指摘）。
        // 先行追加分を保持するため prev をそのまま返す（成功経路のマージと
        // 異なり fetchAgents 側の名前が無いため、追加すべき新規名も無い）。
        if (!cancelled) {
          setAgents((prev) => prev);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAgents]);

  // 初回、agents 取得後まだ activeAgent が未設定なら先頭のエージェントを
  // 初回アクティブにする（＝最初のタブのみ接続。他は開かれるまで未接続）。
  //
  // 【Issue #164・意図的な非スコープ】ここでは requestPaneFocus を呼ばない（＝初回
  // マウント／初回接続時に自動フォーカスしない）。board 本体（カード一覧）が
  // 主操作面であり、ページ読み込み直後にターミナルへフォーカスを奪うのは
  // 有害（例えばキーボードでカード一覧を操作しようとした最初のキー入力が
  // ターミナルへ吸われてしまう）。
  useEffect(() => {
    if (activeAgent === undefined && agents.length > 0) {
      const first = agents[0];
      if (first !== undefined) {
        setActiveAgent(first);
        openAgent(first);
      }
    }
  }, [agents, activeAgent, openAgent]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // #16 の D&D／＋差し込み動線から呼ばれる prefill 公開 API に自身を登録する。
  useEffect(() => {
    // 折りたたみ中は対象ペインが不可視のため展開し、対象タブをアクティブ化・
    // オープン（未接続なら接続確立）したうえで command を流し込む。接続が
    // まだ確立していない場合は pendingPrefillsRef に積み、ensureConnection の
    // 接続確立時（container mount 時）にまとめて flush される。
    // prefill は常にエージェント（左）側接続のみを対象にする。shell（右）
    // 接続は connectionsRef 上に存在しても、ここから参照すること自体が無い
    // （#57 クリティカル設計決定）。
    //
    // 【スコープ外・既知の限定事項】(design-reviewer/code-reviewer セルフレビュー
    // 指摘、PLAUSIBLE): addAgent 経由（Issue #125）の呼び出しは、その agent の
    // tmux セッションがまだ存在しない状態（新規追加直後）で接続確立→prefill が
    // 走ることが多い。tmux 側のセッション初期化（ログインシェルの rc 読み込み
    // 等）と send-keys のタイミング競合で文字が欠落する可能性は理論上あるが、
    // これは #16 の D&D／＋差し込み動線が元々未接続タブへ prefill する場合と
    // 同じ pty/tmux 経路・同じ既存のタイミング特性であり、本チケットで新規に
    // 持ち込んだリスクではない（サーバ側 src/server/pty/bridge.ts の
    // pendingRawMessages キューイングが tmux セッション確立後の送信を保証する）。
    // 単体テストは socket をモックしているため実 tmux でのタイミングまでは
    // 検証できないが、既存の #16 機構と同一経路である以上、本チケット単独での
    // 追加の実機検証は必須としない。
    //
    // ガード（「タブ一覧に無い agent 名は無視する」）を含まないロジック本体
    // のみをここに置き、prefill メソッド（D&D／＋差し込み動線向け・ガードあり）と
    // addAgent メソッド（Issue #125・新規タブ検出後にガード無しで直接呼ぶ）の
    // 両方から共有する。
    //
    // 【設計判断の明記】(design-reviewer セルフレビュー指摘): addAgent 経由で
    // deliverPrefill を呼ぶと、command の流し込みに加えてパネルの強制展開・
    // アクティブタブの強制切替・接続の即時確立という副作用も伴う。これは
    // Issue #125 のスコープ（「claude を prefill する」）を厳密には超えるが、
    // 意図的な採用である: (1) #16 の D&D／＋差し込み動線が持つ既存の
    // prefill() 契約と一貫した挙動にする（ここだけ特別扱いにしない・KISS）、
    // (2) 「＋ エージェント追加」を実行した直後という文脈では、新タブへ
    // フォーカスが移り claude が見える状態になることはむしろ期待される
    // 挙動であり、（接続を確立しないまま pendingPrefillsRef に積むだけの
    // 狭い実装も可能だったが）prefill が実際にターミナルへ現れるところまで
    // 保証する方が完了条件「claude が prefill される」を素直に満たす。
    const deliverPrefill = (agent: string, command: string) => {
      setCollapsed(false);
      setActiveAgent(agent);
      openAgent(agent);
      const key = connectionKey(agent, "agent");
      const existing = connectionsRef.current.get(key);
      if (existing) {
        existing.socket.prefill(command);
      } else {
        const pending = pendingPrefillsRef.current.get(agent) ?? [];
        pending.push(command);
        pendingPrefillsRef.current.set(agent, pending);
      }
      // prefill の宛先（agent ペイン）と同じ接続へフォーカスする（Issue #164）。
      // タブクリックと同様、board からターミナルへ操作を受け渡す起点のため。
      requestPaneFocus(agent, "agent");
    };

    const controller: TerminalController = {
      prefill(agent, command) {
        if (!agentsRef.current.includes(agent)) {
          // タブ一覧に無い agent 名は無視する（不明な接続を作らない）。
          return;
        }
        deliverPrefill(agent, command);
      },
      // Issue #124/#125: Board.tsx の WS agent_update（既存経路。新しい WS
      // 接続・ポーリングは追加しない）を起点に notifyAgentAdded 経由で呼ばれる。
      // タブ一覧への追加はここで無条件に行う（冪等）。claude の一度きりの
      // prefill は、pendingNewAgentNamesRef（宣言部のコメント参照）に
      // 「エージェント追加フォームが実際に送信された」ことを示すマークが
      // 付いている場合に限り発火し、消費（delete）する。マークは Board.tsx の
      // notifyAgentAddRequested 経由でのみ付与されるため、通常の agent_update
      // （既存タブの更新・WS 再接続相当の重複呼び出し・サーバ起動直後の
      // fullScan によるキャッチアップ配信）ではマークが無く、誤って
      // 「新規」と判定されることはない（クリティカル設計決定①）。
      addAgent(name) {
        // セルフレビュー指摘（round3・code-reviewer/design-reviewer 双方が
        // CONFIRMED、medium）: AddAgentForm はクライアント側で名前の重複を
        // 検証しない（サーバ側の責務）。そのため既存エージェントと同名で
        // 追加を試みた場合、markPendingNewAgent が呼ばれてから
        // clearPendingNewAgent が呼ばれるまでの短い HTTP 往復の間に、その
        // 既存エージェントの通常の agent_update が届くと誤って新規と判定
        // されうる。マークに加えて「まだタブ一覧に無い名前か」も見ることで
        // この残存ウィンドウを閉じる（既存タブなら、マークがあっても新規
        // 扱いしない）。
        const isNewAgent =
          pendingNewAgentNamesRef.current.has(name) &&
          !agentsRef.current.includes(name);
        // マーク自体は「タブ一覧に既にあったか」に関わらず消費する
        // （残置すると、後で本当に同名タブが消えて再度追加されるような
        // 想定外のケースでも古いマークが残り続けてしまうため）。
        pendingNewAgentNamesRef.current.delete(name);
        setAgents((prev) => (prev.includes(name) ? prev : [...prev, name]));
        if (isNewAgent) {
          deliverPrefill(name, CLAUDE_PREFILL_COMMAND);
        }
      },
      // Issue #125: Board.tsx の submitAddAgent（POST /api/fleet/agents の
      // 送信ラッパー）から、ネットワーク I/O を開始する前の最も早いタイミングで
      // 呼ばれる（サーバは fleet 追記→scan→broadcastAgentUpdate まで完了して
      // から HTTP レスポンスを返すため、fetch() 成功後にマークすると WS 経由の
      // agent_update がレスポンスより先に届くレースで取り逃しうる。宣言部の
      // コメント参照）。
      markPendingNewAgent(name) {
        pendingNewAgentNamesRef.current.add(name);
      },
      // Issue #125: submitAddAgent が失敗した場合に呼ばれる。この name の
      // エージェントは（少なくともこの送信では）作られないため、マークを
      // 取り消す。取り消さないと、同名の既存エージェント（例: 重複名エラー）
      // が後で通常の agent_update を受け取った際に誤って新規追加と判定され、
      // 稼働中セッションへ claude を誤 prefill しうる。
      clearPendingNewAgent(name) {
        pendingNewAgentNamesRef.current.delete(name);
      },
    };
    registerTerminalController(controller);
    return () => {
      unregisterTerminalController(controller);
    };
  }, [openAgent, requestPaneFocus]);

  // 表示中（非 collapsed）の xterm（agent・shell 両ペイン）を re-fit して resize を
  // 伝搬する共通処理。パネルの高さ変更・分割比率変更・折りたたみ解除・タブ切替・
  // window リサイズの5つの契機から呼ばれる（非表示中のペインは正しいサイズを
  // 計算できないため対象外）。
  const refitActiveConnection = useCallback(() => {
    if (collapsed || activeAgent === undefined) {
      return;
    }
    for (const kind of PANE_KINDS) {
      const connection = connectionsRef.current.get(
        connectionKey(activeAgent, kind),
      );
      if (!connection) {
        continue;
      }
      const { cols, rows } = connection.xterm.fit();
      connection.socket.resize(cols, rows);
    }
  }, [collapsed, activeAgent]);

  // window のリサイズに追従する。
  useEffect(() => {
    window.addEventListener("resize", refitActiveConnection);
    return () => {
      window.removeEventListener("resize", refitActiveConnection);
    };
  }, [refitActiveConnection]);

  // unmount 時に全ての接続を後始末する（非表示中のタブは display:none で
  // 維持する設計だが、コンポーネント自体が unmount される際はリークさせない）。
  useEffect(() => {
    return () => {
      for (const connection of connectionsRef.current.values()) {
        connection.socket.close();
        connection.xterm.dispose();
        connection.gate.dispose();
      }
      connectionsRef.current.clear();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: height は本体で読まないが高さドラッグのたびに再 fit を発火させる意図的なトリガー依存
  useEffect(() => {
    refitActiveConnection();
  }, [height, refitActiveConnection]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: agentPaneWidth は本体で読まないが分割比率変更のたびに再 fit を発火させる意図的なトリガー依存
  useEffect(() => {
    refitActiveConnection();
  }, [agentPaneWidth, refitActiveConnection]);

  // #72: リサイズ（ドラッグ・キーボード操作）のたびに agentPaneWidth を
  // localStorage へ永続化する。次回マウント時に readStoredAgentPaneWidth() で
  // 復元される。localStorage が使えない環境でも board は落とさない。
  useEffect(() => {
    try {
      window.localStorage.setItem(
        AGENT_PANE_WIDTH_STORAGE_KEY,
        String(agentPaneWidth),
      );
    } catch {
      // 永続化を諦めるだけで、board 自体は落とさない。
    }
  }, [agentPaneWidth]);

  const handleTabClick = (agent: string) => {
    setActiveAgent(agent);
    openAgent(agent);
    // タブクリックは board からターミナルへ操作を受け渡す代表的な起点。
    // ここでフォーカスしないと、xterm の隠し textarea にフォーカスが乗らず
    // ESC が pty へ届かないまま board 側のフォーカス移動に化ける（Issue #164）。
    // 別タブへの切替の場合、この時点ではまだ activeAgent の更新が再レンダーへ
    // 反映されておらず対象ペインは display:none のまま（＝現時点で focus()
    // しても実ブラウザでは効かない）ため、requestPaneFocus が予約し
    // flushPendingFocus（可視化後の再レンダー時）へ委ねる。
    requestPaneFocus(agent, "agent");
  };

  // パネルコンテナ（terminal-pane-panel-agent／-shell）への mousedown。対象は
  // 「FitAddon の rows 切り捨てで残る、`.xterm` 要素が占めない余白」への
  // クリック（Issue #164）。
  //
  // event.target === event.currentTarget（＝コンテナ自身が着弾点。`.xterm` の
  // 子孫ではない）の場合のみ preventDefault する。実ブラウザは mousedown の
  // 既定動作として「フォーカス可能でない要素上のクリックでは現在のフォーカスを
  // 解除する」ため、これを止めないと直後の focus() 呼び出しがブラウザの既定
  // 動作に打ち消される（design-reviewer 指摘）。`.xterm` 上のクリックでは
  // xterm 自身の mousedown リスナが先に（同一イベントに対して）preventDefault
  // 済みのため、この分岐で追加の preventDefault を呼ぶ必要は無い（呼んでも
  // 同一イベントへの重複呼び出しで無害だが、対象を絞ることで「本当に必要な
  // 余白クリックの場合にのみ止める」意図をコードで明示する）。
  const handlePanelMouseDown =
    (agent: string, kind: PaneKind) =>
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        event.preventDefault();
      }
      requestPaneFocus(agent, kind);
    };

  const handleResizeMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const startHeight = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY;
      setHeight(clamp(startHeight + delta, MIN_HEIGHT_PX, MAX_HEIGHT_PX));
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleSplitMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    // ドラッグ中に左右の xterm パネル上を横切ってもテキスト選択が始まらない
    // ようにする（#44/#51 のコピー/ペースト体験を壊さないため。CodeRabbit 指摘）。
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = agentPaneWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      setAgentPaneWidth(
        clamp(
          startWidth + delta,
          MIN_AGENT_PANE_WIDTH_PX,
          MAX_AGENT_PANE_WIDTH_PX,
        ),
      );
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleSplitKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // マウスドラッグの代替経路（既存の高さリサイズ・#25/#39 のキーボード操作の
    // パターンに合わせる）。ArrowLeft/Right で32pxずつ増減し、既存の clamp で
    // 範囲内に収める。
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setAgentPaneWidth((prev) =>
        clamp(
          prev - SPLIT_STEP_PX,
          MIN_AGENT_PANE_WIDTH_PX,
          MAX_AGENT_PANE_WIDTH_PX,
        ),
      );
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setAgentPaneWidth((prev) =>
        clamp(
          prev + SPLIT_STEP_PX,
          MIN_AGENT_PANE_WIDTH_PX,
          MAX_AGENT_PANE_WIDTH_PX,
        ),
      );
    }
  };

  return (
    <div
      className="terminal-pane"
      data-testid="terminal-pane"
      style={{ height: collapsed ? undefined : `${height}px` }}
    >
      <div
        className="terminal-pane-resize-handle"
        data-testid="terminal-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={height}
        aria-valuemin={MIN_HEIGHT_PX}
        aria-valuemax={MAX_HEIGHT_PX}
        aria-label="ターミナルパネルの高さ"
        tabIndex={0}
        onMouseDown={handleResizeMouseDown}
        onKeyDown={(event) => {
          // マウスドラッグの代替経路（#25）。ArrowUp/Down で32pxずつ増減し、
          // 既存の clamp で範囲内に収める。setHeight を呼べば再fit用
          // useEffect（[height, refitActiveConnection] 依存）が自動的に走る。
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setHeight((prev) => clamp(prev + 32, MIN_HEIGHT_PX, MAX_HEIGHT_PX));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setHeight((prev) => clamp(prev - 32, MIN_HEIGHT_PX, MAX_HEIGHT_PX));
          }
        }}
      />
      <div className="terminal-pane-header">
        <div className="terminal-tabs" role="tablist">
          {agents.map((agent) => (
            <button
              key={agent}
              type="button"
              role="tab"
              className="terminal-tab"
              aria-selected={agent === activeAgent}
              onClick={() => handleTabClick(agent)}
            >
              {agent}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="terminal-collapse-button"
          aria-label={collapsed ? "展開" : "折りたたむ"}
          // 【Issue #164・意図的な非スコープ】展開時に requestPaneFocus を呼ばない。
          // このボタン自体はキーボード（Enter/Space）でも操作でき、展開直後に
          // ターミナルへフォーカスを奪うとキーボード操作でのトグル後に
          // フォーカスが行方不明になる a11y 退行になるため採らない。展開後に
          // ターミナル内をクリックすれば各パネルの onMouseDown で救済される。
          onClick={() => {
            // 未消化のフォーカス予約を破棄する（Issue #164 セルフレビュー指摘）。
            // 折りたたみ中でもタブボタンはヘッダに残るため、折りたたみ中に
            // タブをクリックすると予約だけが残る。破棄しないと、その後
            // 「展開」を押した再レンダーで flushPendingFocus が可視条件を
            // 満たして消化してしまい、上で「採らない」と決めた a11y 退行
            // （展開直後にターミナルへフォーカスが飛ぶ）が裏口から発生する。
            // 人間が明示的にトグルした時点で、それ以前の受け渡し要求は
            // 失効させる。prefill 経由の展開（deliverPrefill の
            // setCollapsed(false)）はこのボタンを通らないため影響しない。
            pendingFocusRef.current = null;
            setCollapsed((prev) => !prev);
          }}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>
      {/* collapsed 時も DOM からアンマウントしない（常に mount したまま display:none
          で隠す）。条件付きレンダリングで unmount すると、xterm.js が
          terminal.open() 時にアタッチした内部 DOM がコンテナごと破棄され、
          再展開時に空表示へ戻ってしまう（xterm インスタンス自体は
          connectionsRef に生き残るが、描画先の DOM を失うため）。 */}
      <div
        className="terminal-pane-body"
        data-testid="terminal-pane-body"
        style={{ display: collapsed ? "none" : "block" }}
      >
        {/* #57: 各タブは常時「左=エージェント／右=手動シェル」の2分割。
            トグルは無い（設計決定どおり常時表示）。 */}
        {[...openedAgents].map((agent) => (
          <div
            key={agent}
            className="terminal-pane-split"
            data-testid={`terminal-panel-${agent}`}
            style={{ display: agent === activeAgent ? "flex" : "none" }}
          >
            <div
              className="terminal-pane-panel terminal-pane-panel-agent"
              data-testid={`terminal-panel-${agent}-agent`}
              style={{ width: `${agentPaneWidth}px` }}
              ref={getContainerRefCallback(agent, "agent")}
              // FitAddon は rows を切り捨てるため、コンテナ下端に xterm の
              // `.xterm` 要素が占めない余白（最大1セル分）が残ることがある。
              // xterm 自身はその余白の mousedown を検知できずフォーカスが
              // 移らないため、コンテナ側でも明示的にフォーカスする
              // （handlePanelMouseDown 参照。Issue #164）。
              onMouseDown={handlePanelMouseDown(agent, "agent")}
            />
            <div
              className="terminal-pane-splitter"
              // パネル側（terminal-panel-${agent}-agent/-shell）と同様に agent で
              // 一意化する。openedAgents は非アクティブなタブも display:none で
              // DOM に残したまま維持するため、agent 名を含めないと複数タブを
              // 開いた際に同一 data-testid の要素が DOM 上に複数存在してしまう
              // （セルフレビュー指摘: #57）。
              data-testid={`terminal-split-handle-${agent}`}
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={agentPaneWidth}
              aria-valuemin={MIN_AGENT_PANE_WIDTH_PX}
              aria-valuemax={MAX_AGENT_PANE_WIDTH_PX}
              aria-label={`ターミナル分割比率（エージェント/シェル） - ${agent}`}
              tabIndex={0}
              onMouseDown={handleSplitMouseDown}
              onKeyDown={handleSplitKeyDown}
            />
            <div
              className="terminal-pane-panel terminal-pane-panel-shell"
              data-testid={`terminal-panel-${agent}-shell`}
              ref={getContainerRefCallback(agent, "shell")}
              // agent 側パネルと同じ理由（上記コメント参照）。shell 側は
              // prefill の対象外だが、フォーカス制御は agent/shell 両ペインで
              // 対称に効かせる（#57: 各タブは常時2分割で表示され、どちらの
              // ペインで操作するかはユーザー次第のため）。
              onMouseDown={handlePanelMouseDown(agent, "shell")}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
