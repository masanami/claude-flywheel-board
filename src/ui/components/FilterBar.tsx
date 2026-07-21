export type BoardFilter = "all" | "needsHuman";

type FilterBarProps = {
  value: BoardFilter;
  onChange: (value: BoardFilter) => void;
  // 完了ステータスの表示トグル（Issue #50 ②）。すべて/承認待ちの相互排他
  // チップとは独立した状態のため、FILTERS のチップ群には混ぜず別ボタンとして描画する。
  showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  // アーカイブビュー表示トグル（Issue #50 ①）。true の間は盤面全体がライブ台帳
  // からアーカイブ（challenge-archive*.md）表示に切り替わる（Board.tsx 側）。
  archiveMode: boolean;
  onArchiveModeChange: (value: boolean) => void;
};

const FILTERS: Array<{ value: BoardFilter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "needsHuman", label: "🔔 承認待ち" },
];

export function FilterBar({
  value,
  onChange,
  showCompleted,
  onShowCompletedChange,
  archiveMode,
  onArchiveModeChange,
}: FilterBarProps) {
  // アーカイブ表示中はライブ台帳向けのフィルタ（すべて/承認待ちチップ・完了を
  // 表示トグル）が意味を持たない（アーカイブは常に「完了」のみで needsHuman も
  // 常に false）。相互作用を明確にするため、アーカイブ表示中は一律で無効化する。
  const liveFiltersDisabled = archiveMode;
  return (
    <div className="filter-bar">
      {FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          className="filter-chip"
          aria-pressed={filter.value === value}
          disabled={liveFiltersDisabled}
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
        </button>
      ))}
      <button
        type="button"
        className="filter-chip filter-toggle"
        aria-pressed={showCompleted}
        // 承認待ちフィルタ選択中は 完了 が needsHuman になることが無く常に
        // 除外されたままのため（ledger.ts: needsHuman は 計画承認待ち/完了確認待ち
        // のみ）、トグルを切り替えても表示に反映されない no-op になる。
        // 「効かないボタン」に見えてしまうのを避けるため無効化する。
        // アーカイブ表示中も同様に no-op（表示対象がそもそも archivedChallenges
        // に切り替わるため）のため合わせて無効化する。
        disabled={liveFiltersDisabled || value === "needsHuman"}
        onClick={() => onShowCompletedChange(!showCompleted)}
      >
        完了を表示
      </button>
      <button
        type="button"
        className="filter-chip filter-archive-toggle"
        aria-pressed={archiveMode}
        onClick={() => onArchiveModeChange(!archiveMode)}
      >
        🗄 アーカイブ表示
      </button>
    </div>
  );
}
