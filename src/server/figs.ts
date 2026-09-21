import * as fs from "node:fs";
import * as path from "node:path";
import { CHALLENGE_ID_PATTERN } from "./parsers/ledger.ts";

/**
 * 課題の一枚絵（fig）の読み取り（Issue #180 / FR-14）。
 *
 * **正本の置き場所**: エージェントのワークスペース直下 `figs/<課題ID>.mmd`
 * （台帳 `challenge-ledger.md` と同じ階層）。中身は mermaid のソース
 * （コードフェンスで囲まない・1 ファイル 1 図）。詳細と決定理由は
 * `docs/features/challenge-fig.md`。
 *
 * **board は読むだけ**（NFR-01）。この経路に書き込みは無い。ファイルが無いのは
 * **正常系**であり、呼び出し側は `{ ok: false }` を「図が無い」として扱う
 * （エラー表示もプレースホルダも出さない）。
 *
 * 台帳フォーマット（claude-flywheel `challenge-ledger-format.md`）には
 * **一切手を入れていない**。fig は台帳のフィールドではなく、同じワークスペースに
 * 置かれる**任意の追加ファイル**であり、board が読めなくても台帳の解釈は変わらない
 * （NFR-05 の「独自解釈を持ち込まない」に抵触しない）。
 */

/** ワークスペース直下の fig ディレクトリ名。 */
export const FIG_DIR_NAME = "figs";

/** fig ファイルの拡張子（mermaid ソース）。 */
export const FIG_EXTENSION = ".mmd";

/**
 * 読み取りを許可する fig の上限サイズ。
 *
 * fig は人が手で書く 1 枚の mermaid ソースであり、実運用では数 KB に収まる。
 * 一方このソースはカード詳細モーダルの描画時に mermaid へ同期的に渡されるため、
 * 巨大なファイルはサーバのメモリだけでなくブラウザ側の描画も巻き込んで固まらせる。
 * 手書き図には過剰なほど余裕を持たせつつ上限は設ける、という基準でこの値とする
 * （`GET /api/md/file` のテキスト上限とは目的が異なるため、値を共有せず独立に定める）。
 */
export const FIG_MAX_BYTES = 256 * 1024;

export type ChallengeFigResult = { ok: true; source: string } | { ok: false };

/**
 * 課題 ID に対応する fig のパス（ワークスペース相対の組み立て結果）を返す。
 *
 * 呼び出し側でのパス組み立てを避けるためのヘルパで、**ID の検証は行わない**
 * （検証は `readChallengeFig` が行う）。
 */
export function figPathFor(workspacePath: string, challengeId: string): string {
  return path.join(
    workspacePath,
    FIG_DIR_NAME,
    `${challengeId}${FIG_EXTENSION}`,
  );
}

/**
 * `<workspace>/figs/<課題ID>.mmd` を読む。次のすべてを満たす場合のみ
 * `{ ok: true, source }` を返し、それ以外は理由を問わず一律 `{ ok: false }` を返す
 * （呼び出し側が「不在」と「拒否」を区別せず同じ 404 に潰せる戻り値設計。
 * `validateMdPath` と同じ方針）。
 *
 * 1. 課題 ID が台帳フォーマットの ID 形式（`CHALLENGE_ID_PATTERN`）に一致する。
 *    パスセパレータ・`..`・ドット始まりはこの一致で構造的に排除される
 *    （＝要求文字列がそのままファイル名になる経路にならない）
 * 2. ワークスペースルートが実在し realpath で解決できる
 * 3. fig ファイルが実在し realpath で解決できる（不在＝図が無い＝正常系）
 * 4. 解決後のパスがワークスペースルート配下にある（symlink でルート外の
 *    ファイルを読ませない）
 * 5. 実体が通常ファイルである
 * 6. サイズが `FIG_MAX_BYTES` 以下である（本文読み込みより**先に** stat で判定する）
 */
export function readChallengeFig(
  workspacePath: string,
  challengeId: string,
): ChallengeFigResult {
  if (typeof challengeId !== "string") {
    return { ok: false };
  }
  if (!CHALLENGE_ID_PATTERN.test(challengeId)) {
    return { ok: false };
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(workspacePath);
  } catch {
    return { ok: false };
  }

  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(figPathFor(resolvedRoot, challengeId));
  } catch {
    return { ok: false };
  }

  if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
    return { ok: false };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return { ok: false };
  }
  if (!stat.isFile() || stat.size > FIG_MAX_BYTES) {
    return { ok: false };
  }

  try {
    return { ok: true, source: fs.readFileSync(resolvedPath, "utf8") };
  } catch {
    return { ok: false };
  }
}
