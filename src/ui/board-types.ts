// UI 側の型は server 側の型をそのまま再利用し、独自解釈を持ち込まない（NFR-05）。
// 台帳フォーマットの正本は claude-flywheel 側ドキュメント。
//
// type-only re-export のため、tsconfig の `verbatimModuleSyntax` +
// `erasableSyntaxOnly` によりビルド時に完全に消去される。node:fs に依存する
// server コードがブラウザバンドルへ混入する心配はない。
export type {
  AgentBoard,
  AgentCycleStatus,
  BoardSnapshot,
} from "../server/cache.ts";
export type { Challenge, LedgerStatus } from "../server/parsers/ledger.ts";
export type { ParseError, LogEntry } from "../server/parsers/types.ts";
export type { Run } from "../server/parsers/runs.ts";
