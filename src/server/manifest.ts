import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FLEET_MANIFEST_ENV_KEY = "FLYWHEEL_FLEET_MANIFEST";

export type FleetEntry = { name: string; path: string };

export function resolveFleetManifestPath(overridePath?: string): string {
  if (overridePath) {
    return overridePath;
  }
  const fromEnv = process.env[FLEET_MANIFEST_ENV_KEY];
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".flywheel", "fleet.tsv");
}

/**
 * fleet.tsv（`<name>\t<path>` の2列。`#` コメント行・空行は無視）を読み込む。
 *
 * fleet.tsv は人間が手で書く少数行の起動設定ファイルであり、台帳のような
 * 「壊れていても他を活かす」設計は採用しない。不正な行が1つでもあれば
 * 即座に Error を throw する。
 */
export function loadFleetManifest(overridePath?: string): FleetEntry[] {
  const manifestPath = resolveFleetManifestPath(overridePath);

  let content: string;
  try {
    content = fs.readFileSync(manifestPath, "utf-8");
  } catch {
    throw new Error(
      `fleet マニフェストが見つかりません: ${manifestPath}（FLYWHEEL_FLEET_MANIFEST 環境変数か引数でパスを指定してください）`,
    );
  }

  const entries: FleetEntry[] = [];
  const seenNames = new Set<string>();
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const fields = line.split("\t");
    if (fields.length !== 2) {
      throw new Error(
        `fleet マニフェストの ${lineNo} 行目が不正です（<name>\\t<path> の2列である必要があります）: "${line}"`,
      );
    }

    const name = fields[0]?.trim() ?? "";
    const entryPath = fields[1]?.trim() ?? "";

    if (name === "" || entryPath === "") {
      throw new Error(
        `fleet マニフェストの ${lineNo} 行目が不正です（name / path のいずれかが空です）: "${line}"`,
      );
    }

    if (seenNames.has(name)) {
      throw new Error(
        `fleet マニフェストの ${lineNo} 行目が不正です（name "${name}" が重複しています）: "${line}"`,
      );
    }
    seenNames.add(name);

    entries.push({ name, path: entryPath });
  }

  return entries;
}
