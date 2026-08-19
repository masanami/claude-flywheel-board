import type { ChallengeRef } from "../board-types.ts";

/**
 * 参照フィールドの種別。台帳のフィールド（関連リポジトリ / 関連Issue / 関連PR）に 1:1 で対応する。
 */
export type GithubRefKind = "repo" | "issue" | "pull";

const GITHUB_ORIGIN = "https://github.com";

/**
 * 台帳の参照（`<owner>/<repo>` / `<owner>/<repo>#<番号>`）から GitHub の URL を組み立てる。
 *
 * 台帳には URL ではなく短い参照だけが書かれ、**リンク化は消費側（board）の責務**
 * （claude-flywheel `docs/challenge-ledger-format.md` §関連リポジトリ・関連Issue・関連PR）。
 * owner を解決できなかった参照（短縮形で同エントリの関連リポジトリに同名 repo が無い、
 * 自由記述・URL 直書き等）は undefined を返し、呼び出し側はテキストのまま表示する。
 */
export function buildGithubRefUrl(
  ref: ChallengeRef,
  kind: GithubRefKind,
): string | undefined {
  if (ref.owner === undefined || ref.repo === undefined) {
    return undefined;
  }
  const repoUrl = `${GITHUB_ORIGIN}/${ref.owner}/${ref.repo}`;
  if (kind === "repo") {
    return repoUrl;
  }
  if (ref.number === undefined) {
    return undefined;
  }
  return kind === "issue"
    ? `${repoUrl}/issues/${ref.number}`
    : `${repoUrl}/pull/${ref.number}`;
}
