// 上流フォーマット契約（claude-flywheel `contracts/`）の逐語コピーに対する
// パーサの受理方向・拒否方向の固定。vendoring の範囲・更新手順は
// tests/fixtures/contracts/VENDORING.md が正本。
//
// board は消費者に徹する（NFR-05）。ここでの期待値は**契約が宣言している読み取り結果**か、
// 契約が何も言っていない範囲での**board の観測結果の棚卸し**のどちらかで、
// board が契約を解釈し直した独自規則はここに書かない。
//
// スキーマ（`schemas/*.schema.json`）は ajv で実行し、**行単位の判定オラクル**として使う。
// フィクスチャの valid/ invalid/ の分けはファイル単位の粒度しか与えないが、
// `journal-index/invalid/not-json.jsonl` のように正常な行と壊れた行が混在するファイルがあるため。

import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parseJournal } from "./journal.ts";
import { parseLedger } from "./ledger.ts";
import { parseRuns } from "./runs.ts";

const CONTRACTS_ROOT = fileURLToPath(
  new URL("../../../tests/fixtures/contracts/", import.meta.url),
);
const FIXTURES_ROOT = path.join(CONTRACTS_ROOT, "fixtures");

type Kind = "valid" | "invalid";
type JsonlType = "journal-index" | "runs";

function fixtureDir(type: string, kind: Kind): string {
  return path.join(FIXTURES_ROOT, type, kind);
}

function fixtureNames(type: string, kind: Kind): string[] {
  return readdirSync(fixtureDir(type, kind)).sort();
}

/** 空行を除いた行を 1 始まりの行番号つきで返す（パーサ側の行番号と揃える）。 */
function jsonlLines(file: string): { line: number; raw: string }[] {
  return readFileSync(file, "utf-8")
    .split("\n")
    .map((raw, index) => ({ line: index + 1, raw }))
    .filter((entry) => entry.raw.trim() !== "");
}

/**
 * 上流スキーマをそのまま実行する判定オラクル。
 * `strict: false` は ajv 独自の追加検査を掛けないための指定（契約に無い規則を持ち込まない）。
 */
function compileSchema(type: JsonlType) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(
    JSON.parse(
      readFileSync(
        path.join(CONTRACTS_ROOT, "schemas", `${type}.schema.json`),
        "utf-8",
      ),
    ),
  );
}

const SCHEMAS: Record<JsonlType, ReturnType<typeof compileSchema>> = {
  "journal-index": compileSchema("journal-index"),
  runs: compileSchema("runs"),
};

/** スキーマから見た 1 行の判定。JSON として読めない行も「スキーマ不適合」に含める。 */
function schemaAccepts(type: JsonlType, raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return SCHEMAS[type](parsed) === true;
}

/** board のパーサから見た 1 ファイルの判定（拒否した行番号の集合）。 */
async function boardRejectedLines(
  type: JsonlType,
  file: string,
): Promise<Set<number>> {
  const result =
    type === "journal-index" ? await parseJournal(file) : await parseRuns(file);
  return new Set(
    result.errors
      .map((error) => error.line)
      .filter((line): line is number => line !== undefined),
  );
}

function locationsOf(type: JsonlType, kind: Kind): string[] {
  return fixtureNames(type, kind).map((name) => `${type}/${kind}/${name}`);
}

function fileOf(location: string): string {
  return path.join(FIXTURES_ROOT, location);
}

const ALL_JSONL_LOCATIONS: string[] = [
  ...locationsOf("journal-index", "valid"),
  ...locationsOf("journal-index", "invalid"),
  ...locationsOf("runs", "valid"),
  ...locationsOf("runs", "invalid"),
];

function typeOf(location: string): JsonlType {
  return location.startsWith("runs/") ? "runs" : "journal-index";
}

/**
 * **スキーマは拒否するが board は受理する行**の棚卸し。
 *
 * board は「壊れた状態を観測するための読み取り専用の面」であり、書き手向けの制約まで
 * 拒否する必要はない（拒否＝その行が board から見えなくなる＝観測の損失）。
 * ただし緩さが無意識に増えないよう、1 行ずつ理由を残して固定する。
 * 実態と食い違えば下のテストが落ちる（受理するようになった行の見落としも、
 * 直したのに残った古い記載も、どちらも検出する）。
 */
const KNOWN_LAX: Record<string, string> = {
  "runs/invalid/bad-ts.jsonl:1":
    'ts のスペース区切り（"2026-08-14 09:00:00"）。契約は T 区切り＋オフセット必須。board は Date.parse が解釈できる形を受理する。日付そのものの取り違えは起きない（暦日の実在は isValidTimestamp が別途検証する）が、オフセット省略はホストのローカル時刻として解釈される',
  "runs/invalid/key-unsafe-chars.jsonl:1":
    'session_id の使用禁止文字（" と \\）。書き手側の追記処理のエスケープ前提を守るための制約で、board は JSON.parse 済みの値を対応付けキーに使うだけ。拒否すると壊れた書き手の run が board から丸ごと消える',
  "runs/invalid/key-unsafe-chars.jsonl:2": "同上（adhoc_start の id）",
  "runs/invalid/key-unsafe-chars.jsonl:3": "同上（delegate_end の session_id）",
  "journal-index/invalid/seq-infinity.jsonl:2":
    "seq が -Infinity（スキーマは minimum: 1 で拒否）。board は seq を同日内の並び順にしか使わず値域を検証していない。並び順が不定になるだけで、エントリを落とすより観測の損失が小さい",
  "journal-index/invalid/touched-to-freetext.jsonl:1":
    "touched_issues.to の正規語彙（enum）違反。board は from/to を表示文字列として連結するだけで語彙に依存しない。ステータス別の機械集計を board が持つようになったら再検討する",
};

/**
 * **スキーマの解釈系による判定差**の棚卸し。上流の判定正本は ruby のバリデータ
 * （`scripts/validate-artifact.rb`）で、board のテストは同じスキーマを ajv で解釈する。
 * 同じスキーマでも解釈系が違えば判定が割れることがあり、その差を「board の緩さ」と
 * 取り違えないためにここへ分けて記録する。
 */
const KNOWN_ORACLE_GAP: Record<string, string> = {
  "journal-index/invalid/seq-infinity.jsonl:1":
    "seq が 1e999（JSON.parse で Infinity）。上流の ruby バリデータは type: integer 違反として exit 1 にするが、ajv の integer 判定は Infinity を通す。board も受理するため、この行では board と上流の判定が食い違う",
};

/**
 * 誤例フィクスチャの中にある**正常な行**の棚卸し。
 * 上流の誤例はファイル単位で「壊れている」だけで、全行が違反とは限らない
 * （例: 追記が交錯した状態の再現は、正常な行のあとに壊れた行が続く）。
 */
const INTENTIONALLY_VALID_LINES: Record<string, string> = {
  "journal-index/invalid/not-json.jsonl:1":
    "追記の交錯・破損の再現。1 行目は正常なレコードで、2 行目が JSON ではない",
};

describe("上流フォーマット契約（JSONL）", () => {
  describe("受理方向: 契約の正規出力を board が読み落とさない", () => {
    for (const location of [
      ...locationsOf("journal-index", "valid"),
      ...locationsOf("runs", "valid"),
    ]) {
      it(`${location} は全行を受理する`, async () => {
        const file = fileOf(location);
        const lines = jsonlLines(file);

        // 上流の正例フィクスチャがスキーマと食い違っていないことの相互検算
        // （vendoring したスキーマとフィクスチャが別々に古びていないか）。
        for (const { line, raw } of lines) {
          expect(
            schemaAccepts(typeOf(location), raw),
            `${location}:${line} は上流の正例なのにスキーマが拒否した`,
          ).toBe(true);
        }

        const rejected = await boardRejectedLines(typeOf(location), file);
        expect([...rejected]).toEqual([]);
      });
    }

    it("スキーマが受理する行はすべて board も受理する（誤例ファイル中の正常行を含む）", async () => {
      const violations: string[] = [];
      for (const location of ALL_JSONL_LOCATIONS) {
        const type = typeOf(location);
        const rejected = await boardRejectedLines(type, fileOf(location));
        for (const { line, raw } of jsonlLines(fileOf(location))) {
          if (schemaAccepts(type, raw) && rejected.has(line)) {
            violations.push(`${location}:${line}`);
          }
        }
      }

      // ここが落ちたら board 側の欠陥（契約の正規出力を読めていない）。
      expect(violations).toEqual([]);
    });
  });

  describe("拒否方向: 誤例でクラッシュせず、検出できるものは検出する", () => {
    for (const location of [
      ...locationsOf("journal-index", "invalid"),
      ...locationsOf("runs", "invalid"),
    ]) {
      it(`${location} は例外を投げず ParseError として可視化する`, async () => {
        const type = typeOf(location);
        const file = fileOf(location);
        const result =
          type === "journal-index"
            ? await parseJournal(file)
            : await parseRuns(file);

        // 壊れた行は握りつぶさず errors に積む。期待件数は
        // 「スキーマが拒否する行」から「board が意図的に受理する行（KNOWN_LAX）」を引いた数。
        const expectedRejected = jsonlLines(file).filter(
          ({ line, raw }) =>
            !schemaAccepts(type, raw) &&
            KNOWN_LAX[`${location}:${line}`] === undefined,
        ).length;

        expect(result.errors.length).toBe(expectedRejected);
        for (const error of result.errors) {
          expect(error.file).toBe(file);
          expect(error.message).not.toBe("");
        }
      });
    }

    it("スキーマが拒否するのに board が受理する行は KNOWN_LAX と完全に一致する", async () => {
      const observed: string[] = [];
      for (const location of ALL_JSONL_LOCATIONS) {
        const type = typeOf(location);
        const rejected = await boardRejectedLines(type, fileOf(location));
        for (const { line, raw } of jsonlLines(fileOf(location))) {
          if (!schemaAccepts(type, raw) && !rejected.has(line)) {
            observed.push(`${location}:${line}`);
          }
        }
      }

      // 増えていれば「緩さが無意識に増えた」、減っていれば「古い記載が残っている」。
      expect(observed.sort()).toEqual(Object.keys(KNOWN_LAX).sort());
    });

    // KNOWN_LAX と同じく双方向にする。片側検査（記載を舐めるだけ）だと、
    // マップを空にしても通る＝新しい判定差が無言で漏れる。
    it("誤例フィクスチャ中で ajv が受理する行は KNOWN_ORACLE_GAP と INTENTIONALLY_VALID_LINES に尽きる", () => {
      const observed: string[] = [];
      for (const location of [
        ...locationsOf("journal-index", "invalid"),
        ...locationsOf("runs", "invalid"),
      ]) {
        for (const { line, raw } of jsonlLines(fileOf(location))) {
          if (schemaAccepts(typeOf(location), raw)) {
            observed.push(`${location}:${line}`);
          }
        }
      }

      expect(observed.sort()).toEqual(
        [
          ...Object.keys(KNOWN_ORACLE_GAP),
          ...Object.keys(INTENTIONALLY_VALID_LINES),
        ].sort(),
      );
    });

    it("KNOWN_ORACLE_GAP は ajv が受理し board も受理する行として実在する", async () => {
      for (const location of Object.keys(KNOWN_ORACLE_GAP)) {
        const separator = location.lastIndexOf(":");
        const relativePath = location.slice(0, separator);
        const lineNumber = Number(location.slice(separator + 1));
        const type = typeOf(location);
        const target = jsonlLines(fileOf(relativePath)).find(
          (entry) => entry.line === lineNumber,
        );

        expect(target, `${location} が実在しない`).toBeDefined();
        // 上流は違反と判定する行を ajv が通している状態のピン。
        // ajv 側が拒否するようになったらこのテストが落ち、KNOWN_LAX へ移すか
        // board 側を追随させるかの判断へ戻ってくる。
        expect(schemaAccepts(type, target?.raw ?? "")).toBe(true);
        const rejected = await boardRejectedLines(type, fileOf(relativePath));
        expect(rejected.has(lineNumber)).toBe(false);
      }
    });
  });
});

// 台帳は上流にスキーマが無く（Markdown）、判定正本は上流の散文と ruby バリデータ。
// 値レベルの受理方向は ledger.test.ts が固定しているため、ここではファイル単位の
// 取りこぼし（エントリが黙って消えていないか）と、誤例でのクラッシュ耐性を固定する。
describe("上流フォーマット契約（台帳）", () => {
  function parseFixture(kind: Kind, name: string) {
    const file = path.join(fixtureDir("ledger", kind), name);
    return parseLedger(readFileSync(file, "utf-8"), name);
  }

  describe("受理方向: 正例のエントリを 1 件も落とさない", () => {
    const EXPECTED_IDS: Record<string, string[]> = {
      "archive.md": ["C-003", "C-004"],
      "audit-entry.md": ["C-011"],
      "handwritten-and-ingested.md": ["C-001", "C-002"],
      "multiline-and-refs.md": ["C-101", "C-102", "C-103", "C-104"],
    };

    it("収録した正例フィクスチャと期待値の集合が一致している", () => {
      expect(fixtureNames("ledger", "valid")).toEqual(
        Object.keys(EXPECTED_IDS).sort(),
      );
    });

    for (const [name, ids] of Object.entries(EXPECTED_IDS)) {
      it(`${name} は ${ids.join(" / ")} を errors なしで読む`, () => {
        const result = parseFixture("valid", name);

        expect(result.errors).toEqual([]);
        expect(result.challenges.map((challenge) => challenge.id)).toEqual(ids);
      });
    }
  });

  describe("拒否方向: 誤例でも例外を投げない", () => {
    for (const name of fixtureNames("ledger", "invalid")) {
      it(`${name} は例外を投げない`, () => {
        expect(() => parseFixture("invalid", name)).not.toThrow();
      });
    }
  });

  // 台帳の書き手側の規律違反（マーカー整合・見出しの消失/降格・備考行の巻き添え削除）は
  // 上流バリデータが書き込み前に止める検査であり、board 側に対応する検出手段は無い
  // （board は台帳へ書き込まない・NFR-01）。board にとって重要なのは
  // 「壊れた台帳を読んだときに何が見えて何が見えないか」なので、それを固定する。
  //
  // **既知の観測限界**: 見出しの消失・降格では課題が board から消えるが、`errors` は空＝
  // 運用者への信号がゼロになる。board 側で検出しない判断の根拠は
  // tests/fixtures/contracts/VENDORING.md「既知の観測限界」に記録した。
  // 以下のテストはその限界の**現状の固定**であって、望ましい姿の宣言ではない。
  describe("拒否方向: 書き手側の違反を board がどう観測するか", () => {
    it("double-marker.md: マーカー行は読まないため、両エントリが通常どおり見える", () => {
      const result = parseFixture("invalid", "double-marker.md");

      expect(result.errors).toEqual([]);
      expect(result.challenges.map((challenge) => challenge.id)).toEqual([
        "C-009",
        "C-010",
      ]);
    });

    it("heading-deleted.md: 見出しを失った課題は board から見えず、直前エントリに吸収される", () => {
      const result = parseFixture("invalid", "heading-deleted.md");

      // 吸収された側の課題は ID を持たないため、board では「存在しない」ように見える。
      // 検出は書き手側（フィールド行の重複として上流バリデータが止める）の責務。
      expect(result.challenges.map((challenge) => challenge.id)).toEqual([
        "C-013",
      ]);
      // 吸収された本文は、同一ラベルの先勝ち（読み取り規則）により
      // 前エントリの値を上書きしない。
      const c013 = result.challenges[0];
      expect(c013?.status).toBe("着手中");
      expect(c013?.taskPlan).toBe("実装する");
    });

    it("heading-demoted.md: 降格した見出しの課題は board から見えない（前文・本文に化ける）", () => {
      const result = parseFixture("invalid", "heading-demoted.md");

      // `## [C-010]` は前文、`## [C-012]` は C-011 の本文として扱われ、どちらも不可視。
      expect(result.challenges.map((challenge) => challenge.id)).toEqual([
        "C-011",
      ]);
      expect(result.challenges[0]?.status).toBe("分類済");
    });

    it("missing-note-field.md: 備考行の巻き添え削除は board の読み取り結果を変えない", () => {
      const result = parseFixture("invalid", "missing-note-field.md");

      // board は備考行を読まないため両エントリとも通常どおり見える
      // （＝board 側にこの事故の検出手段は無い。上流バリデータが必須フィールド行として止める）。
      expect(result.errors).toEqual([]);
      expect(result.challenges.map((challenge) => challenge.id)).toEqual([
        "C-007",
        "C-008",
      ]);
      expect(result.challenges[1]?.status).toBe("着手中");
    });
  });
});
