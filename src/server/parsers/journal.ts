import { readFile } from "node:fs/promises";

// journal/index.jsonl のスキーマ（正本: claude-flywheel 側 templates/journal/README.md）。
// フィールド名・構造はスキーマ通りとし、独自フィールドを追加しない（NFR-05）。

export type TouchedIssue = {
  id: string;
  from: string;
  to: string;
};

export type Delegation = {
  repo: string;
  skill: string;
  session_id: string;
  result: string;
};

export type PendingApproval = {
  gate: string;
  issue: string;
  summary: string;
};

export type JournalEntry = {
  date: string;
  seq: number;
  touched_issues: TouchedIssue[];
  delegations: Delegation[];
  pr_urls: string[];
  pending_approvals: PendingApproval[];
  decisions: string[];
};

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStringFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, string> {
  if (!isPlainObject(value)) return false;
  return fields.every((field) => typeof value[field] === "string");
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

const TOUCHED_ISSUE_FIELDS = ["id", "from", "to"] as const;
const DELEGATION_FIELDS = ["repo", "skill", "session_id", "result"] as const;
const PENDING_APPROVAL_FIELDS = ["gate", "issue", "summary"] as const;

function validateJournalEntry(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return "journal entry は JSON オブジェクトである必要があります";
  }
  const record = value as Record<string, unknown>;

  if (typeof record.date !== "string" || record.date === "") {
    return "date は空でない string である必要があります";
  }
  if (typeof record.seq !== "number") {
    return "seq は number である必要があります";
  }
  if (
    !Array.isArray(record.touched_issues) ||
    !record.touched_issues.every((item) =>
      hasStringFields(item, TOUCHED_ISSUE_FIELDS),
    )
  ) {
    return "touched_issues は { id, from, to } (string) の配列である必要があります";
  }
  if (
    !Array.isArray(record.delegations) ||
    !record.delegations.every((item) =>
      hasStringFields(item, DELEGATION_FIELDS),
    )
  ) {
    return "delegations は { repo, skill, session_id, result } (string) の配列である必要があります";
  }
  if (!isStringArray(record.pr_urls)) {
    return "pr_urls は string の配列である必要があります";
  }
  if (
    !Array.isArray(record.pending_approvals) ||
    !record.pending_approvals.every((item) =>
      hasStringFields(item, PENDING_APPROVAL_FIELDS),
    )
  ) {
    return "pending_approvals は { gate, issue, summary } (string) の配列である必要があります";
  }
  if (!isStringArray(record.decisions)) {
    return "decisions は string の配列である必要があります";
  }

  return undefined;
}

export async function parseJournal(
  filePath: string,
): Promise<{ entries: JournalEntry[]; errors: ParseError[] }> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");

  const entries: JournalEntry[] = [];
  const errors: ParseError[] = [];

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    if (rawLine.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (error) {
      errors.push({
        file: filePath,
        line: lineNumber,
        message: error instanceof Error ? error.message : String(error),
        raw: rawLine,
      });
      continue;
    }

    const validationError = validateJournalEntry(parsed);
    if (validationError) {
      errors.push({
        file: filePath,
        line: lineNumber,
        message: validationError,
        raw: rawLine,
      });
      continue;
    }

    entries.push(parsed as JournalEntry);
  }

  return { entries, errors };
}

type LogEntryMatch = {
  date: string;
  seq: number;
  text: string;
};

export function deriveLogEntries(
  entries: JournalEntry[],
  challengeId: string,
): LogEntry[] {
  const matches: LogEntryMatch[] = [];

  for (const entry of entries) {
    for (const touched of entry.touched_issues) {
      if (touched.id === challengeId) {
        matches.push({
          date: entry.date,
          seq: entry.seq,
          text: `${touched.from} → ${touched.to}`,
        });
      }
    }
    for (const approval of entry.pending_approvals) {
      if (approval.issue === challengeId) {
        matches.push({
          date: entry.date,
          seq: entry.seq,
          text: `${approval.gate}: ${approval.summary}`,
        });
      }
    }
  }

  matches.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.seq - b.seq;
  });

  return matches.map((match) => ({
    ts: match.date,
    source: "journal",
    text: match.text,
  }));
}

export function deriveSummary(
  entries: JournalEntry[],
  challengeId: string,
): string | undefined {
  const logEntries = deriveLogEntries(entries, challengeId);
  return logEntries.at(-1)?.text;
}
