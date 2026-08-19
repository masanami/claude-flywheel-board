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
export type {
  Challenge,
  ChallengeRef,
  LedgerStatus,
} from "../server/parsers/ledger.ts";
export type {
  PriorityPolicy,
  PriorityPolicyStatus,
} from "../server/parsers/priority-policy.ts";
export type { ParseError, LogEntry } from "../server/parsers/types.ts";
export type { Run, RunProvenance } from "../server/parsers/runs.ts";
export type { MdFileResponse } from "../server/api.ts";
export type { PreviewKind } from "../server/md/path-validation.ts";
export type { MdTreeRepo, MdTreeResponse } from "../server/md/tree.ts";
export type {
  MdFileChangedMessage,
  MdSubscribeErrorMessage,
} from "../server/md/watch.ts";
