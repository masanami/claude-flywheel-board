# claude-flywheel-board

claude-flywheel の fleet（複数の自律エージェント）を 1 画面で観測・操縦するローカル GUI。
「だれが・どのタスクを・いまどうしているか」を即答できるようにする。

## まず読む

- [docs/requirements.md](docs/requirements.md) — 要件（FR/NFR・段階導入 P1〜P3・受け入れ基準）
- [docs/architecture.md](docs/architecture.md) — 設計（構成・契約・主要フロー・技術スタック候補）

## 譲れない設計原則（実装中に楽をしたくなったらここに立ち返る）

1. **board の書き込みは「何を書くか」で 3 区分**（NFR-01。#165 で線を引き直した）。① board 自身の関心事（`fleet.tsv`・エージェント用ディレクトリ）と ② **人間の入力**（承認チェック等）は board が直接書く。③ **エージェントの状態機械**（ステータス・分類欄・journal・memory・runs.jsonl）には**一切書き込まない**——ここへの書き込みは従来どおり埋め込みターミナル内の Claude Code セッション経由。② の書き込みは**人間の git identity でコミットする**（承認の真正性・経路 1）。
2. **コマンドはプリフィルまで。自動実行しない**。実行主体は常に人間＋ターミナル内の Claude Code（architecture.md §3.5）。
3. **キャッシュは捨てて再構築できる**。正本はファイル、board 内の索引は読み取りキャッシュに限る（NFR-04）。
4. **board 停止が run-cycle の自走に影響しない**。制御プレーンの依存にならない（NFR-02）。

## 文脈（設計の経緯）

- 正本のファイルベースは維持と決定済み。DB＋API 化は不採用（エージェントは Read/Edit がネイティブ・DB 正本はサーバ常時稼働が必須依存になり cron の run-cycle を巻き込むため）。クエリの快適さは board 内の読み取りキャッシュで確保する。
- **承認は board のカードから直接行える**（#165 で FR-20 を改訂）。board が承認チェックを `[x]` に書き換え人間の git identity でコミットするため、エージェントからは「人間が GitHub 上でチェックを入れた」のと区別がつかない＝claude-flywheel 側は無変更。対話経由の承認も引き続き有効で、board が落ちていても承認できる（NFR-02）。**優先度の並べ替え・課題の新規起票の直接書き込みは段階を分けてスコープ外**（requirements.md §3.2）。
- 台帳等フォーマット仕様の正本は claude-flywheel 側 docs。board は消費者に徹し、独自解釈を持ち込まない（NFR-05）。

## 次の着手

- **P1〜P3 は全フェーズ実装完了・main にマージ済み**（2026-07-18。親 Issue #1/#2/#28 クローズ）。
- 残タスクはフォローアップ Issue（#25 キーボード操作性・#26 バックプレッシャー・#27 表示残骸・#36 cache 責務分離）。#26/#25 は「問題が出てから対処」と決定済み。#36 の cache 責務分離は P4（journal タイムライン・AO-05）着手前に対応推奨。
- **承認の board 直接書き込み（#165）は実装済み**。同 Issue が挙げた「人間の入力」区分のうち、優先度の並べ替え・課題の新規起票・人間記入欄の編集は**段階を分けてスコープ外**（requirements.md §3.2 に記録）。FR-22（既定ブランチへの昇格マージ）のボタンも上流 masanami/claude-flywheel#110 の結論待ちでスコープ外。
- 次の機能候補は P4: journal タイムライン（requirements.md OQ-03 / architecture.md AO-05。未要件化）。

## 開発原則

- **YAGNI**: 必要になるまで機能を追加しない。「念のため」の実装をしない
- **KISS**: シンプルで直接的なコードを書く。過度な抽象化を避ける
- **DRY**: 共通処理は再利用可能な関数・コンポーネントに抽出

## 技術スタック

確定済み（AO-03 クローズ。詳細は [docs/architecture.md](docs/architecture.md) §6）。

| レイヤー | 技術 |
|---------|------|
| Frontend | Vite + React + xterm.js |
| Backend | Node.js (TypeScript) + Hono (@hono/node-server) + ws + chokidar + node-pty + tmux |
| DB | -（正本はファイル。board 内キャッシュはメモリ・破棄可） |
| Test | Vitest |
| Lint/Format | Biome |
| Infra | -（ローカル起動のみ・127.0.0.1 固定バインド） |
| Package | npm |

## 開発規約

### ブランチ・コミット
- **方針**: 1チケット = 1ブランチ → PR → 必須ゲート通過後にマージ（GitHub Flow）
- **ブランチ**: `{type}/{ticket-id}-{説明}`（例: `feat/12-board-cards`）
- **コミット**: Conventional Commits + 日本語
  - type: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`
  - scope: `board`, `terminal`, `cache`, `server`, `docs`（実装開始後に見直し可）
- **PR**: ≤400行、squash マージ

### 命名規則

| 対象 | スタイル | 例 |
|------|---------|-----|
| ファイル名 | kebab-case | `ledger-parser.ts` |
| ディレクトリ名 | kebab-case | `src/server/parsers/` |
| コンポーネント | PascalCase | `AgentColumn.tsx` |
| 関数 | camelCase | `parseLedger()` |
| 定数 | SCREAMING_SNAKE_CASE | `DEFAULT_STALE_MINUTES` |

## テスト方針

- 単体テスト: Vitest。パーサ・キャッシュ導出（実行中/stale）を重点対象とする
- Mock対象: 時刻（stale 判定）、fs-watch イベント
- Mockしない: 状態ファイル（台帳・journal・runs.jsonl）の読み取りはフィクスチャの実ファイルで検証する（正本＝ファイルという設計原則に合わせる）
- **テストは実行環境の環境変数に依存させない**。設定値はテストから注入する（`resolveBoardPort(raw)` / `buildViteConfig(port)` のように、env を読む関数と純粋な解決ロジックを分ける）。`process.env` を直接読むモジュールスコープの初期化は、その env を設定している開発者だけを赤にする
- **環境変数の上書き口を追加・変更したら、非既定値を設定した状態でもテスト全体を 1 回回す**（`FLYWHEEL_BOARD_PORT=4318 npm test`）。既定値だけで回すと、変更が壊した経路がまさに測られない（Issue #175: この env の唯一の利用者だけが 4 件赤になっていたのを CI も含め誰も検知できなかった）

## ドキュメントマップ

| カテゴリ | パス | 状態 |
|---------|------|------|
| 要件定義 | docs/requirements.md | 整備済み |
| アーキテクチャ | docs/architecture.md | 整備済み |
| 機能仕様 P1: fleet ボード | docs/features/p1-fleet-board.md | 整備済み |
| 機能仕様 P2: 埋め込みターミナル | docs/features/p2-embedded-terminal.md | 整備済み |
| 機能仕様 P3: 実行中パネル | docs/features/p3-live-runs-panel.md | 整備済み（残依存は P2 のみ） |
| 機能仕様: マークダウンプレビュー | docs/features/markdown-preview.md | 整備済み（実装未着手） |
| 機能仕様: ファイルツリー書き込み系 API | docs/features/file-tree-write-api.md | 整備済み（実装未着手・Issue #144） |
| 上流フォーマット契約の vendoring | tests/fixtures/contracts/VENDORING.md | 整備済み（収録範囲・追随手順・上流不在時の扱い） |

## 品質方針

```
- 必須ゲート: lint / 型チェック / テスト（スタック確定後にコマンドを確定）
- クリティカル箇所: NFR-01 の区分③（エージェントの状態機械）への書き込み経路が
  存在しないこと。レビュー時は「board のコードに **ステータス行・分類欄・journal・
  memory・runs.jsonl** への書き込みが紛れ込んでいないか」を最優先で確認する。
  台帳への書き込みは `src/server/ledger-approval.ts` の**承認チェックボックス 1 行の
  `[ ]` → `[x]` 置換に限る**（cycle.lock 取得下・再パース検証つき・人間の git identity で
  コミット・コミット失敗時は書き戻し）。この 1 経路以外に台帳への書き込みを増やさない
- フォーマットの正本は claude-flywheel 側（NFR-05）。契約物（schemas/fixtures）は
  tests/fixtures/contracts/ へ vendoring 済み。npm test は**複製の自己検査を常に**行い、
  **上流とのズレ検査は上流 repo が手元にあるときだけ**行う（無いときは pass ではなく
  理由つき skip として結果に残る。詳細は tests/fixtures/contracts/VENDORING.md）。
  **落ちたテストの期待値を書き換えて通さない**（board の読み取りが契約とズレているなら board 側の欠陥）
- コマンドプリフィルの自動実行化は禁止（設計原則 2）
```

## よく使うコマンド

```bash
npm run dev        # サーバ＋UI を開発モードで起動
npm run build      # 本番ビルド
npm test           # Vitest
npm run lint       # Biome チェック（--fix で自動修正）
npm run typecheck  # tsc --noEmit

npm run contracts:verify  # 上流フォーマット契約（vendoring）とのズレ検査（0=一致 / 1=差分 / 2=検査不能）
npm run contracts:update  # 収録済み契約物を上流から取り直し MANIFEST を更新
```

> プロジェクト土台チケット（P1-1）でセットアップ時にこのスクリプト名で定義すること。
>
> `postinstall` は `node-pty@1.1.0` の tarball 同梱バグ（`prebuilds/darwin-*/spawn-helper` が実行権限なしで配布される。上流 [microsoft/node-pty#850](https://github.com/microsoft/node-pty/issues/850)）を fresh install のたびに補うワークアラウンド。修正済みの `node-pty`（1.1.0 より新しい安定版。2026-07-29 時点では `1.2.0-beta.14` にのみ修正が含まれる）へ更新したら、この `postinstall` エントリと本注記を削除できる。
