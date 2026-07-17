import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "./components/Board.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

createRoot(container).render(
  <StrictMode>
    <Board />
  </StrictMode>,
);
