import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  type MdLiveChannel,
  createNoopMdLiveChannel,
} from "../md-live-channel.ts";
import { FileTree } from "./FileTree.tsx";

// board 左サイドの開閉式パネル（マークダウンプレビュー機能全体の設計 —
// docs/features/markdown-preview.md「機能全体の設計」節）。開閉・幅ドラッグは
// #64 のシェル実装、ファイルツリー（FileTree）とリフレッシュボタンの結線は
// #68 で追加した。選択ファイルの内容取得（GET /api/md/file）と
// react-markdown によるレンダリングは #69 で結線した。本チケット（#70）で
// ライブ更新（WS md_subscribe/md_unsubscribe・md_file_changed 受信時の
// 再フェッチ・md_subscribe_error 時の注記表示）を結線する。
//
// クリティカル設計決定（親 Issue #61）: PreviewPanel は新しい WS 接続を
// 追加で開かない。Board.tsx が保有する唯一の /ws 接続を mdLive
// （../md-live-channel.ts）経由で再利用する。プレビュー対象の切替時は
// サーバの自動解除（1クライアント1購読）に委ねるため明示的な
// md_unsubscribe は送らず、パネルを閉じる操作時にのみ送信する。
//
// 左サイドパネルは flex でボードカラム領域を圧縮して確保する（#112 で
// 右サイドから移動。ファイルツリーは IDE の慣例どおり画面左端に置く）。
// （下部ターミナル領域の高さ・幅には一切影響しない）。組み込み側は
// Board.tsx を参照。本コンポーネント自体は自分の幅のみを inline style で
// 制御し、周囲のレイアウトには関与しない（KISS）。
//
// board は状態ファイルへ一切書き込まない（NFR-01）。本コンポーネントおよび
// FileTree は GET /api/md/tree・GET /api/md/file の読み取りのみを行い、
// 書き込み経路は一切持たない。
//
// クリティカル設計決定（親 Issue #61「Markdown 描画の XSS 対策」）:
// react-markdown（remark-gfm / rehype-highlight）で React 要素として描画し、
// rehype-raw は導入しない（生 HTML は無効のまま・text ノードとして扱われる）。
// `dangerouslySetInnerHTML` は一切使用しない。mermaid コードブロックのみ
// 例外的に DOM へ直接 SVG 文字列を挿入するが、その根拠は MermaidDiagram の
// コメントを参照。
//
// clamp() は TerminalPane.tsx にも同名の実装がある（セルフレビュー指摘:
// DRY違反）が、本チケットの制約で TerminalPane.tsx 自体には一切触れられない
// ため、共有ヘルパへ切り出しても TerminalPane 側の重複は解消できない
// （唯一の利用者のまま lib 層へ切り出す実益が薄い）。2行の純関数のため、
// YAGNI/KISS を優先しここではあえてローカルに留める。

const MIN_WIDTH_PX = 240;
const MAX_WIDTH_PX = 800;
const DEFAULT_WIDTH_PX = 360;
const RESIZE_STEP_PX = 32;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// GET /api/md/file の 200 応答形（src/server/api.ts の `c.json({ content })`）。
// サーバ側は type を export していないため（server コードの変更は本チケットの
// スコープ外）、UI 側の契約としてローカルに定義する。
// セルフレビュー指摘: board-types.ts に置く選択肢も検討したが、同ファイルの
// 冒頭コメントは「UI 側の型は server 側の型をそのまま再利用し、独自解釈を
// 持ち込まない」という re-export 専用の不変条件を明言しており
// （`MdTreeRepo`/`MdTreeResponse` はいずれも server からの re-export）、
// server が export していない形をそこへ独自定義すると、その不変条件を崩す。
// 唯一の利用者である本ファイルにローカル定義のまま留める。
type MdFileResponse = { content: string };

type SelectedFile = { repo: string; path: string };

type FileContentState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; content: string }
  | { status: "error"; message: string };

const GENERIC_FILE_ERROR_MESSAGE = "ファイルの取得に失敗しました";
const TOO_LARGE_ERROR_MESSAGE = "サイズが大きすぎるため表示できません";
const MERMAID_RENDER_ERROR_MESSAGE = "mermaid 図の描画に失敗しました";
const LIVE_UPDATE_DISABLED_MESSAGE = "ライブ更新は無効です";

// mermaid.initialize は冪等（mermaid 公式ドキュメント）なので、レンダリング
// のたびに呼び直して securityLevel: "strict" を主張し直す（セルフレビュー
// 指摘: モジュールスコープの一発フラグだと、他コードが将来 mermaid.initialize
// を別 securityLevel で呼んだ場合に本モジュールが strict を再主張できず、
// この画面唯一のセキュリティ不変条件がグローバル状態任せになってしまう）。
// suppressErrorRendering: true は、構文エラー時に mermaid が生成する一時
// エラー要素を throw 前に自分で片付けさせるため（後述 MermaidDiagram の
// コンテナ隔離と合わせた二重の保険）。
function initializeMermaidStrict(): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
  });
}

let mermaidRenderSeq = 0;

// mermaid.render はモジュールスコープの共有state（クラスタ/親子関係の Map 等）
// を描画のたびに clear() してから await を挟んで読み書きする（mermaid 内部実装。
// 直列化を前提にしている）。1つの Markdown 内に mermaid ブロックが複数ある
// 場合、各 MermaidDiagram の useEffect が同一コミットで並行に render() を
// 呼ぶと、後発の clear() が先行呼び出しの状態を消してしまい、subgraph を含む
// 図が誤描画・描画失敗になりうる（セルフレビュー指摘）。全 MermaidDiagram
// インスタンス間で render() 呼び出しをこのモジュール変数のキューで直列化する。
let mermaidRenderQueue: Promise<unknown> = Promise.resolve();

function enqueueMermaidRender(
  id: string,
  code: string,
  container: Element | undefined,
): Promise<{ svg: string; bindFunctions?: (element: Element) => void }> {
  const result = mermaidRenderQueue.then(() =>
    mermaid.render(id, code, container),
  );
  // 直列化キュー自体は失敗しても途切れさせない（1件の描画失敗が後続の
  // 描画を巻き込んで止まらないように、キューに積む Promise は catch 済みの
  // ものにする。呼び出し元へは result をそのまま返すため、失敗は呼び出し元の
  // .catch で個別にハンドリングされる）。
  mermaidRenderQueue = result.catch(() => undefined);
  return result;
}

// react-markdown の code コンポーネントは children に highlight 済みの
// React 要素配列を渡してくることがある（rehype-highlight が対応言語として
// 認識した場合）。mermaid のソースはプレーンテキストとして必要なため、
// 文字列を再帰的に連結して取り出す（`String(children)` は配列を
// "[object Object]" 化してしまい壊れるため使わない）。
function extractPlainText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractPlainText).join("");
  }
  if (
    node !== null &&
    typeof node === "object" &&
    "props" in node &&
    typeof (node as { props?: { children?: React.ReactNode } }).props ===
      "object"
  ) {
    return extractPlainText(
      (node as { props: { children?: React.ReactNode } }).props.children,
    );
  }
  return "";
}

// mermaid コードブロック用の描画コンポーネント。
//
// クリティカル設計決定（親 Issue #61）は「dangerouslySetInnerHTML を使わない」
// だが、mermaid.render() が返す SVG 文字列を DOM へ反映するには何らかの形で
// HTML 文字列を挿入する必要がある。ここでは React の `dangerouslySetInnerHTML`
// プロパティは使わず、`useRef` で取得した DOM ノードへ `innerHTML` を直接
// 代入する。これは文言上の制約（React API を使わない）を満たすだけでなく、
// 趣旨（未サニタイズの生 HTML を構造を経ずに注入しない）も満たす。理由:
// `securityLevel: "strict"` を指定した mermaid.render() は内部で DOMPurify に
// よりラベル等をサニタイズ済みの SVG 文字列を返す（mermaid 公式ドキュメントの
// securityLevel 仕様）。つまりここで注入する文字列は「ユーザーが書いた
// mermaid 定義（コードブロックの中身）」そのものではなく、「mermaid 自身が
// 生成・サニタイズした信頼済み SVG」であり、ユーザー入力の生 HTML をそのまま
// DOM に注入する dangerouslySetInnerHTML のリスクとは性質が異なる。
//
// セルフレビュー指摘: mermaid はデフォルトで document.body 直下に一時要素を
// 作って描画し、構文エラー時に例外を投げる経路ではそれを片付けずに残す
// （孤立した SVG が body に残留し続けるリークになりうる）。`mermaid.render`
// の第3引数に自前のコンテナ（containerRef.current）を渡すことで、一時要素の
// 描画先を body ではなく React が管理するこの div の内側に限定する。
//
// セルフレビュー指摘（2周目）: 描画失敗時にコンテナ div ごとエラーメッセージ
// に差し替えると、直後に code が変わって再度 render() が走る際に
// containerRef.current が null（＝コンテナ未マウント）になり、上記の隔離が
// 効かず mermaid が body 直下へフォールバックしてしまう。コンテナ div は
// 常にマウントしたままにし、失敗時はその隣にエラーメッセージを追加表示する
// 形にすることで、render() が呼ばれる時点で常にコンテナが存在することを保証する。
function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    initializeMermaidStrict();
    let cancelled = false;
    setFailed(false);
    // 直前の描画結果（成功時の SVG・失敗時の残骸）を持ち越さない。
    if (containerRef.current) {
      containerRef.current.innerHTML = "";
    }
    const id = `preview-panel-mermaid-${mermaidRenderSeq++}`;

    enqueueMermaidRender(id, code, containerRef.current ?? undefined)
      .then(({ svg, bindFunctions }) => {
        if (cancelled || !containerRef.current) {
          return;
        }
        containerRef.current.innerHTML = svg;
        bindFunctions?.(containerRef.current);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className="preview-panel-mermaid-wrapper">
      <div
        className="preview-panel-mermaid"
        data-testid="preview-panel-mermaid"
        ref={containerRef}
      />
      {failed && (
        <div className="preview-panel-mermaid-error">
          {MERMAID_RENDER_ERROR_MESSAGE}
        </div>
      )}
    </div>
  );
}

// react-markdown の `pre`/`code` コンポーネントをオーバーライドする。
//
// - `pre`: 子が `language-mermaid` の `<code>` 1つだけの場合は `<pre>` で
//   包まず MermaidDiagram のみを描画する（mermaid の図は `<pre>` の内容
//   モデル外であり、`white-space: pre` 等のコードブロック向けスタイルを
//   引き継ぐべきではないため）。それ以外は通常どおり `<pre>` のまま。
// - `code`: 実際の mermaid 差し替えは `pre` 側の判定で行うため、`code` 側は
//   className/children をそのまま DOM へ渡すだけ。react-markdown は hast の
//   `node` prop も渡してくる（`passNode: true`）が、DOM 要素にそのまま
//   spread すると `node="[object Object]"` という無意味な属性が出力される
//   ため、分割代入で明示的に除外し DOM へは渡さない。
//
// `isMermaidCodeElement` の判定基準について: `pre` の唯一の子要素であるべき
// `code` は、react-markdown の components 差し替えにより type が文字列
// "code" ではなく本ファイルの code コンポーネント関数になる
// （hast-util-to-jsx-runtime がタグ名を components マップの値へ置き換える
// ため）。そのため type の同一性ではなく、fenced code block にのみ付与される
// `className="language-xxx"` の有無で判定する。
function isMermaidCodeElement(
  node: React.ReactNode,
): node is React.ReactElement<{
  className?: string;
  children?: React.ReactNode;
}> {
  if (node === null || typeof node !== "object" || !("props" in node)) {
    return false;
  }
  const className = (node as React.ReactElement<{ className?: unknown }>).props
    .className;
  return typeof className === "string" && /language-mermaid\b/.test(className);
}

const markdownComponents: Components = {
  pre({ node: _node, children, ...props }) {
    const soleChild = Array.isArray(children)
      ? children.length === 1
        ? children[0]
        : undefined
      : children;
    if (isMermaidCodeElement(soleChild)) {
      return (
        <MermaidDiagram
          code={extractPlainText(soleChild.props.children).replace(/\n$/, "")}
        />
      );
    }
    return <pre {...props}>{children}</pre>;
  },
  code({ node: _node, className, children, ...props }) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export type PreviewPanelOpenRequest = {
  repo: string;
  path: string;
  /**
   * 再発火のトリガー（セルフレビュー指摘対応）。呼び出し元はクリック等の
   * 要求のたびにこの値を単調増加させること。「毎回新しいオブジェクトを
   * 渡す」という参照同一性（Object.is）頼みの暗黙の呼び出し規約ではなく、
   * この数値フィールドの変化を明示的な契約にする（呼び出し元が将来
   * openRequest オブジェクト自体をメモ化しても、requestId さえ増分すれば
   * 確実に再発火する）。
   */
  requestId: number;
};

export function PreviewPanel({
  mdLive: mdLiveProp,
  openRequest,
}: {
  mdLive?: MdLiveChannel;
  /**
   * Issue #135: AgentColumn の優先度方針バッジ等、パネル外部から特定ファイルを
   * 開かせたい呼び出し元（Board.tsx）向けの制御プロパティ。requestId が
   * 変わるたびに、パネルを開いた上で該当ファイルを選択する（FileTree での
   * クリック選択と同じ効果）。null/undefined は「外部オープン要求なし」を表す
   * （既存のパネル開閉・FileTree からの手動選択には一切影響しない）。
   */
  openRequest?: PreviewPanelOpenRequest | null;
} = {}) {
  // Board.tsx 経由で唯一の WS 接続と橋渡しする（#70）。Board.tsx を介さず
  // 単体でレンダリングする既存テストのため、prop 未指定時は何もしない
  // チャネルを既定値として使う。
  //
  // セルフレビュー指摘: デフォルト引数（`mdLive = createNoopMdLiveChannel()`）
  // は JS の仕様上、prop が未指定のたびに——つまり再レンダーのたびに——
  // 新しいオブジェクトを生成してしまう。この値は下の各 useEffect の依存配列
  // （[selectedFile, mdLive]）に入っているため、prop 省略時は毎レンダーで
  // md_subscribe 再送・handlers 差し替えが起き続ける（Board 経由では
  // useRef で参照が固定されるため顕在化しないが、既定値だけが不安定だった）。
  // useRef による遅延初期化で、コンポーネントのライフタイム内は同一
  // インスタンスを使い続けるようにする（テスト間の state 漏れ防止のため
  // モジュールスコープの単一定数にはしない）。
  const noopMdLiveRef = useRef<MdLiveChannel | undefined>(undefined);
  if (!noopMdLiveRef.current) {
    noopMdLiveRef.current = createNoopMdLiveChannel();
  }
  const mdLive = mdLiveProp ?? noopMdLiveRef.current;

  // 初期状態は閉じておく（設計判断: 起動直後から広いパネルを占有させず、
  // 明示的に開いたときだけファイルツリー・プレビューを表示する）。
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH_PX);
  // FileTree への再取得トリガー（#68）。値の変化のみで FileTree 側の
  // useEffect が再フェッチする（宣言的な結線。ポーリングはしない）。
  // パネルオープン時の取得は FileTree のマウント自体が担う（body ごと
  // 開閉でアンマウント/リマウントされるため）。
  const [refreshToken, setRefreshToken] = useState(0);
  // FileTree で選択されたファイル（#69）。null は未選択。
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [fileContent, setFileContent] = useState<FileContentState>({
    status: "idle",
  });
  // md_file_changed 受信時の再フェッチトリガー（#70）。selectedFile は
  // 変えずにこの値だけを進めることで、下の GET /api/md/file 取得 effect を
  // 再実行させる（refreshToken と同じ宣言的な再取得パターン）。
  const [mdReloadToken, setMdReloadToken] = useState(0);
  // md_subscribe_error を受けたら true にし、「ライブ更新は無効」の注記を
  // 表示する（#70）。新しいファイルを開く・購読し直すたびにリセットする。
  const [liveUpdateDisabled, setLiveUpdateDisabled] = useState(false);
  // blocker修正: GET /api/md/file 取得 effect（[selectedFile, mdReloadToken]
  // 依存）は「新しいファイルが選択された」場合と「同じファイルのまま
  // md_file_changed / onReconnected によりサイレントリフレッシュがトリガー
  // された」場合の両方で再実行される。後者で無条件に loading 状態へ落とすと
  // 表示中の <Markdown> がアンマウントされ、.preview-panel-markdown の
  // スクロール位置が（実ブラウザでは scrollHeight のクランプにより）先頭へ
  // ジャンプしてしまう。直前にこの effect が実際にフェッチした selectedFile
  // を記録しておき、参照が変わった（＝新しいファイルが選択された）場合のみ
  // loading 表示に落とす。サイレントリフレッシュでは直前の内容を保持した
  // まま裏で取得し、成功/失敗時にのみ置き換える。
  const lastFetchedFileRef = useRef<SelectedFile | null>(null);

  // Issue #135: 外部（AgentColumn の優先度方針バッジ）からの openRequest を
  // FileTree でのクリック選択と同じ経路へ合流させる。openRequest.requestId
  // が変わるたびにパネルを開き、選択ファイルを差し替える（セルフレビュー
  // 指摘対応: 依存配列を requestId に限定し、「requestId が増分されない限り
  // 再発火しない」という契約を effect の実装でも明示する）。FileTree 自身の
  // selectedKey ハイライトは更新されない（FileTree はマウント時に自分の
  // 一覧取得を経由してしか選択状態を持たない設計のため）が、「既存の md
  // プレビューパネルに方針ファイルを開くだけでも可」という要件は満たす
  // （YAGNI: ツリー側のハイライト同期までは行わない）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: openRequest 全体ではなく requestId の変化のみを再発火のトリガーとする意図的な依存配列（上記コメント参照）。effect 本体では openRequest.repo/path を読むが、それらは同一 requestId 内では不変という契約のため問題ない
  useEffect(() => {
    if (!openRequest) {
      return;
    }
    setOpen(true);
    setSelectedFile({ repo: openRequest.repo, path: openRequest.path });
  }, [openRequest?.requestId]);

  // 選択ファイルが変わるたびに md_subscribe を送信する（#70）。プレビュー
  // 対象の切替時にクライアントから明示的な md_unsubscribe は送らない
  // （サーバが1クライアント1購読の自動解除に委ねる。親 Issue #61 の決定）。
  useEffect(() => {
    if (!selectedFile) {
      return;
    }
    setLiveUpdateDisabled(false);
    mdLive.subscribe(selectedFile.repo, selectedFile.path);
  }, [selectedFile, mdLive]);

  // WS から届く md_file_changed / md_subscribe_error / onReconnected を、
  // 現在開いているファイルと一致する場合のみ処理する（#70）。mdLive.handlers
  // は PreviewPanel が唯一の購読者であることを前提にした単一スロットのため、
  // selectedFile が変わるたびに最新のクロージャで差し替える。
  useEffect(() => {
    mdLive.handlers.onFileChanged = (message) => {
      if (
        selectedFile &&
        message.repo === selectedFile.repo &&
        message.path === selectedFile.path
      ) {
        setMdReloadToken((prev) => prev + 1);
      }
    };
    mdLive.handlers.onSubscribeError = (message) => {
      if (
        selectedFile &&
        message.repo === selectedFile.repo &&
        message.path === selectedFile.path
      ) {
        setLiveUpdateDisabled(true);
      }
    };
    // セルフレビュー指摘: WS は切断されると自動再接続するが（ws.ts の既存
    // ロジック）、サーバ側の購読はクライアント接続単位で保持されるため、
    // 再接続後の新しい接続には以前の md_subscribe が引き継がれない。
    // selectedFile 自体は変化しないため上の subscribe effect（[selectedFile,
    // mdLive] 依存）は再実行されず、無警告のままライブ更新が恒久的に
    // 止まってしまう。Board 側は WS が open 状態になるたび（初回接続・
    // 再接続の両方）に onReconnected を呼ぶので、選択中のファイルがあれば
    // 再度 subscribe し直す。
    mdLive.handlers.onReconnected = () => {
      if (selectedFile) {
        // セルフレビュー指摘（2周目）: subscribe だけ呼び直すと、一時的な
        // md_subscribe_error（例: アトミック保存中の一瞬の不在で realpath
        // 解決が失敗する等）で注記を表示した後に再接続で購読が回復しても
        // 「ライブ更新は無効です」が表示残骸として残り続ける（selectedFile
        // が変わらないため subscribe effect 側のリセットは通らない）。
        // 再購読のたびに一旦リセットし、購読が失敗すれば
        // onSubscribeError が改めて true に戻す。
        setLiveUpdateDisabled(false);
        mdLive.subscribe(selectedFile.repo, selectedFile.path);
        // blocker修正: WS 切断中（サーバ再起動等）に発生したファイル変更は
        // 対応する md_file_changed を受け取れないため、再接続時に subscribe
        // し直すだけでは次の保存まで反映されない。再接続のたびに一度だけ
        // 再フェッチする（サイレントリフレッシュとして扱われるため、blocker 1
        // の修正と合わせて表示が乱れることはない）。
        setMdReloadToken((prev) => prev + 1);
      }
    };
    return () => {
      mdLive.handlers.onFileChanged = undefined;
      mdLive.handlers.onSubscribeError = undefined;
      mdLive.handlers.onReconnected = undefined;
    };
  }, [selectedFile, mdLive]);

  // 選択ファイルが変わる、または md_file_changed により再フェッチが
  // トリガーされるたびに GET /api/md/file を取得する。CardDetailModal /
  // FileTree と同じ fetch パターン（cancelled フラグ・AbortController不使用）。
  // ファイル内容は WS からは受け取らず、常にこの HTTP 経路で取得する
  // （親 Issue #61 の決定）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: mdReloadToken は本体で読まないが、md_file_changed 受信のたびに再フェッチを発火させる意図的なトリガー依存（FileTree.tsx の refreshToken と同じパターン。#70）
  useEffect(() => {
    if (!selectedFile) {
      setFileContent({ status: "idle" });
      lastFetchedFileRef.current = null;
      return;
    }

    // selectedFile は同一ファイルの再選択では state 更新自体が起きない
    // （handleSelectFile のガード）ため、参照比較だけで「新しいファイルが
    // 選択されたのか」「同じファイルのままサイレントリフレッシュが
    // トリガーされたのか」を区別できる。
    const isFileChange = lastFetchedFileRef.current !== selectedFile;
    lastFetchedFileRef.current = selectedFile;

    let cancelled = false;
    if (isFileChange) {
      setFileContent({ status: "loading" });
    }
    // isFileChange が false（サイレントリフレッシュ）の場合はここで
    // fileContent を更新しない。直前の表示内容（success/error のいずれか）
    // をそのまま保持し、下の then/catch で結果が届いた時点でのみ置き換える。

    const url = `/api/md/file?repo=${encodeURIComponent(selectedFile.repo)}&path=${encodeURIComponent(selectedFile.path)}`;

    fetch(url)
      .then((response) => {
        if (response.status === 413) {
          throw new Error("payload-too-large");
        }
        if (!response.ok) {
          throw new Error(`unexpected status: ${response.status}`);
        }
        return response.json() as Promise<MdFileResponse>;
      })
      .then((data) => {
        if (!cancelled) {
          setFileContent({ status: "success", content: data.content });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setFileContent({
            status: "error",
            message:
              err instanceof Error && err.message === "payload-too-large"
                ? TOO_LARGE_ERROR_MESSAGE
                : GENERIC_FILE_ERROR_MESSAGE,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFile, mdReloadToken]);

  // セルフレビュー指摘: FileTree はクリックのたびに無条件で onSelectFile を
  // 呼ぶため、既に表示中のファイルを再クリックしただけでも
  // `setSelectedFile({ repo, path })` が毎回新しいオブジェクトを生成し、
  // useEffect（[selectedFile] 依存）が再実行されて表示中の内容が一瞬 loading
  // に戻ってしまう（表示中の内容の再取得自体は無害だが、ちらつきは無用な
  // UX劣化）。同一ファイルの選択は state を更新せず無視する。
  const handleSelectFile = (repo: string, path: string) => {
    setSelectedFile((prev) =>
      prev && prev.repo === repo && prev.path === path ? prev : { repo, path },
    );
  };

  // セルフレビュー指摘: パネルを閉じると FileTree は body ごとアンマウント
  // され選択ハイライト（selectedKey）は破棄される一方、閉じる前に選択して
  // いたファイルの内容だけが PreviewPanel 側に残り続け、再度開いたときに
  // 「ツリーは未選択なのにプレビューだけ前回のファイルが表示されたまま」
  // という食い違いが生じる（FileTree.tsx が #69 への申し送りとして明記して
  // いた論点）。閉じる操作の時点で選択ファイル・取得内容を破棄し、FileTree
  // 側のライフサイクル（開くたびに白紙から選び直す）に合わせる。
  //
  // #70: WS 接続自体は維持されたままパネルだけを閉じるため、サーバ側の
  // 自動解除（subscribe 切替・WS 切断）は働かない。watch リークを防ぐため、
  // 閉じる操作時に限り明示的に md_unsubscribe を送信する（親 Issue #61 の
  // 決定）。
  const handleToggleOpen = () => {
    if (open) {
      if (selectedFile) {
        mdLive.unsubscribe(selectedFile.repo, selectedFile.path);
      }
      setSelectedFile(null);
      // セルフレビュー指摘: liveUpdateDisabled は「選択ファイルが変わった
      // 際にのみリセットする」効果（subscribe effect 内）に頼っていたため、
      // 閉じる操作（selectedFile を null にするだけの経路）ではリセット
      // されず、再オープン直後（ファイル未選択）に「ライブ更新は無効です」
      // という表示残骸が残っていた（購読していないファイルの無効警告が
      // 出続ける）。閉じる時点で明示的にリセットする。
      setLiveUpdateDisabled(false);
    }
    setOpen((prev) => !prev);
  };

  const handleResizeMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    // ドラッグ中にテキスト選択が始まらないようにする（TerminalPane の
    // 既存パターンに合わせる。#44/#51 のコピー/ペースト体験を壊さないため）。
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // パネルは画面左端に位置し、ハンドルは右端にある（#112）。ハンドルを
      // 右へドラッグする（delta が正）ほどパネル幅が増える。
      const delta = moveEvent.clientX - startX;
      setWidth(clamp(startWidth + delta, MIN_WIDTH_PX, MAX_WIDTH_PX));
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // マウスドラッグの代替経路（TerminalPane の既存パターンに合わせる）。
    // ハンドルの物理的な移動方向とキー方向を一致させ、マウス・キーボード両
    // 経路で同じ向きにする（右サイド時代のセルフレビュー指摘で確立した
    // 原則）。#112 でパネルが左サイドへ移りハンドルは右端にあるため、
    // ArrowRight（ハンドルが右へ移動）で増加・ArrowLeft で減少にする。
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setWidth((prev) =>
        clamp(prev + RESIZE_STEP_PX, MIN_WIDTH_PX, MAX_WIDTH_PX),
      );
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setWidth((prev) =>
        clamp(prev - RESIZE_STEP_PX, MIN_WIDTH_PX, MAX_WIDTH_PX),
      );
    }
  };

  return (
    <div
      className="preview-panel"
      data-testid="preview-panel"
      style={{ width: open ? `${width}px` : undefined }}
    >
      <div className="preview-panel-content">
        <div className="preview-panel-header">
          {open && <span className="preview-panel-title">プレビュー</span>}
          {open && (
            <button
              type="button"
              className="preview-panel-refresh-button"
              data-testid="preview-panel-refresh-button"
              aria-label="ファイルツリーを更新"
              title="ファイルツリーを更新"
              // refreshToken を変化させるだけで FileTree 側の useEffect が
              // 再フェッチする（#68。宣言的な結線、ポーリングは追加しない）。
              onClick={() => setRefreshToken((prev) => prev + 1)}
            >
              ⟳
            </button>
          )}
          <button
            type="button"
            className="preview-panel-toggle-button"
            aria-label={
              open ? "プレビューパネルを閉じる" : "プレビューパネルを開く"
            }
            aria-expanded={open}
            aria-controls={open ? "preview-panel-body" : undefined}
            onClick={handleToggleOpen}
          >
            {/* セルフレビュー指摘: 日本語フルテキストのボタンだと閉じている
                間も ~170px 前後の横幅を常時占有し、「閉じたらボードへ幅を
                返す」という狙いに反する。TerminalPane の折りたたみボタン
                （アイコン + aria-label）と同じパターンにし、閉状態の
                footprint を最小化する。#112 で左サイドへ移ったため、
                矢印は「閉じる＝左へ畳む ◂」「開く＝右へ広がる ▸」の向き。 */}
            {open ? "◂" : "▸"}
          </button>
        </div>
        {open && (
          <div
            className="preview-panel-body"
            data-testid="preview-panel-body"
            id="preview-panel-body"
          >
            <div
              className="preview-panel-file-tree"
              data-testid="preview-panel-file-tree"
            >
              <FileTree
                refreshToken={refreshToken}
                onSelectFile={handleSelectFile}
              />
            </div>
            <div
              className="preview-panel-markdown"
              data-testid="preview-panel-markdown"
            >
              {liveUpdateDisabled && (
                <div
                  className="preview-panel-live-update-disabled"
                  data-testid="preview-panel-live-update-disabled"
                >
                  {LIVE_UPDATE_DISABLED_MESSAGE}
                </div>
              )}
              {fileContent.status === "idle" && (
                <div className="preview-panel-markdown-placeholder">
                  ファイルツリーからファイルを選択してください
                </div>
              )}
              {fileContent.status === "loading" && (
                <div className="preview-panel-markdown-loading">
                  ファイルを読み込んでいます...
                </div>
              )}
              {fileContent.status === "error" && (
                <div className="preview-panel-markdown-error">
                  {fileContent.message}
                </div>
              )}
              {fileContent.status === "success" && (
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={markdownComponents}
                >
                  {fileContent.content}
                </Markdown>
              )}
            </div>
          </div>
        )}
      </div>
      {/* #112: パネルが左サイドにあるため、幅ドラッグのハンドルは右端に
          置く（コンテンツの後に描画する。.preview-panel は flex row）。 */}
      {open && (
        <div
          className="preview-panel-resize-handle"
          data-testid="preview-panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH_PX}
          aria-valuemax={MAX_WIDTH_PX}
          aria-label="プレビューパネルの幅"
          tabIndex={0}
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
        />
      )}
    </div>
  );
}
