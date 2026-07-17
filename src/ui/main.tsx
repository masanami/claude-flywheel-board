import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "./components/Board.tsx";
import { TerminalPane } from "./components/TerminalPane.tsx";
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
