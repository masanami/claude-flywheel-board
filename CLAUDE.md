# claude-flywheel-board

claude-flywheel の fleet（複数の自律エージェント）を 1 画面で観測・操縦するローカル GUI。
「だれが・どのタスクを・いまどうしているか」を即答できるようにする。

## まず読む

- [docs/requirements.md](docs/requirements.md) — 要件（FR/NFR・段階導入 P1〜P3・受け入れ基準）
- [docs/architecture.md](docs/architecture.md) — 設計（構成・契約・主要フロー・技術スタック候補）

## 譲れない設計原則（実装中に楽をしたくなったらここに立ち返る）

1. **board は状態ファイル（台帳・journal・memory・runs.jsonl）に一切書き込まない**。書き込みはすべて埋め込みターミナル内の Claude Code セッション経由（NFR-01）。
2. **コマンドはプリフィルまで。自動実行しない**。実行主体は常に人間＋ターミナル内の Claude Code（architecture.md §3.5）。
3. **キャッシュは捨てて再構築できる**。正本はファイル、board 内の索引は読み取りキャッシュに限る（NFR-04）。
4. **board 停止が run-cycle の自走に影響しない**。制御プレーンの依存にならない（NFR-02）。

## 文脈（設計の経緯）

- 正本のファイルベースは維持と決定済み。DB＋API 化は不採用（エージェントは Read/Edit がネイティブ・DB 正本はサーバ常時稼働が必須依存になり cron の run-cycle を巻き込むため）。クエリの快適さは board 内の読み取りキャッシュで確保する。
- **承認は対話経由が正規動線**。claude-flywheel docs にある「GitHub チェックボックス承認」は実態として使われていない。承認待ちカード→ターミナルの接続を優先する（FR-20）。
- 台帳等フォーマット仕様の正本は claude-flywheel 側 docs。board は消費者に徹し、独自解釈を持ち込まない（NFR-05）。

## 次の着手

- **P1〜P3 は全フェーズ実装完了・main にマージ済み**（2026-07-18。親 Issue #1/#2/#28 クローズ）。
- 残タスクはフォローアップ Issue（#25 キーボード操作性・#26 バックプレッシャー・#27 表示残骸・#36 cache 責務分離）。#26/#25 は「問題が出てから対処」と決定済み。#36 の cache 責務分離は P4（journal タイムライン・AO-05）着手前に対応推奨。
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

## ドキュメントマップ

| カテゴリ | パス | 状態 |
|---------|------|------|
| 要件定義 | docs/requirements.md | 整備済み |
| アーキテクチャ | docs/architecture.md | 整備済み |
| 機能仕様 P1: fleet ボード | docs/features/p1-fleet-board.md | 整備済み |
| 機能仕様 P2: 埋め込みターミナル | docs/features/p2-embedded-terminal.md | 整備済み |
| 機能仕様 P3: 実行中パネル | docs/features/p3-live-runs-panel.md | 整備済み（残依存は P2 のみ） |

## 品質方針

```
- 必須ゲート: lint / 型チェック / テスト（スタック確定後にコマンドを確定）
- クリティカル箇所: 状態ファイルへの書き込み経路が存在しないこと（NFR-01）。
  レビュー時は「board のコードに台帳・journal・memory・runs.jsonl への Write/Edit が
  紛れ込んでいないか」を最優先で確認する
- コマンドプリフィルの自動実行化は禁止（設計原則 2）
```

## よく使うコマンド

```bash
npm run dev        # サーバ＋UI を開発モードで起動
npm run build      # 本番ビルド
npm test           # Vitest
npm run lint       # Biome チェック（--fix で自動修正）
npm run typecheck  # tsc --noEmit
```

> プロジェクト土台チケット（P1-1）でセットアップ時にこのスクリプト名で定義すること。
