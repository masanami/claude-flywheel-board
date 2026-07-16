import type { ParseError } from "../board-types.ts";

type ErrorCardProps = {
  error: ParseError;
};

// パースエラーの表示専用カード（観測専用・NFR-01）。破線ボーダーで通常カードと区別し、
// 1行要約と原文（raw）を等幅フォント・横スクロール可能な要素で表示する。
export function ErrorCard({ error }: ErrorCardProps) {
  const summary = `${error.file}:${error.line ?? "?"} — ${error.message}`;

  return (
    <div className="error-card">
      <div className="error-card-summary">{summary}</div>
      <pre className="error-card-raw">{error.raw}</pre>
    </div>
  );
}
