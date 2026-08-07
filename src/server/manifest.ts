import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FLEET_MANIFEST_ENV_KEY = "FLYWHEEL_FLEET_MANIFEST";

export type FleetEntry = { name: string; path: string };

/**
 * fleet entries を遅延参照するためのコールバック型（Issue #62）。
 * pty/bridge.ts（先行実装）・api.ts・index.ts で同一シグネチャを個別に手書きすると
 * ドリフトの元になるため、FleetEntry を所有するこのモジュールで一元定義し共有する。
 */
export type GetFleetEntries = () => readonly FleetEntry[];

/** fleet entries 未供給時の既定値（空の fleet 扱い）。呼び出し元が省略した場合に使う。 */
export const NO_FLEET_ENTRIES: GetFleetEntries = () => [];

/**
 * fleet entry のフィールド自体の妥当性を検証する。問題が無ければ `null`、あれば
 * 違反理由のメッセージを返す（例外を投げない）。`loadFleetManifest`（既存ファイルの
 * パース時。行番号を付与して throw）と `appendFleetEntry`（新規追記時。そのまま throw）の
 * 両方から呼ばれる共有ロジック。
 *
 * 検証項目:
 * - name / path が非空であること
 * - name / path にタブ・改行・復帰（`\t` `\n` `\r`）を含まないこと（fleet.tsv は
 *   `<name>\t<path>` の1行1エントリ・タブ区切り形式のため、これらの文字が混入すると
 *   書き込んだ行自体が壊れ、`loadFleetManifest` が拒否する不正な行を生成しうる。
 *   また改行混入は1回の呼び出しで複数行を注入でき、本関数のバリデーションを
 *   経由しない未検証エントリの追加を許してしまう）
 * - name が `#` で始まらないこと（`loadFleetManifest` はコメント行として読み飛ばすため、
 *   `#` 始まりの name を許すと append 自体は成功するのにエントリが有効にならない
 *   サイレント no-op になる）
 * - name の末尾が `-shell` でないこと（手動シェルセッション用の予約接尾辞。#57）
 *
 * export する理由（Issue #122）: `POST /api/fleet/agents` は mkdir -p / git init
 * という fs 副作用を伴うため、この検証は副作用より前に行いたい。この関数を
 * export して再利用することで、api.ts 側に同じ規則を再実装せずに済ませる
 * （DRY。`appendFleetEntry` 自身も従来どおりこの関数を書き込み直前に呼ぶため、
 * 事前チェックをすり抜けた場合でも最終防衛線として機能する）。
 */
export function validateFleetEntryFields(
  name: string,
  entryPath: string,
): string | null {
  if (name === "" || entryPath === "") {
    return `name / path のいずれかが空です: name="${name}" path="${entryPath}"`;
  }

  if (/[\t\r\n]/.test(name) || /[\t\r\n]/.test(entryPath)) {
    return `name / path にタブ・改行文字を含めることはできません（fleet.tsv のタブ区切り1行形式が壊れます）: name=${JSON.stringify(name)} path=${JSON.stringify(entryPath)}`;
  }

  if (name.startsWith("#")) {
    return `name を "#" で始めることはできません（fleet マニフェストのコメント行として無視され、追記してもエントリが有効になりません）: name="${name}"`;
  }

  // 末尾 "-shell" は手動シェルセッション（#57）用に予約する。tmux セッション名は
  // agent が `flywheel-<name>`、手動シェルが `flywheel-<name>-shell`（session.ts）
  // のため、agent 名 "foo-shell" を許すと agent "foo" の shell セッションと
  // tmux セッション名が衝突し、入力・prefill の分離が破綻する。ここで拒否して
  // 衝突を構造的に不可能にする。
  if (name.endsWith("-shell")) {
    return `agent 名の末尾 "-shell" は手動シェルセッション用に予約されています。別の名前にしてください: "${name}"`;
  }

  return null;
}

/**
 * パス重複比較用の正規化。絶対パスの場合のみ `path.resolve()` で字句正規化する
 * （相対パスをそのまま resolve すると board サーバの process.cwd() に依存してしまい、
 * 比較結果が起動ディレクトリ次第でぶれるため、絶対パスでない場合は生の文字列のまま
 * 比較する。`loadFleetManifest` が返す既存 entries は相対パスを許容し続けるため、
 * ここでの分岐が必要になる）。
 */
function normalizePathForComparison(p: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : p;
}

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

/** fleet.tsv を読み込む。存在しなければ分かりやすいメッセージで Error を throw する。 */
function readManifestFile(manifestPath: string): string {
  try {
    return fs.readFileSync(manifestPath, "utf-8");
  } catch {
    throw new Error(
      `fleet マニフェストが見つかりません: ${manifestPath}（FLYWHEEL_FLEET_MANIFEST 環境変数か引数でパスを指定してください）`,
    );
  }
}

/**
 * fleet.tsv の内容文字列（`<name>\t<path>` の2列。`#` コメント行・空行は無視）を
 * パースする。`loadFleetManifest` と `appendFleetEntry` の両方から、既に読み込み済みの
 * content に対して呼ばれる（ファイルの二重読み込みを避けるため、読み込みとパースを分離）。
 *
 * fleet.tsv は人間が手で書く少数行の起動設定ファイルであり、台帳のような
 * 「壊れていても他を活かす」設計は採用しない。不正な行が1つでもあれば
 * 即座に Error を throw する。
 */
function parseFleetManifestContent(content: string): FleetEntry[] {
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

    const reason = validateFleetEntryFields(name, entryPath);
    if (reason) {
      throw new Error(
        `fleet マニフェストの ${lineNo} 行目が不正です（${reason}）: "${line}"`,
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

/**
 * fleet.tsv（`<name>\t<path>` の2列。`#` コメント行・空行は無視）を読み込む。
 *
 * fleet.tsv は人間が手で書く少数行の起動設定ファイルであり、台帳のような
 * 「壊れていても他を活かす」設計は採用しない。不正な行が1つでもあれば
 * 即座に Error を throw する。
 */
export function loadFleetManifest(overridePath?: string): FleetEntry[] {
  const manifestPath = resolveFleetManifestPath(overridePath);
  const content = readManifestFile(manifestPath);
  return parseFleetManifestContent(content);
}

/**
 * fleet.tsv に新しい entry を1行 append する。
 *
 * バリデーションは `loadFleetManifest` と同一の規則（2列・name/path 非空・`-shell`
 * 接尾辞禁止・既存 fleet との名前重複）に加え、以下を検証する:
 * - name / path にタブ・改行を含まないこと（fleet.tsv のタブ区切り1行形式の破壊防止）
 * - name が `#` で始まらないこと（コメント行として無視されるサイレント no-op の防止）
 * - path が絶対パスであること（append 専用の追加規則。相対パス・`~` 始まりの表記は
 *   board サーバの process.cwd() 基準で誤って解決されるのを防ぐため）
 * - path の重複チェック（末尾スラッシュ等の表記揺れは正規化した上で比較）
 *
 * バリデーションをすべて通過するまでファイルへの書き込みには到達しないため、
 * 失敗時に fleet.tsv が変更されることはない。
 *
 * @param overridePath テスト用のパス差し替えシーム（`loadFleetManifest` と同じ用途）。
 *   本番の呼び出し経路では省略し、常に既定の fleet.tsv（またはFLYWHEEL_FLEET_MANIFEST
 *   の指す場所）に書き込むこと。ここに外部入力由来のパスを渡すと「board が書くのは
 *   自分自身の設定（fleet.tsv）のみ」という書き込み境界（NFR-01）が崩れるため、
 *   本番配線では絶対に使わない。
 * @returns 追記後の fleet entries 全件（`loadFleetManifest` を呼び直さなくても
 *   最新状態を得られるようにするため）。
 */
export function appendFleetEntry(
  entry: FleetEntry,
  overridePath?: string,
): FleetEntry[] {
  const manifestPath = resolveFleetManifestPath(overridePath);

  // 既存マニフェストの読み込み・パース時点のバリデーション（loadFleetManifest の
  // 既存規則）を再利用する。ファイルが存在しない/不正な場合はここで throw され、
  // 書き込みには到達しない。
  const content = readManifestFile(manifestPath);
  const existingEntries = parseFleetManifestContent(content);

  const name = entry.name.trim();
  const trimmedPath = entry.path.trim();

  // 空・タブ/改行混入・"#" 始まり・"-shell" 接尾辞は正規化前の生の値で検証する
  // （path.resolve("") は cwd を返してしまい空チェックをすり抜けるため、
  // 検証を先に済ませてから正規化する順序が重要）。
  const reason = validateFleetEntryFields(name, trimmedPath);
  if (reason) {
    throw new Error(reason);
  }

  // path は絶対パスであることを要求する（append 専用の追加規則。loadFleetManifest と
  // 共有する validateFleetEntryFields には含めない）。理由: path.resolve() は相対パス・
  // "~" 始まりの表記を board サーバの process.cwd() 基準で絶対化してしまい、
  // 意図しないパスがエラーも警告も無く fleet.tsv に永続化されてしまう。
  // loadFleetManifest 側は既存の手書き fleet.tsv で相対パスが使われている可能性を
  // 否定できないため、ここに合流させると本チケットの範囲外の後方互換性を壊しうる。
  if (!path.isAbsolute(trimmedPath)) {
    throw new Error(
      `path は絶対パスである必要があります（相対パス・"~" 始まりの表記はサーバのカレントディレクトリ次第で解決先が変わり不安定なため許可しません）: "${trimmedPath}"`,
    );
  }

  // 表記揺れ（末尾スラッシュ・"." を含む表記等）によるパス重複の見落としを防ぐため、
  // 比較・書き込みの両方で正規化した値を使う。上の isAbsolute チェックにより
  // trimmedPath は既に絶対パスであることが保証されているため、path.resolve() は
  // process.cwd() を参照しない純粋な字句正規化として働く。
  const entryPath = path.resolve(trimmedPath);

  if (existingEntries.some((e) => e.name === name)) {
    throw new Error(
      `fleet マニフェストへの追記に失敗しました（name "${name}" が既存 fleet と重複しています）`,
    );
  }

  if (
    existingEntries.some(
      (e) => normalizePathForComparison(e.path) === entryPath,
    )
  ) {
    throw new Error(
      `fleet マニフェストへの追記に失敗しました（path "${entryPath}" が既存 fleet と重複しています）`,
    );
  }

  const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
  const lineToAppend = `${needsLeadingNewline ? "\n" : ""}${name}\t${entryPath}\n`;

  fs.appendFileSync(manifestPath, lineToAppend, "utf-8");

  return [...existingEntries, { name, path: entryPath }];
}

/**
 * `content` 内で `line` が「行頭」（文字列先頭、または直前の文字が `\n`）から
 * 始まる最初の出現位置を返す。`String.indexOf` と異なり、コメントアウトされた
 * 行の内部など行頭以外での偶然の部分一致を除外する（`removeFleetEntry` 専用）。
 * 見つからなければ `-1`。
 */
function findLineStart(content: string, line: string): number {
  let searchFrom = 0;
  while (searchFrom <= content.length) {
    const idx = content.indexOf(line, searchFrom);
    if (idx === -1) {
      return -1;
    }
    if (idx === 0 || content[idx - 1] === "\n") {
      return idx;
    }
    searchFrom = idx + 1;
  }
  return -1;
}

/**
 * fleet.tsv から `<name>\t<entryPath>\n` の1行（appendFleetEntry が書き込む形式と
 * 完全一致する行）を取り除く（Issue #122: `POST /api/fleet/agents` が
 * mkdir/git init/動的監視登録のいずれかに失敗した際、直前に自分が追記した行の
 * ロールバック専用）。
 *
 * 設計意図: fleet.tsv の書式（1行1エントリ・タブ区切り・末尾改行の補完規則）は
 * この manifest.ts の外に漏らさない。呼び出し元（api.ts）がバイトオフセットや
 * ファイル内容の差分を自前で計算すると、(a) manifest.ts 側の書式変更に追従できず
 * 壊れる、(b) 末尾改行が無い既存内容に対する行区切り用の補完 `\n`（このモジュール
 * だけが知っている実装詳細）を誤って巻き添えで消してしまう、という実際に起きた
 * 不具合があったため、除去処理そのものをこのモジュールへ集約する。
 *
 * name の一意性は `appendFleetEntry`／起動時の `loadFleetManifest` が保証する
 * 前提だが、`content.indexOf(line)` の素朴な部分文字列検索だけでは、同一の
 * `name\tpath` 文字列が「行頭以外」（例えば `#` コメントアウトされた行の内部）に
 * 偶然出現した場合にそちらへ誤って一致し、無関係な行を破壊しうる
 * （セルフレビュー指摘対応: 実際に「コメントアウトされた同名/同パスの行」＋
 * 「同じ内容を再度追加してロールバックする」という組み合わせで、無関係な既存
 * 行がコメント化されてしまう不具合を検出したため、行頭アンカー付きの検索に
 * 修正した）。行頭（文字列先頭、または直前の文字が `\n`）から始まる一致のみを
 * 対象とすることで、コメント行や他エントリの value 部分への誤マッチを排除する。
 *
 * @returns 該当行を実際に取り除けた場合は `true`。ファイルが読めない、または
 *   該当行が見つからない（既に別の要因で内容が変わっている等）場合は `false`
 *   を返す（例外は投げない。ロールバックの失敗は致命的ではなく、呼び出し元が
 *   ログに残す程度の扱いで十分なため）。
 * @param overridePath テスト用のパス差し替えシーム（`appendFleetEntry` と同じ用途）。
 *   本番配線では絶対に使わない。
 */
export function removeFleetEntry(
  name: string,
  entryPath: string,
  overridePath?: string,
): boolean {
  const manifestPath = resolveFleetManifestPath(overridePath);

  let content: string;
  try {
    content = fs.readFileSync(manifestPath, "utf-8");
  } catch {
    return false;
  }

  const line = `${name}\t${entryPath}\n`;
  const idx = findLineStart(content, line);
  if (idx === -1) {
    return false;
  }

  const updated = content.slice(0, idx) + content.slice(idx + line.length);
  try {
    fs.writeFileSync(manifestPath, updated, "utf-8");
  } catch (error) {
    // JSDoc の契約どおり例外は投げない（権限不足・ディスク不足等での
    // writeFileSync 失敗を握り潰し false を返す）。この関数は api.ts の
    // ロールバック経路から呼ばれるため、ここで例外が漏れると本来クライアントへ
    // 返すはずの元のエラー応答が失われてしまう。
    console.error(
      "[manifest] fleet.tsv の更新に失敗しました（ロールバック用の書き込み）:",
      error,
    );
    return false;
  }
  return true;
}
