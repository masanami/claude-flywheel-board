import type { FleetEntry } from "../manifest.ts";

/**
 * tmux セッション名の規約: `flywheel-<agent-name>`（architecture.md §3.5）。
 */
export function terminalSessionName(agentName: string): string {
  return `flywheel-${agentName}`;
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
