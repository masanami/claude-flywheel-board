# 上流契約フィクスチャ（vendoring）

このディレクトリのファイルは **claude-flywheel（フォーマットの正本）の `contracts/fixtures/ledger/` からの逐語コピー**。
board 側で編集しない（上流が改訂したら差し替える）。

| 項目 | 値 |
| --- | --- |
| 取得元 repo | `masanami/claude-flywheel` |
| 取得元パス | `contracts/fixtures/ledger/{valid,invalid}/` |
| 取得時コミット | `8708a97`（`feat(ledger-format): タスク案・完了条件の複数行形式と参照フィールド（関連リポジトリ/Issue/PR）を規定し、FR-13 の承認対象を明文化 (#93)`） |
| 規定の正本 | 同 repo `docs/challenge-ledger-format.md` §複数行フィールドの記入形式／§消費側（board 等）の読み取り規則／§関連リポジトリ・関連Issue・関連PR |

## なぜコピーするのか

- テストは**この repo 単体で完結**させる必要がある（隣接 repo の絶対パスに依存させない。NFR-04 の「キャッシュは捨てて再構築できる」と同じで、テスト資産も外部の作業ディレクトリ配置に依存させない）。
- 規定の**移行フェーズ切り替え条件**が「board 側の受理方向テストで `multiline-and-refs.md` の C-101 から `taskPlan` / `completionCriteria` を取得できることが固定されていること」を要求している。固定するにはフィクスチャが board のテストに存在する必要がある。

## 正式な vendoring 手順

コピーの同期規律（更新検知・差分検証の自動化）は別課題 **C-036** の範囲。現時点では本 README の「取得時コミット」を手がかりに手動で差し替える。

## 収録ファイル

| ファイル | 上流の位置づけ | board での用途 |
| --- | --- | --- |
| `multiline-and-refs.md` | 正例（形 A/B/C/D＋参照フィールド） | **受理方向**: 複数行タスク案・完了条件・参照フィールドを取得できること／1 行形式の後方互換 |
| `handwritten-and-ingested.md` | 正例（手書き＋ ingest 由来の引用ブロック説明） | **受理方向**: 引用行（`>`）の継続行収集／フェンス・HTML コメントの記入例を誤検出しないこと |
| `task-plan-dedented.md` | 誤例（形 F: ネスト項目のインデント欠落） | 規定どおり値が結びつかない（欠落）ことの固定・クラッシュしないこと |
| `task-plan-bold-heading.md` | 誤例（形 E: 太字見出しブロック） | 同上 |
| `continuation-break-variants.md` | 誤例（結合切れの各種） | 同上 |
| `related-refs-freetext.md` | 誤例（参照フィールドの自由記述・URL） | リンク化せずテキストのまま保持すること・クラッシュしないこと |
