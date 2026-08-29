# 上流フォーマット契約の vendoring

このディレクトリは **claude-flywheel（フォーマットの正本）の `contracts/` からの逐語コピー**。
board は台帳・journal・runs.jsonl の**消費者**であり、フォーマットの解釈を board 側で持ち直さない（NFR-05）。
コピーは**パーサテストの入力としてのみ**使う（アプリ統合・実行時依存にはしない）。

| 項目 | 値 |
| --- | --- |
| 取得元 repo | `masanami/claude-flywheel` |
| 取得元パス | `contracts/` |
| 取得時コミット | `MANIFEST.json` の `upstream.commit`（**手書きしない**。`npm run contracts:update` が書き換える） |
| ディレクトリ構成 | 上流の `contracts/` をそのまま写す（直下の `*.tsv` ・ `schemas/` ・ `fixtures/<type>/{valid,invalid}/`） |

**このディレクトリのファイルを board 側で編集しない**。編集すると複製の自己検査（後述）が落ちる。

> このディレクトリは `biome.json` の `files.ignore` に入れてある。フォーマッタが
> `schemas/*.json` を整形して**逐語コピーでなくなる**（実際に `npm run lint:fix` が
> スキーマ 2 件を書き換え、自己検査が検出した）ため。

## なぜコピーするのか

- テストは **board 単体で完結**させる必要がある（隣接 repo の絶対パスに依存させない。
  正本はファイルという設計原則の下でも、テスト資産は外部の作業ディレクトリ配置に依存させない）。
- 上流の規定は「消費者が実装すべき読み取り結果」を表で定義しており（`docs/challenge-ledger-format.md`
  §複数行フィールドの記入形式）、その受理方向を board のテストで固定することが上流の移行フェーズ切り替え条件になっている。

## 収録範囲と判断

| 上流の type | 収録 | 判断根拠 |
| --- | --- | --- |
| `fixtures/ledger/` （正例 4・誤例 9） | **全件** | `parseLedger` が読む。誤例も board が実際に遭遇する入力——board は「壊れた状態を観測する面」であり、壊れた台帳を読むこと自体が正常な運用状態にある |
| `fixtures/journal-index/` （正例 2・誤例 6） | **全件** | `parseJournal` が読む |
| `fixtures/runs/` （正例 2・誤例 5） | **全件** | `parseRuns` が読む |
| `schemas/journal-index.schema.json`・`schemas/runs.schema.json` | **収録** | パーサテストで**判定オラクル**として実行する（下記「スキーマの使い方」） |
| `ledger-status-vocabulary.tsv` | **収録** | 台帳ステータス語彙の**正本**（閉じた集合）。board の `LEDGER_STATUSES` はこの複製で、ずれると未知ステータスが `ParseError` へ回り**そのエントリがカードごと消える**——読み取り結果に直接差が出る。`contracts.test.ts` が status 列と `LEDGER_STATUSES` の双方向一致を固定する |
| `ledger-read-scope.tsv` | **見送り** | run-cycle が「その周にどこまで台帳を開くか」を決める**書き手側**の規定。board は台帳全体を常に読むため、この表が変わっても読み取り結果に差が出ない |
| `cycle-commit-paths.txt` | **見送り** | サイクルコミットが触れてよいパス集合＝**書き手側**の規定。board は状態ファイルへ書き込まない（NFR-01）ため対応する挙動が無い |
| `fixtures/journal-md/` （正例 2・誤例 2） | **見送り** | `journal/YYYY-MM-DD-cycle.md` の定型 5 セクションを解釈するパーサが board に無い。マークダウンプレビューは任意の `.md` を不透明に描画するだけで、セクション欠落・順序崩れで挙動が変わらない。**固定できる board の挙動が存在しない**ため収録しても検査がタウトロジーになる。P4 journal タイムライン（`docs/requirements.md` OQ-03）でセクション構造を読むようになった時点で収録する |
| `README.md`（上流の散文） | **見送り** | 下記「散文正本をコピーしない理由」 |

見送り分は `MANIFEST.json` の `excluded` に理由つきで記録してある。**収録も除外もされていない上流ファイル**が
現れたら差分検査が `upstream-added` として報告する——収録するか除外するかは人が判断する（自動でコピーしない）。

### 収録可否の基準

**board の読み取り結果に差が出るか**。差が出るなら収録して固定する。出ないなら除外理由を `MANIFEST.json` に書く。

### 散文正本をコピーしない理由

契約の散文（上流 `contracts/README.md`・`docs/challenge-ledger-format.md`）は**コピーせず、読むときに上流の最新を読む**。

- board のテストが固定できるのは機械可読な契約物（スキーマ・フィクスチャ）だけで、散文をコピーしても検査対象が増えない。
- 散文には**消費者に無関係な改訂が混ざる**（例: `8708a97` → `ceb4f46` の README 改訂は書き手側の移行スクリプトの話で、
  board の読み取り規則には無関係）。コピーするとこの種の改訂ごとに差分検査が鳴り、本当の契約変更の信号が埋もれる。
- 上流は「フォーマット変更は散文・README・フィクスチャが同時に更新される」規律を宣言している。
  消費者に効く変更はフィクスチャ／スキーマ側にも必ず現れるので、機械可読物の差分検査で検知できる。

**差分が報告されたら散文（上流の最新）を読み直す**こと。board が推測で実装を変えるのは NFR-05 違反。

## 追随の仕組み

### 1. 複製の自己検査（上流が無くても常に動く）

`MANIFEST.json` に全収録ファイルの sha256 を記録している。`npm test` が毎回検証するので、
**board 側でコピーを書き換えると必ず落ちる**（`vendored-modified` / `vendored-missing` / `vendored-untracked`）。

### 2. 上流との差分検査（上流が手元にあるときだけ）

上流の内容・ファイル集合が `MANIFEST` 記録時点から動いていないかを検査する。
上流 `contracts/` の探索順は **`--upstream <dir>` 引数 → `FLYWHEEL_CONTRACTS_DIR` 環境変数 → 自動探索**。
自動探索は board リポジトリの位置からの相対のみで解決し（絶対パスを直書きしない）、次の順で候補を見る:

1. 通常のチェックアウトの隣接 repo（`<repos>/claude-flywheel/contracts`）
2. **git worktree の隣接 repo** — 標準の実装フローは `<repo>-worktrees/issue-N/` で回るため、
   単純な「2 つ上の隣接 repo」だと上流が実在しても見つからない。メイン作業ツリーの位置を
   `git rev-parse --git-common-dir` から引いて解決する
3. 祖先ディレクトリをさかのぼった隣接 repo（git が使えない配置の保険）

```bash
npm run contracts:verify                                   # 隣接 repo を自動探索
FLYWHEEL_CONTRACTS_DIR=/path/to/claude-flywheel npm run contracts:verify
```

終了コードは上流バリデータ（`scripts/validate-artifact.rb`）と同じ 3 値:

| exit | 意味 |
| --- | --- |
| `0` | 差分なし |
| `1` | 差分あり（`upstream-changed` / `upstream-removed` / `upstream-added` / 複製の自己検査違反） |
| `2` | **検査不能**（上流が手元に無い・`MANIFEST.json` が壊れている等） |

**上流が手元に無い環境で `0`（一致）を返さない**のが要点。`npm test` でも同じ扱いで、
上流との差分検査は「合格」ではなく **skip** として現れる——検査していないことが結果に残る。
ただし vitest の既定レポータは skip のテスト名も理由も出さず「1 skipped」の数だけを表示するため、
**理由は必ず標準エラーへ出す**（`[contracts] 上流との差分検査を実行していない（検査不能・「一致」ではない）: …`）。
上流が必ず手元にある前提で回す場面は `REQUIRE_UPSTREAM_CONTRACT_CHECK=1 npm test` で skip を失敗に昇格できる。

複製の自己検査は上流の有無にかかわらず常に実行し、違反があれば上流が無くても失敗させる（違反 > 検査不能）。

### 3. 更新手順

1. 上流を最新にする（`git -C <claude-flywheel> pull`）。
2. `npm run contracts:update` — 収録済みファイルの内容を上流から取り直し、`MANIFEST.json` の
   sha256・`upstream.commit`・`retrievedAt` を書き換える。**未収録の新規ファイルは自動でコピーしない**
   （収録可否は上記「収録可否の基準」に照らした人の判断。増えたファイルは `upstream-added` として報告され、
   このコマンドは exit 1 で終わる）。
   **来歴を truthful に記録できないときは 1 ファイルも複製しない**（exit 2）: 上流の `contracts` に
   未コミットの変更・未追跡ファイルがある場合と、上流の HEAD を取得できない（git 管理外・git 実行不可）場合。
   未コミットの内容を複製しながらクリーンな SHA を記録すると、後日その SHA と突き合わせたときに
   `upstream-changed`（上流が改訂された）と誤報告され、原因を取り違える。
3. `npm test` を通す。**ここで落ちたテストが「契約のどこが変わり、board の読み取りがどうズレたか」**。
   上流の散文（`docs/challenge-ledger-format.md` ・ `contracts/README.md`）を読み直して board 側を追随させる。
   フィクスチャの期待値を書き換えて通す**のではない**——board の読み取りが契約とズレているなら board 側の欠陥。
4. `MANIFEST.json` の差分（`upstream.commit` の変化）を PR に含める。

## テストでの固定

| テスト | 固定する内容 |
| --- | --- |
| `scripts/verify-contract-fixtures.test.ts` | vendoring の同期規律そのもの（複製の自己検査・上流差分検査・検査不能の扱い） |
| `src/server/parsers/contracts.test.ts` | 全収録フィクスチャの**受理方向**（`valid/` を期待どおり読めること）と**拒否方向**（`invalid/` でクラッシュせず、検出できるものは検出すること）。スキーマと board パーサの判定差の棚卸し、**ステータス語彙の双方向一致**（`ledger-status-vocabulary.tsv` ↔ `LEDGER_STATUSES` ↔ スキーマ enum）もここ |
| `src/server/parsers/ledger.test.ts` | 台帳の複数行フィールド・参照フィールドの値レベルの受理方向（#151 / #155） |
| `src/server/parsers/calendar-date.test.ts` | 暦日の実在判定（`format: date` / `date-time` の意味検証に相当する部分） |

### 既知の観測限界: board から無言で消える台帳エントリ

**書き手側の見出し破損は board に検出手段が無く、運用者への信号もゼロ**（`errors` は空のまま）。
`heading-deleted.md` では見出しを失った課題が直前エントリに吸収されて不可視、`heading-demoted.md` では
`### [` → `## [` に降格した 2 件が前文・本文に化けて不可視になる（`contracts.test.ts` で固定済み）。

board 側で検出しない判断の根拠:

- 検出は**書き手側の責務**。上流バリデータがコミット前に fail-closed で止める（board は台帳へ書き込まない・NFR-01）
- board で検出するには「エントリ見出しらしき `##` 行」等の判定規則を board が持つことになり、
  **同じものを 2 つの規則で読む**（NFR-05 が禁じる形）。誤検出も台帳の自由記述に対して起きうる

コミット済みの台帳にこの破損があるということは書き手側ゲートが迂回されたということで、
board 側に 2 つ目の検出器を足しても原因は塞がらない。ここでは**限界として記録するに留める**。

### スキーマの使い方

`schemas/*.schema.json` は**テストの判定オラクル**として ajv で実行する（`ajv` / `ajv-formats` は devDependency。
アプリのランタイムには入れない）。用途は「board のパーサ実装と契約の判定差を機械的に洗い出す」こと:

- **受理方向は例外なし**: スキーマが受理する行を board が拒否したら board の欠陥（正規出力を読めていない）。
- **拒否方向は差を許すが、黙って許さない**: board は壊れた状態を観測する読み取り専用の面なので、
  書き手向けの制約（対応付けキーの使用禁止文字など）まで拒否する必要はない。ただし
  「スキーマは拒否するが board は受理する」行は `contracts.test.ts` の `KNOWN_LAX` に**理由つきで列挙**し、
  列挙が実態と合わなくなったらテストが落ちるようにしてある（緩さが無意識に増えない）。

スキーマをコピーせず「フィクスチャの `valid/` / `invalid/` ディレクトリ分けだけを判定に使う」案もあったが、
`invalid/` のファイルには**正常な行と壊れた行が混在する**もの（`journal-index/invalid/not-json.jsonl`）があり、
ディレクトリ分けはファイル単位の粒度しか与えない。行単位の判定オラクルにはスキーマが要る。
