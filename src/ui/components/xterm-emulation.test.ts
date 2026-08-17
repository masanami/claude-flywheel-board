import { readFileSync } from "node:fs";
import { join } from "node:path";
import xtermHeadlessPkg from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { TERMINAL_OPTIONS } from "./xterm-adapter.ts";

// Issue #148（スクロールすると 1 列目に別の行の文字が残る）の回帰テスト。
//
// 実描画（グリフのペイント）は jsdom でも Vitest でも検証できないため、検証は
// 「xterm.js のバッファ（＝端末エミュレーションの結果）が tmux の意図した画面と
// 一致すること」に落とす。#148 の症状は「1 列目のセルの内容が本来と違う」であり、
// バッファ段階で列がずれていれば必ずここで検出できる。逆にバッファが一致すれば
// 原因はエミュレーションより後段（ブラウザのペイント）に絞り込める。
//
// 本番と同じオプションで検証するため TERMINAL_OPTIONS を import して渡す
// （テスト側でオプションを書き写すと、本番設定を変えても追随しない）。
// @xterm/headless は描画を持たないため theme/fontFamily 等の描画系オプションは
// 無視されるが、エミュレーション系オプション（convertEol 等）はそのまま効く。
const { Terminal } = xtermHeadlessPkg;

type HeadlessTerminal = InstanceType<typeof Terminal>;

/** headless Terminal を本番オプションで生成する。 */
function createHeadlessTerminal(cols: number, rows: number): HeadlessTerminal {
  return new Terminal({
    ...TERMINAL_OPTIONS,
    cols,
    rows,
    allowProposedApi: true,
  } as ConstructorParameters<typeof Terminal>[0]);
}

/** 書き込みが解決するのを待ってから、表示中の各行を文字列として取り出す。 */
function writeAndReadRows(
  terminal: HeadlessTerminal,
  data: string,
  rowCount: number,
): Promise<string[]> {
  return new Promise((resolve) => {
    terminal.write(data, () => {
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < rowCount; y++) {
        lines.push(
          (
            buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? ""
          ).replace(/\s+$/, ""),
        );
      }
      resolve(lines);
    });
  });
}

describe("端末エミュレーション（Issue #148 回帰）", () => {
  // #148 の症状を最小構成で表現したテスト。
  //
  // `infocmp xterm-256color` の `cud1`（カーソル 1 行下）と `ind`（インデックス）は
  // いずれも `^J`＝素の LF であり、tmux は「列を保ったまま 1 行下げる」ために
  // 素の LF を送出してよい。かつ tmux は自身の pty から `OPOST|ONLCR` を落とす
  // ため、pty 層が CR を足すこともない。したがって素の LF は純粋な IND（列を
  // 保ったまま 1 行下げる）でなければならない。
  //
  // convertEol: true だと xterm.js は LF のたびにカーソル列を 0 に戻すため、
  // 続く文字が「本来の列」ではなく 1 列目に着弾する ＝ 1 列目が空白であるべき
  // 行に別の行由来の文字が現れる、という #148 の症状そのものになる。
  it("素の LF はカーソル列を保ったまま 1 行下げる（1 列目に文字を書き込まない）", async () => {
    const terminal = createHeadlessTerminal(20, 4);

    // 1 行目の 5 列目に "AB" を書き、素の LF で 2 行目へ下りて "CD" を続ける。
    // 端末が LF を IND として扱えば "CD" は 2 行目の 7 列目に着弾し、
    // 2 行目の 1〜6 列目は空白のまま保たれる。
    const rows = await writeAndReadRows(
      terminal,
      "\x1b[1;5HAB\nCD",
      terminal.rows,
    );

    expect(rows[0]).toBe("    AB");
    expect(rows[1]).toBe("      CD");
    // 症状の直接表現: 2 行目の 1 列目は空白であり、1 行目由来の文字が残らない。
    expect(rows[1]?.[0]).toBe(" ");
    expect(rows[1]?.startsWith("CD")).toBe(false);
  });

  // 実機の tmux（3.5a・`mouse on`・`-L` 専用ソケット・TERM=xterm-256color）へ
  // node-pty で attach し、ホイール上スクロール（SGR マウス `ESC[<64;x;yM`）を
  // 6 回送って copy-mode をスクロールさせたときの pty 出力をそのまま記録した
  // フィクスチャ。内容は #148 の再現条件（日本語＝全角混じり・端末幅での自動
  // 折り返し・2 スペースインデントの継続行）を満たす。
  //
  // 期待値 expectedPaneRows は同時に採取した `tmux capture-pane`（＝tmux が
  // 意図している画面内容）であり、tmux 側を正解とした突き合わせになる。
  it("実機 tmux の copy-mode スクロール出力を再生してもバッファが tmux の画面と一致する", async () => {
    // Vite の `new URL(..., import.meta.url)` はアセットURL変換の対象になり
    // file スキーム以外へ書き換わるため、favicon.test.ts と同じく
    // process.cwd()（プロジェクトルート）基準のパス結合で参照する。
    const fixture = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "tests/fixtures/terminal/tmux-copy-mode-scroll.json",
        ),
        "utf8",
      ),
    ) as {
      cols: number;
      rows: number;
      paneRows: number;
      chunks: string[];
      expectedPaneRows: string[];
    };

    const terminal = createHeadlessTerminal(fixture.cols, fixture.rows);
    const rows = await writeAndReadRows(
      terminal,
      fixture.chunks.join(""),
      fixture.paneRows,
    );

    // 先頭行だけは完全一致で比較しない。tmux は copy-mode 中、ペイン最上行の
    // 右端に位置インジケータ（例: `08:08:22 [25/264]`）を重ね描きするが、
    // `capture-pane` はペインの内容を返すだけでこの重ね描きを含まないため。
    // 行頭側は本来の内容がそのまま出るはずなので前方一致で検証する。
    expect(rows[0]?.startsWith(fixture.expectedPaneRows[0] ?? "")).toBe(true);
    expect(rows.slice(1)).toEqual(fixture.expectedPaneRows.slice(1));

    // フィクスチャが #148 の再現条件（1 列目が空白のインデント行と、1 列目に
    // 文字がある行の両方）を実際に含んでいることを確かめる。含んでいなければ
    // 上の突き合わせは症状を素通ししてしまうため、テスト自体の妥当性検証。
    expect(rows.some((row) => row.startsWith("  ") && row.trim() !== "")).toBe(
      true,
    );
    expect(rows.some((row) => /^\S/.test(row))).toBe(true);
  });
});
