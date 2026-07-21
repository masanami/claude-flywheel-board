import type { FleetEntry } from "../manifest.ts";

/**
 * ターミナル接続の種別。"agent" はエージェント（Claude Code セッション）、
 * "shell" は手動コマンド操作用の独立セッション（#57）。
 */
export type TerminalSessionKind = "agent" | "shell";

/**
 * tmux セッション名の規約（architecture.md §3.5）:
 * - kind: "agent"（既定・後方互換）: `flywheel-<agent-name>`
 * - kind: "shell"（#57）: `flywheel-<agent-name>-shell`（手動シェル用の独立セッション）
 *
 * 命名の前提: 接尾辞 `-shell` は本用途で予約する。agent 名 `foo-shell` を
 * 許すと agent `foo` の shell セッション名（`flywheel-foo-shell`）と衝突しうるため、
 * `-shell` で終わる agent 名は `loadFleetManifest`（manifest.ts）が読み込み時に
 * 拒否する。これにより衝突は構造的に発生しない。
 */
export function terminalSessionName(
  agentName: string,
  kind: TerminalSessionKind = "agent",
): string {
  return kind === "shell"
    ? `flywheel-${agentName}-shell`
    : `flywheel-${agentName}`;
}

/**
 * fleet マニフェストに登録された name のみ受け付ける。
 *
 * クリティカル設計決定（親 Issue #2 / #14）: agent はマニフェスト登録名のみ許可し、
 * 任意パスでのセッション生成を禁止する。path は常にこの entry（マニフェスト由来）
 * から取得し、リクエスト側から path を直接受け取ることは無い。
 */
export function resolveAgentEntry(
  fleetEntries: readonly FleetEntry[],
  agentName: string | null,
): FleetEntry | undefined {
  if (!agentName) {
    return undefined;
  }
  return fleetEntries.find((entry) => entry.name === agentName);
}
