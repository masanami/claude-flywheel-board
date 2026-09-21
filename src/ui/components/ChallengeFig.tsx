import { useEffect, useState } from "react";
import { MermaidDiagram } from "./MermaidDiagram.tsx";

// 課題の一枚絵（fig。Issue #180 / FR-14）。
//
// カード詳細モーダルは台帳の説明・タスク案・完了条件を文章だけで見せており、
// とくに計画承認（FR-13）の判断時に全体像をつかみにくい。**課題 1 件につき
// mermaid で描かれた図を 1 枚**表示し、文章を読む前に構造を見せる。
//
// 正本はエージェントのワークスペース直下 `figs/<課題ID>.mmd`（台帳と同じ階層）で、
// **board は読むだけ**（NFR-01。サーバ側の読み取りは src/server/figs.ts、
// 決定の経緯と運用は docs/features/challenge-fig.md）。台帳フォーマットには
// フィールドを足していない（足すと claude-flywheel との横断課題になるため）。
//
// **図が無いのは正常系**: 取得できなかった場合・描画に失敗した場合とも、この
// コンポーネントは null を返して**領域ごと畳む**。エラー表示もプレースホルダも
// 出さない——図は本文の理解を助ける補助であり、無いこと自体は課題の欠陥ではない
// ので、文章表示のレイアウトを一切崩さないことを優先する。
//
// 取得はモーダルを開いたタイミングのオンデマンド（GET /api/log と同じ方式）。

type FigState =
  // 未取得・不在・取得失敗・描画失敗をすべて「表示しない」に畳んだ状態。
  { status: "hidden" } | { status: "ready"; source: string };

type ChallengeFigProps = {
  agentName: string;
  challengeId: string;
};

export function ChallengeFig({ agentName, challengeId }: ChallengeFigProps) {
  const [state, setState] = useState<FigState>({ status: "hidden" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "hidden" });

    fetch(
      `/api/fig?agent=${encodeURIComponent(agentName)}&challenge=${encodeURIComponent(challengeId)}`,
    )
      .then((response) => {
        if (!response.ok) {
          // 404（図が無い）を含め、非 200 はすべて「図なし」に畳む。
          return undefined;
        }
        return response.json() as Promise<unknown>;
      })
      .then((body) => {
        if (cancelled) {
          return;
        }
        const source = (body as { source?: unknown } | undefined)?.source;
        // 空文字・空白のみのソースは mermaid が描画できないため、取得できても
        // 図なしとして扱う（空の図枠を出さない）。
        if (typeof source !== "string" || source.trim() === "") {
          return;
        }
        setState({ status: "ready", source });
      })
      .catch(() => {
        // ネットワーク断・JSON 破損も同じく図なしに畳む。
      });

    return () => {
      cancelled = true;
    };
  }, [agentName, challengeId]);

  if (state.status !== "ready") {
    return null;
  }

  return (
    <div className="card-detail-fig" data-testid="card-detail-fig">
      <dt>図</dt>
      <dd>
        <MermaidDiagram
          code={state.source}
          // 描画失敗時は図の領域だけを畳み、本文（説明・タスク案・完了条件）の
          // 表示は維持する。MermaidDiagram 自身のエラーメッセージは、この
          // state 更新でアンマウントされるため表示されない。
          onRenderFailed={() => setState({ status: "hidden" })}
        />
      </dd>
    </div>
  );
}
