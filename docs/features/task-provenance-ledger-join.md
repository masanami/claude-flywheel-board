# タスクの取得元表示（provenance）と課題台帳 join 表示

## 概要

board のタスク表示（実行中 Run・アラート行・カード詳細）に、(1) そのタスク行が**どのファイルのどの記録から導出されたか**（取得元 = provenance。Issue #85）と、(2) **課題台帳エントリの内容情報**（タイトル・説明・完了条件等。Issue #94）を表示する。実行中 Run 行（RunningRunRow）は課題 ID をキーに台帳エントリを join して表示し、カード詳細（CardDetailModal）は台帳カードから渡される課題をそのまま表示する（#102 の設計変更。詳細は下記 FR-B2/FR-B3 参照）。「どの記録から来たか」と「なんのタスクか」の両方を board の画面だけで完結させる。

## 背景・目的

- **診断コストの削減（#85）**: 「⚠ 応答なし」等の異常表示が出たとき、原因となった記録（例: `.flywheel/runs.jsonl` の未終了 `delegate_start`）を特定するために、現状はデータファイルを手で開き session_id ごとに start/end を突き合わせる必要がある（実例: 2026-07-28〜29 の C-030、2026-07-22 の偽「70時間 応答なし」）。取得元を画面に出すことで、偽アラート（記録漏れ）と実際のハングを**画面だけで区別**でき、「どの記録を閉じれば表示が消えるか」が自明になる。
- **突き合わせコストの削減（#94）**: 実行中 Run の行は課題 ID とリポジトリ名程度しか情報がなく、「なんのタスクか」を知るには台帳を手で開く必要がある。board は台帳を既に読み込んでいるため、課題 ID で join すれば**追加の記録コストゼロ**で内容を表示できる。
- 台帳バリデーションエラーが「ファイル名:行番号つき」で即対処できているのと同じ思想を、タスク表示にも適用する。

## ユーザーストーリー

fleet の管理者として、board 上の実行中・応答なしタスクを見たとき、(1) その行の導出元レコードと (2) 課題の内容（タイトル・完了条件）を画面上で確認し、台帳や runs.jsonl を手で開かずに「本当に異常か・どの記録を直せばよいか・何の作業か」を即答したい。

## 機能要件

### 取得元（provenance）表示 — Issue #85

- [ ] FR-A1: run 由来のタスク行（`runningRuns`: kind `delegate` / `adhoc`。cycle は対象外 — スコープ外の節を参照）について、カード詳細（CardDetailModal）に取得元を表示する。表示内容は **導出元ファイル＋レコードキー情報**: ファイル（`.flywheel/runs.jsonl`）、イベント種別（`delegate_start` / `adhoc_start`）、`ts`、キー（delegate は `session_id`、adhoc は `id`）
- [ ] FR-A2: アラート行（`stale: true` の「⚠ 更新なし」表示。文言は Issue #154 で「応答なし」から変更）には、`AgentColumn` の RunningRunRow 上にも取得元を **1行インライン表示**する（例: `└ 取得元: .flywheel/runs.jsonl — delegate_start ts=2026-07-28T17:31:00+09:00 session_id=cc3535f2-…（対応する delegate_end なし）`）。stale でない実行中行にはインライン表示しない
- [ ] FR-A3: カード詳細に「元レコード」展開セクション（展開/折りたたみ可能な UI。テストから `data-testid="raw-record"` の安定フックで特定できること）を設け、導出元イベントの **生 JSON 1行**をそのまま表示する
- [ ] FR-A4: 未終了 start（対応する end イベントが無い）の場合、その旨（例: 「対応する delegate_end なし」）を取得元表示に明示する
- [ ] FR-A5: 位置情報は**行番号を含めない**（追記型 jsonl では行番号がすぐ古びるため、安定して照合できるレコードキーを正とする。ユーザー決定）

### 課題台帳 join 表示 — Issue #94

- [ ] FR-B1: run 由来のタスク行（RunningRunRow）に、課題 ID で join した**台帳エントリのタイトル**を表示する（`C-030 → repo` → `C-030 <課題タイトル> → repo`）
- [ ] FR-B2: カード詳細に、**タイトル・説明・完了条件・タスク案・優先度・ステータス**、および**関連リポジトリ・関連Issue・関連PR**（#155 で追加）を表示する。台帳セクションの表示順は **タスク案 → 完了条件 → 関連リポジトリ → 関連Issue → 関連PR → 説明**——規定 §FR-13 の承認対象が「タスク案・完了条件・関連リポジトリ」であり、説明（ingest 由来だと実データで数千文字のブロック引用になる）を先頭に置くと承認対象が初期表示の外へ押し出されるため（#151）。説明は文脈情報として最後に置き、CSS で高さを制限して内部スクロールさせる。カード詳細（CardDetailModal）は台帳カード（TaskCard）からのみ開かれ、表示対象の台帳エントリは `challenge` prop として既に手元にあるため、**join は行わず `challenge` prop を直接表示**する（設計変更: #102。当初は `agent` prop 経由で `findChallengeById` を呼ぶ設計だったが、本番の唯一の呼び出し元 TaskCard が `agent` を渡さず到達不能なデッドコードになると判明したため、2026-08-01 にユーザー承認のうえ直接表示方式へ変更）
- [ ] FR-B3: join（課題 ID をキーに `challenges` に加えて `archivedChallenges`（アーカイブ台帳）も探索する処理）は **RunningRunRow（FR-B1）側のみの責務**とする。CardDetailModal は FR-B2 のとおり `challenge` prop を直接表示するため join を行わない。RunningRunRow でどちらにも課題 ID が見つからない場合は「台帳に見つかりません」と表示する（join 失敗でタスク行の表示自体は壊さない）
- [ ] FR-B4: 台帳パーサ（`parseLedger`）を拡張し、`Challenge` に **説明・完了条件・タスク案** を追加で抽出する。抽出に使うフィールドラベルは `説明` / `タスク案` は完全一致、`完了条件` は**前方一致**（ラベルが `完了条件` で始まる行。実在する表記揺れ: テンプレート 0.11.0/0.12.0 と実運用台帳は `完了条件（任意）`、board のフィクスチャ `tests/fixtures/ledger/valid.md` は `完了条件（任意・分かれば）` — 括弧内の注記が揺れるため注記を無視して照合する）。フォーマットの正本は claude-flywheel 側テンプレート（`templates/challenge-ledger.md`）であり、board 独自の解釈を持ち込まない（NFR-05）。エントリにフィールドが無い場合は省略可（optional）として扱う
- [ ] FR-B5: 複数行フィールドの収集（#151）。フォーマットの正本は claude-flywheel `docs/challenge-ledger-format.md`（§複数行フィールドの記入形式 / §消費側（board 等）の読み取り規則）。フィールドの値は **フィールド行の値＋直下に連続する継続行**の結合とする
  - **継続行は 2 種類**: インデント行（スペース 1 個以上で始まる行＝ネスト箇条書き）と引用行（行頭 `>` ＝ ingest-challenges が外部 Issue 本文を転記するブロック引用）
  - **終端は** 空行 / いずれの継続行でもない行 / 次のエントリ見出し
  - **フェンス・複数行 HTML コメントの中身は台帳データではない**（同規則 5）。値を終端させず中身も含めずに読み飛ばし、ブロックが閉じたら同じフィールドの値へ戻る（GitHub の Issue テンプレートが含む複数行コメントで説明が黙って打ち切られないようにするため）
  - **継続行を収集するのは規定が複数行の値を定義しているフィールドだけ**（`説明` / `完了条件*` / `タスク案`）。ステータス・優先度・担当ポジションのような**語彙・列挙で検証される制御フィールドは対象外**——複数行化すると語彙照合を外して正常なエントリが `errors` に落ち、カード（承認待ちなら承認導線ごと）が列から消えるため。参照フィールドも規定が値の形を「カンマ区切り」としか定めていないため対象外
  - **承認チェックボックス**（`  - [ ] …` / `  - [x] …`）は値ではない（同規則 4）。ただしこれは `- 承認（人間がチェック）:` の**直下にネストされた専用構造**というスコープの規定であり（§承認プロトコル）、行の形だけで捨てない——完了条件・タスク案をタスクリスト記法で書いた場合は値として保持する
  - 結合時は規定のネスト幅（スペース 2 個）ぶんだけデデントし、さらに深い子項目の相対的な階層は保つ
- [ ] FR-B6: 参照フィールドの抽出とリンク化（#155）。`関連リポジトリ` / `関連Issue` / `関連PR` を**カンマ区切りの複数値**として抽出する。値の形は `関連リポジトリ` が `<owner>/<repo>`、`関連Issue` / `関連PR` が `<owner>/<repo>#<番号>`（`<repo>#<番号>` の短縮形も可）。**短縮形の owner 解決は消費側の責務**で、同一エントリの `関連リポジトリ` に同名 `<repo>` があればその owner を使い、無ければ owner 不明として**リンク化せず台帳の記載どおりテキスト表示**する（ワークスペースの `repos.tsv` を board が読める前提は置かない）。**リンク化も消費側の責務**のため、台帳の短い参照から board が GitHub の URL を組み立てる（`src/ui/lib/github-ref-url.ts`）。表示ラベルは台帳のフィールド名をそのまま使う（規定は `関連サービス` と `関連リポジトリ` を別概念として併存させており、board 側で言い換えない。NFR-05）。フィールドが無い / 空欄のエントリは他の任意フィールドと同じく `-` 表示

### スコープ外（今回は実装しない）

> 以下は実装対象外の除外理由メモであり、意図的にチェックボックス化しない。

- 完了済みタスクへの journal 委譲行（skill / result / session_id）join（#94 の任意項目 3）。理由: 委譲固有情報の充実は claude-flywheel 側の `delegate_start` フィールド追加（別途起票）に依存し、カード詳細の既存ログ表示（`GET /api/log` が journal 行をマージ済み）で当面代替できるため
- 台帳由来カード（TaskCard）への取得元表示。理由: 台帳カードは課題 ID・タイトルを常時表示しており導出元（`challenge-ledger.md` の当該エントリ）が自明のため
- cycle（run-cycle 本体）由来のステータスへの取得元表示（ユーザー決定 2026-08-01）。理由: cycle はタスク行として表示されず、エージェント列ヘッダのステータスとしてのみ現れるため UI 設計の追加が必要になる。未終了 `cycle_start` による偽「⚠応答なし」の診断が痛点化した場合の将来拡張とする

## 非機能要件

- **NFR-01 維持**: 本機能は表示のみ。状態ファイル（台帳・journal・memory・runs.jsonl）への書き込み経路を一切追加しない
- **NFR-05 維持**: 台帳・runs.jsonl のフォーマット解釈は claude-flywheel 側 docs を正本とし、パーサ拡張も既存 `parseLedger` / `parseRunsJsonl` への追加に限る（新規の独自解釈パーサを作らない）
- **XSS**: 台帳テキスト（説明・完了条件・タスク案）と生レコードは**プレーンテキストとして表示**する（Markdown レンダリングしない。#61 のプレビュー機能とは責務を分ける）。複数行の値も同様で、改行・ネストのインデントは CSS（`white-space: pre-wrap`）で見せる。参照フィールドのリンクは `owner` / `repo`（`[\w.-]+`）と番号（`\d+`）に一致した値からのみ URL を組み立て、台帳の生文字列は URL に入れない（`javascript:` 等のスキームを構成できない）
- **スナップショットサイズ**: provenance（生レコード含む）を載せるのは `runningRuns`（実行中のみ・通常数件）に限るため、WS スナップショット肥大の懸念は実質ない。台帳 join は既存データの参照で追加転送なし

## 技術的な制約・方針

- 使用技術: 既存スタックのまま（Hono / ws / Vitest / React）。新規依存なし
- 変更対象:
  - `src/server/parsers/runs.ts` — `MatchedRun` に provenance 情報を追加
  - `src/server/parsers/ledger.ts` — `Challenge` に説明・完了条件・タスク案を追加抽出（#151 で継続行の収集、#155 で参照フィールド `ChallengeRef[]` を追加）
  - `src/server/cache.ts` — 型の伝搬のみ（導出ロジック変更なし）
  - `src/ui/components/AgentColumn.tsx`（RunningRunRow）・`src/ui/components/CardDetailModal.tsx`・`src/ui/styles.css`
  - `src/ui/lib/challenge-lookup.ts` — **新規**。UI 側 join ヘルパー（「機能全体の設計 > IF / API」参照）
  - `src/ui/lib/github-ref-url.ts` — **新規**（#155）。参照フィールド → GitHub URL の組み立て
  - `tests/fixtures/contracts/` — **新規**（#151・#155 で `fixtures/ledger/` を導入、#158 で journal-index・runs・schemas へ拡張）。claude-flywheel `contracts/` からの逐語コピー（vendoring の範囲・除外理由・追随手順は同ディレクトリ `VENDORING.md`）
  - `src/ui/board-types.ts` — type re-export の追従
- 既存コードとの関係: join は **UI 側で実施**する（下記アーキテクチャ決定）。新規 API エンドポイントは追加しない

## 機能全体の設計

### アーキテクチャ決定

- **join の実施場所は UI 側**とする。`AgentBoard` には `challenges` / `archivedChallenges` / `runningRuns` が既に同居しており、課題 ID による突き合わせはスナップショット受信済みデータの参照で完結する。サーバ側で join 済みの複合オブジェクトを作らない理由: (1) 新 API・新導出ロジックが不要（KISS）、(2) キャッシュは「ファイルの読み取りキャッシュ」に徹する現行設計（NFR-04）を保つ、(3) 同一課題を台帳カードと run 行が二重参照してもデータは1箇所のまま
- **join が必要なのは RunningRunRow のみ**（設計変更: #102・2026-08-01 ユーザー承認）。CardDetailModal は台帳カード（TaskCard）からのみ開かれ、表示対象の `Challenge` は `challenge` prop として既に渡されているため join 不要。当初案（CardDetailModal も `agent` prop を受け取り `findChallengeById` で join する）は、本番の唯一の呼び出し元 TaskCard が `agent` を渡さないため到達不能なデッドコードになると Phase 5-3 の懐疑的検証（design-deviation-verifier）で判明し、上記のとおり修正した
- **provenance はパーサで付与**する。現行の `parseRuns` は妥当な行を `RunEvent`（file/raw を持たない）として返しているため、`RunEvent`（または `parseRuns` の返り値）を **file・生行文字列（raw）を保持する形に拡張**した上で、`matchRuns` が `MatchedRun` へ引き継ぐ（後段で復元しようとすると raw 行が失われるため、発生源で付与する）。`matchRuns` のシグネチャ変更に伴い、`runs.test.ts` / `cache.test.ts` の既存呼び出しの更新も本変更のスコープに含む
- **provenance は kind: `delegate` / `adhoc` の `MatchedRun` にのみ付与**し、kind: `cycle` では未設定（`undefined`）のままとする（FR-A1 のスコープ決定を型に反映。下記データモデル参照）

### データモデル

```ts
// src/server/parsers/runs.ts
export type RunProvenance = {
  /** 導出元ファイル（repo ルートからの相対パス。例: ".flywheel/runs.jsonl"） */
  file: string;
  /** 開始イベント種別（cycle はスコープ外のためリテラルユニオンで型レベルでも除外） */
  event: "delegate_start" | "adhoc_start";
  /** 開始イベントの ts（ISO 8601） */
  ts: string;
  /** レコードキー（delegate: session_id / adhoc: id） */
  key: string;
  /** 開始イベントの生 JSON 1行（FR-A3 の展開表示用） */
  raw: string;
  /** 対応する end イベントが存在するか（false なら FR-A4 の「対応する end なし」表示） */
  hasEnd: boolean;
};
// provenance は optional: kind "delegate" / "adhoc" にのみ付与し、
// kind "cycle" の MatchedRun では undefined のままとする（スコープ外決定の型反映）。
export type MatchedRun = { /* 既存フィールド */ provenance?: RunProvenance };

// src/server/parsers/ledger.ts（すべて optional。テンプレートに無い場合は省略）
export type Challenge = {
  /* 既存フィールド */
  description?: string;      // 説明（背景・困りごと・期待する状態）
  completionCriteria?: string; // 完了条件
  taskPlan?: string;         // タスク案
};
```

### IF / API

- 新規エンドポイントなし。既存 WS スナップショット（`snapshot` / `agent_update`）の `AgentBoard.runningRuns[].provenance` と `challenges[].description` 等が増えるのみ
- UI 側 join ヘルパー: `findChallengeById(agent: AgentBoard, id: string): Challenge | undefined`（`challenges` → `archivedChallenges` の順に探索）を `src/ui/lib/challenge-lookup.ts`（新規）に追加し、**RunningRunRow（FR-B1/FR-B3）のみが使用**する。CardDetailModal は FR-B2 の設計変更（#102）により `challenge` prop を直接表示するため、このヘルパーを呼び出さない

### 実装計画（チケット分解の見通し。最終分解は /create-ticket）

1. サーバ: `parseLedger` 拡張（説明・完了条件・タスク案の抽出＋テスト）
2. サーバ: `RunEvent` / `parseRuns` の file・raw 保持化と `matchRuns` / `deriveRuns` への provenance 付与（delegate/adhoc のみ。既存テストの呼び出し更新含む＋テスト）
3. UI: RunningRunRow の台帳タイトル表示＋stale 行のインライン取得元表示
4. UI: CardDetailModal の台帳セクション（challenge prop 直接表示。join は行わない）＋取得元・元レコード展開セクション

1↔2 は独立。3・4 は 1・2 の型に依存（統合ブランチ方式での並列実装を推奨）。

## 受入基準

> 表示文字列の検証粒度: 取得元表示のアサーションは構成要素（ファイル名・イベント種別・ts・キー・end 有無の注記）が含まれることの検証とし、表示文言全体の完全一致は要求しない（FR-A2 の表示例は書式イメージであり正本文字列ではない）。

- [ ] AC-1: 未終了 `delegate_start` を含む runs.jsonl フィクスチャで、該当タスク行のカード詳細に「`.flywheel/runs.jsonl` — `delegate_start` の `ts`・`session_id`・対応する delegate_end なし」相当の取得元が表示される（FR-A5 により行番号は含まれないこと）
- [ ] AC-2: 同フィクスチャの stale 行（⚠ 更新なし）で、AgentColumn の行内にも取得元 1 行が表示される。stale でない実行中行には表示されない
- [ ] AC-3: カード詳細の「元レコード」を展開すると、導出元イベントの生 JSON 1 行がそのまま表示される
- [ ] AC-4: 台帳に存在する課題 ID の実行中 Run 行に台帳タイトルが表示され、カード詳細にタイトル・説明・完了条件・タスク案・優先度・ステータスが表示される
- [ ] AC-5: 台帳（アーカイブ含む）に存在しない課題 ID の Run 行では「台帳に見つかりません」と表示され、行の他の表示（経過時間・再開ボタン等）は壊れない
- [ ] AC-6: 説明・完了条件・タスク案が無い課題でも台帳セクションの表示がエラーにならない（該当項目は半角ハイフン `-` で省略表示する。CardDetailModal の既存の欠損表示と同じ規約）
- [ ] AC-7: 既存テストが全て green のまま（`runningRuns` を参照する既存 UI・パーサテストへの回帰なし）
- [ ] AC-8: 台帳テキスト・生レコードに HTML/スクリプト断片が含まれていても、プレーンテキストとして表示される（実行・解釈されない）
