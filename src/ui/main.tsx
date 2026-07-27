import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "./components/Board.tsx";
import { TerminalPane } from "./components/TerminalPane.tsx";
// xterm 同梱 CSS: IME 変換中テキスト（.composition-view）のカーソル追従配置や
// ヘルパー textarea の隠蔽を担う。欠けると変換中テキストがターミナル上部に表示される
import "@xterm/xterm/css/xterm.css";
// rehype-highlight（PreviewPanel の Markdown コードブロック）が付与する
// hljs/hljs-* クラスの配色テーマ。これが無いとクラスは付くが視覚的な
// シンタックスハイライトは一切反映されない（セルフレビュー指摘）。
// board 全体はライト/ダーク両対応だが highlight.js のテーマは単色固定のため、
// 配色スキームに依らず可読なダーク系テーマを選ぶ（KISS。配色連動は本チケット
// のスコープ外・必要になれば再検討する）。
import "highlight.js/styles/github-dark.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

createRoot(container).render(
  <StrictMode>
    <div className="app-layout">
      <Board />
      <TerminalPane />
    </div>
  </StrictMode>,
);
