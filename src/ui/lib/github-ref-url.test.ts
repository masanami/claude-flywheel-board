import { describe, expect, it } from "vitest";
import { buildGithubRefUrl } from "./github-ref-url.ts";

describe("buildGithubRefUrl", () => {
  it("関連リポジトリはリポジトリのトップページ URL になる", () => {
    expect(
      buildGithubRefUrl(
        {
          raw: "masanami/claude-flywheel",
          owner: "masanami",
          repo: "claude-flywheel",
        },
        "repo",
      ),
    ).toBe("https://github.com/masanami/claude-flywheel");
  });

  it("関連Issue は /issues/<番号> の URL になる", () => {
    expect(
      buildGithubRefUrl(
        {
          raw: "claude-flywheel#87",
          owner: "masanami",
          repo: "claude-flywheel",
          number: 87,
        },
        "issue",
      ),
    ).toBe("https://github.com/masanami/claude-flywheel/issues/87");
  });

  it("関連PR は /pull/<番号> の URL になる", () => {
    expect(
      buildGithubRefUrl(
        {
          raw: "claude-flywheel#93",
          owner: "masanami",
          repo: "claude-flywheel",
          number: 93,
        },
        "pull",
      ),
    ).toBe("https://github.com/masanami/claude-flywheel/pull/93");
  });

  it("owner を解決できなかった参照は undefined を返す（リンク化しない）", () => {
    expect(
      buildGithubRefUrl({ raw: "other-repo#12" }, "issue"),
    ).toBeUndefined();
    expect(
      buildGithubRefUrl({ raw: "board のリポジトリ" }, "repo"),
    ).toBeUndefined();
  });

  it("番号を持たない参照を Issue / PR として組み立てようとした場合は undefined を返す", () => {
    const repoOnly = {
      raw: "masanami/claude-flywheel",
      owner: "masanami",
      repo: "claude-flywheel",
    };

    expect(buildGithubRefUrl(repoOnly, "issue")).toBeUndefined();
    expect(buildGithubRefUrl(repoOnly, "pull")).toBeUndefined();
  });
});
