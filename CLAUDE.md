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

- **P3（実行中パネル）は claude-flywheel 側の P0 待ち**: runs.jsonl スキーマ仕様化＋ run-cycle への記録規律追加＋ architecture.md §7 改訂。P0 の作業は claude-flywheel リポジトリで行う（参考ドラフトは本リポジトリ architecture.md §4.1）。
- P1（ボード）・P2（ターミナル）は台帳フォーマットだけで着手可能。
- 技術スタックは未確定（architecture.md §6・AO-03）。実装開始時に確定させる。
