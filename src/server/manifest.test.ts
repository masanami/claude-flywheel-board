import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadFleetManifest, resolveFleetManifestPath } from "./manifest.ts";

const FIXTURES_ROOT = fileURLToPath(
  new URL("../../tests/fixtures/fleet/", import.meta.url),
);

describe("resolveFleetManifestPath", () => {
  const ENV_KEY = "FLYWHEEL_FLEET_MANIFEST";
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
  });

  it("引数で明示されたパスを最優先で返す", () => {
    process.env[ENV_KEY] = "/env/fleet.tsv";

    const resolved = resolveFleetManifestPath("/explicit/fleet.tsv");

    expect(resolved).toBe("/explicit/fleet.tsv");
  });

  it("引数が無い場合は環境変数 FLYWHEEL_FLEET_MANIFEST を返す", () => {
    process.env[ENV_KEY] = "/env/fleet.tsv";

    const resolved = resolveFleetManifestPath();

    expect(resolved).toBe("/env/fleet.tsv");
  });

  it("引数・環境変数どちらも無い場合は既定値 ~/.flywheel/fleet.tsv を返す", () => {
    delete process.env[ENV_KEY];

    const resolved = resolveFleetManifestPath();

    expect(resolved).toBe(path.join(os.homedir(), ".flywheel", "fleet.tsv"));
  });
});

describe("loadFleetManifest", () => {
  it("コメント行・空行を無視して FleetEntry[] を返す", () => {
    const entries = loadFleetManifest(`${FIXTURES_ROOT}valid.tsv`);

    expect(entries).toEqual([
      { name: "medical", path: "/repos/medical-agent" },
      { name: "bi", path: "/repos/bi-agent" },
    ]);
  });

  it("ファイルが存在しない場合はその旨のメッセージで Error を throw する", () => {
    const missingPath = `${FIXTURES_ROOT}does-not-exist.tsv`;

    expect(() => loadFleetManifest(missingPath)).toThrowError(/見つかりません/);
  });

  it("tab 区切りでない行があれば Error を throw する（行番号・原文を含む）", () => {
    const malformedPath = `${FIXTURES_ROOT}malformed-missing-tab.tsv`;

    expect(() => loadFleetManifest(malformedPath)).toThrowError(
      /2 行目.*bi \/repos\/bi-agent/s,
    );
  });

  it("name / path が空フィールドの行があれば Error を throw する", () => {
    const malformedPath = `${FIXTURES_ROOT}malformed-empty-field.tsv`;

    expect(() => loadFleetManifest(malformedPath)).toThrowError(/2 行目/);
  });

  it("name が重複していれば Error を throw する", () => {
    const malformedPath = `${FIXTURES_ROOT}malformed-duplicate-name.tsv`;

    expect(() => loadFleetManifest(malformedPath)).toThrowError(
      /重複.*medical/s,
    );
  });
});
