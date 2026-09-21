import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";

// mermaid 図の描画コンポーネント（マークダウンプレビューのコードブロック
// 〔PreviewPanel〕と、カード詳細の一枚絵〔ChallengeFig・Issue #180〕の共用）。
//
// **描画の安全性に関する決定はこのファイルが唯一の正本**（元は PreviewPanel.tsx
// 内のローカルコンポーネント。fig の追加で 2 箇所目の利用者ができたため、
// securityLevel の主張・レンダリングの直列化・コンテナ隔離が複製されて
// 片方だけ弱くなることが無いよう、ここへ括り出した）。

export const MERMAID_RENDER_ERROR_MESSAGE = "mermaid 図の描画に失敗しました";

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

type MermaidDiagramProps = {
  /** mermaid のソース（コードフェンスを含まない本体）。 */
  code: string;
  /**
   * 描画に失敗したときの通知（任意）。既定の失敗時表示（本コンポーネントが
   * 出すエラーメッセージ）で足りる呼び出し元は渡さなくてよい。図の領域ごと
   * 畳みたい呼び出し元（ChallengeFig）はこれを受けて自分を非表示にする
   * ——その場合は本コンポーネントごとアンマウントされるため、下のエラー
   * メッセージは表示されない。
   */
  onRenderFailed?: () => void;
};

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
export function MermaidDiagram({ code, onRenderFailed }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  // onRenderFailed は呼び出し元の再レンダーのたびに新しい関数参照になりうる。
  // 描画の effect は code の変化だけで走らせたい（同じ図を再描画しない）ため、
  // 依存配列には入れず ref 経由で常に最新を参照する（CardDetailModal の
  // onClose と同じ扱い）。
  const onRenderFailedRef = useRef(onRenderFailed);
  useEffect(() => {
    onRenderFailedRef.current = onRenderFailed;
  }, [onRenderFailed]);

  useEffect(() => {
    initializeMermaidStrict();
    let cancelled = false;
    setFailed(false);
    // 直前の描画結果（成功時の SVG・失敗時の残骸）を持ち越さない。
    if (containerRef.current) {
      containerRef.current.innerHTML = "";
    }
    const id = `mermaid-diagram-${mermaidRenderSeq++}`;

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
          onRenderFailedRef.current?.();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className="mermaid-diagram-wrapper">
      <div
        className="mermaid-diagram"
        data-testid="mermaid-diagram"
        ref={containerRef}
      />
      {failed && (
        <div className="mermaid-diagram-error">
          {MERMAID_RENDER_ERROR_MESSAGE}
        </div>
      )}
    </div>
  );
}
