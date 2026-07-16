# P1: fleet ボード（観測ビュー）

## 概要

fleet マニフェストに登録された全エージェント repo の `challenge-ledger.md`・`journal/index.jsonl` をパースし、「カラム＝エージェント」のボードとして表示する。カードはホバーで作業要約・クリックで詳細＋作業ログを表示。ファイル変更はライブ反映し、パースエラーは隠さず表示する。

- 対応要件: FR-01, FR-02（台帳由来部分）, FR-03, FR-04, FR-06, FR-07, FR-08（journal 分）, FR-09（優先度順表示部分） / NFR-01〜06
- 依存: 課題台帳フォーマット＋journal 索引（いずれも claude-flywheel 側・仕様化済み）。**即着手可能**
- 画面イメージ: モック v4 で合意済み（カード＝タイトル＋メタ 1 行・フラット・下部に常設ターミナル領域 [P2] を確保）
- 関連: [requirements.md](../requirements.md) §6.1 / [architecture.md](../architecture.md) §3.1〜3.4

## 背景・目的

claude-flywheel の状態はエージェント repo ごとに分散したファイル正本であり、横断的な現況把握には全 repo のファイルを開いて回る必要がある。ボードはこのコストをゼロにする読み取り専用の投影（projection）である。

## ユーザーストーリー

fleet の管理者として、ボードを開くだけで「だれが・どのタスクを・いまどうしているか」を把握し、承認待ちの課題を見落とさないようにしたい。

## 機能要件

- [ ] **fleet 登録**: `~/.flywheel/fleet.tsv`（`<name>\t<path>`・`#` コメント行。環境変数 / 起動引数で上書き可）を読み込み、全 repo をスキャンする（FR-01）
- [ ] **エージェント縦カラム**: カラム＝エージェント。カラムヘッダにエージェント名を表示する（FR-02。サイクル状態表示・実行中段は P3 で追加）
- [ ] **タスクカード**: `challenge-ledger.md` をパースし、タイトル＋メタ 1 行（課題 ID・ステータス〔色ドット＋テキスト〕・担当ポジション）で軽量表示する（FR-03）
- [ ] **スタックの優先度順表示**: スタック段のカードは優先度順（位置＝優先度）に並べる（FR-09 の表示部分。D&D による並べ替え動線は P2）
- [ ] **承認待ちの集約**: `計画承認待ち` / `完了確認待ち` をカラム内最上位グループ「🔔 承認待ち」としてハイライトし、fleet 横断の「承認待ちのみ」フィルタをグローバルバーに置く（FR-04）
- [ ] **ホバー要約**: カードのホバーで直近の作業要約（journal の該当課題への言及から導出）をツールチップ表示する（FR-08）
- [ ] **カード詳細・作業ログ**: カードのクリックで詳細モーダルを開き、台帳の全項目と作業ログ（journal レコードを課題 ID で突き合わせた読み取り専用タイムライン。ソースバッジ付き）を表示する（FR-08。runs.jsonl 由来イベントの統合は P3）
- [ ] **ライブ反映**: chokidar による fs-watch で対象ファイルの変更を検知し、再読み込みなしでボードへ反映する。起動時はフルスキャン、ウォッチ漏れ対策に低頻度（数分間隔）のフル再スキャンを併用する（FR-06）
- [ ] **パースエラーの可視化**: パースに失敗したエントリは `parse_error` レコードとしてキャッシュに残し、該当カラム末尾にエラーカードとして表示する（FR-07。黙って落とさない）

## 非機能要件

- **正本非改変**: board は状態ファイルに一切書き込まない。読み取り経路のみ（NFR-01）
- **ローカル完結**: サーバは **127.0.0.1 にのみバインド**する。認証なし・外部送信なし（NFR-03）
- **キャッシュ再構築可能**: 索引はメモリ上の読み取りキャッシュ。プロセス再起動＝フルスキャンで常に再構築できる（NFR-04）
- **フォーマット契約への追従**: 台帳の解釈は `challenge-ledger-format.md`（claude-flywheel 側）を正とする（NFR-05）
- **起動の軽さ**: `npm run dev`（開発）/ 単一コマンド（利用時）で起動。外部 DB・デーモン常駐なし（NFR-06）

## 技術的な制約・方針

- 使用技術（AO-03 確定済み）: Node.js / TypeScript + Hono（@hono/node-server）+ ws + chokidar + Vite + React。キャッシュはメモリ（SQLite 不採用: 規模的に不要・NFR-04 により永続化の必要がない）
- 変更対象: 新規実装（`src/server/` と `src/ui/`。§機能全体の設計を参照）
- 既存コードとの関係: なし（本機能がプロジェクトの土台。P2/P3 は本機能のサーバ・UI 上に載る）

## クリティカル設計決定

### サーバの公開範囲（セキュリティ）

- **採用案**: HTTP / WebSocket とも **127.0.0.1 固定バインド**。認証機構は設けない。listen ホストを外部から設定可能にしない（`0.0.0.0` を渡せる口を作らない）
- **理由**: 利用者は手元のマシンの個人 1 名（requirements.md §5）。認証を作り込むより「外に出さない」を構造で保証する方が確実（NFR-03）
- **代替案**: トークン認証付き外部公開 — 却下（Out of Scope: リモートアクセス・チーム共有はしない）
- **影響範囲**: `src/server/index.ts` の listen 設定。P2 の pty ブリッジも同一サーバに同居するため、この決定を引き継ぐ

## 機能全体の設計

### アーキテクチャ決定

architecture.md §1〜3 の通り「ファイルが正本、board は投影」。単一 Node プロセスに watcher / parser / キャッシュ / HTTP+WS を同居させる。

- **差分 push の粒度は「repo 単位の全量置き換え」とする**: ファイル変更検知 → 該当 repo の対象ファイルを再パース → その repo のボード状態を丸ごと WS で push する。カード単位の差分計算はしない（KISS。1 repo の台帳は高々数十件でありコストが無視できる）
- **課題の識別は常に `(agent, challenge-id)` の複合キー**: 課題 ID はエージェント内でのみ一意（medical と bi の両方に C-044 がありうる）。fleet 横断フィルタ・ログ取得でも ID 単独をキーにしない
- **キャッシュはインターフェース分離**: 実装（メモリ）は cache モジュールに閉じ、将来の SQLite 差し替え（architecture.md §3.3 の移行トリガー参照）が cache 1 ファイルの変更で済むようにする
- ディレクトリ構成:

```text
src/
  server/
    index.ts          # 起動・127.0.0.1 listen・静的配信
    manifest.ts       # fleet.tsv の読込・検証
    watcher.ts        # chokidar 監視＋低頻度フル再スキャン
    parsers/
      ledger.ts       # challenge-ledger.md → Challenge[] | ParseError[]
      journal.ts      # journal/index.jsonl → JournalEntry[] | ParseError[]
    cache.ts          # メモリキャッシュ（repo 単位で置き換え）
    api.ts            # GET /api/board・GET /api/log・WS /ws（差分 push）
  ui/                 # Vite + React
    main.tsx
    components/       # Board / AgentColumn / TaskCard / CardDetailModal / ErrorCard / FilterBar
    ws.ts             # WS 購読・再接続
```

### IF / API

```text
GET /api/board                        → BoardSnapshot（初期ロード用の全量）
GET /api/log?agent=<name>&challenge=<id> → LogEntry[]（詳細モーダル用。オンデマンド取得）
WS  /ws                               → 接続時: {type:"snapshot", board: BoardSnapshot}
                                        変更時: {type:"agent_update", agent: AgentBoard}
```

```typescript
type BoardSnapshot = { agents: AgentBoard[] };
type AgentBoard = {
  name: string;            // マニフェストの <name>
  path: string;            // repo ローカルパス
  challenges: Challenge[]; // 台帳由来。承認待ちグループ＋優先度順ソート済み
  parseErrors: ParseError[];
};
type Challenge = {
  id: string;              // 例: C-044
  title: string;
  status: LedgerStatus;    // 未分類〜完了（challenge-ledger-format.md に従う）
  priority?: string;
  position?: string;       // 担当ポジション
  needsHuman: boolean;     // 計画承認待ち | 完了確認待ち
  summary?: string;        // ホバー要約（直近 journal の該当課題への言及から導出）
};
type LogEntry = {
  ts: string;              // ISO 8601
  source: "journal" | "ledger" | "runs"; // runs は P3 で追加
  text: string;
};
type ParseError = { file: string; line?: number; message: string; raw: string };
```

### 実装計画（チケット分解の見通し）

1. プロジェクト土台（npm + TypeScript + Vite/React + Vitest/Biome のセットアップ、127.0.0.1 listen の骨格）
2. マニフェスト読込＋ledger パーサ（parse_error 含む。フィクスチャの実ファイルでテスト）
3. journal パーサ＋要約/ログ導出（課題 ID での突き合わせ）
4. メモリキャッシュ＋HTTP/WS API（snapshot・agent_update・log）
5. UI ボード（カラム・カード・承認待ちハイライト・優先度順スタック・フィルタ・エラーカード）
6. UI カード詳細（ホバー要約ツールチップ・詳細モーダル＋作業ログタイムライン）
7. watcher ライブ反映（chokidar＋フル再スキャン併用）

## 受入基準

- [ ] fleet.tsv に登録した複数 repo の課題が、ボードを開くだけでエージェント別カラムに表示される
- [ ] `計画承認待ち` / `完了確認待ち` のカードが 🔔 承認待ちグループにハイライトされ、「承認待ちのみ」フィルタで fleet 横断に絞り込める
- [ ] スタックのカードが優先度順に並ぶ
- [ ] カードのホバーで作業要約が、クリックで詳細（台帳全項目）と journal 由来の作業ログタイムラインが表示される
- [ ] エージェントが台帳を更新すると、ページ再読み込みなしで数秒以内にカードへ反映される
- [ ] 台帳・journal に壊れた行を混ぜると、該当エントリがエラーカードとして表示される（他のカードは正常表示を維持）
- [ ] board プロセスを kill しても各 repo のファイルは無変更（読み取り専用の検証）。再起動すると同じボードが再構築される
