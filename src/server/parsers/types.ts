// パーサ間で共有する型の単一定義。
//
// 経緯（セルフレビュー指摘対応）: ParseError は ledger.ts / journal.ts / runs.ts の
// 3ファイルにそれぞれ個別定義されていた（三重定義）。実体は同一形状のため、
// ここに単一定義し、各ファイルは import + re-export（後方互換のため）する形に
// 揃える。
//
// LogEntry も同様に journal.ts 内定義だったが、runs.ts が
// `import type { LogEntry } from "./journal.ts"` として参照しており、
// 「runs → journal」という誤った依存方向（journal 由来のログ専用の型に runs が
// 依存する形）になっていた。LogEntry は journal/runs 双方から生成される
// 共有の素材型であるため、両者から独立したこの types.ts に定義を移し、
// journal.ts / runs.ts はどちらも同じ場所から import する（依存方向の是正）。
export type ParseError = {
  file: string;
  line?: number;
  message: string;
  raw: string;
};

export type LogEntry = {
  ts: string;
  source: "journal" | "ledger" | "runs";
  text: string;
};
