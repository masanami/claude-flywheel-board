import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "./components/Board.tsx";
import { TerminalPane } from "./components/TerminalPane.tsx";
// xterm 同梱 CSS: IME 変換中テキスト（.composition-view）のカーソル追従配置や
// ヘルパー textarea の隠蔽を担う。欠けると変換中テキストがターミナル上部に表示される
import "@xterm/xterm/css/xterm.css";
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
