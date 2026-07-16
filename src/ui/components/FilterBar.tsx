export type BoardFilter = "all" | "needsHuman";

type FilterBarProps = {
  value: BoardFilter;
  onChange: (value: BoardFilter) => void;
};

const FILTERS: Array<{ value: BoardFilter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "needsHuman", label: "🔔 承認待ち" },
];

export function FilterBar({ value, onChange }: FilterBarProps) {
  return (
    <div className="filter-bar">
      {FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          className="filter-chip"
          aria-pressed={filter.value === value}
          onClick={() => onChange(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}
