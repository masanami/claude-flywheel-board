# P3: 実行中パネル＋カード→セッション連携

> **✅ 依存すべて解消済み・着手可能**（2026-07-18）: P0 は claude-flywheel PR #45 で解消（`runs.jsonl` 正本仕様は claude-flywheel `templates/runtime/README.md`。本書は突き合わせ済み）。P2（プリフィル基盤・terminal-control）は PR #24 で main にマージ済み。

## 概要

`runs.jsonl` から実行中のサイクル・委譲セッションを検出してボードに表示し、応答なし（要確認）を警告する。タスクカードから `claude -p --resume <session-id>` をプリフィルしたターミナルを開き、介入を最短動線にする。

- 対応要件: FR-05, FR-12 ＋ FR-02 のカラムヘッダ「サイクル状態」表示 ＋ FR-08 の作業ログへの runs 統合 / NFR-01, 05
- 依存: claude-flywheel P0（✅ 解消済み）＋ P2 プリフィル基盤（✅ main マージ済み）＋ P1 ボード UI（✅ main マージ済み）
- 関連: [requirements.md](../requirements.md) §6.1〜6.2 / [architecture.md](../architecture.md) §3.3〜3.5・§4.1・§5.2

## 背景・目的

課題台帳のステータスはサイクル単位でしか更新されず、委譲中の `claude -p` セッションが「いま」何をしているかはどこにも見えない。クラッシュした子セッションは放置されると丸ごと時間を失うため、検知→介入の動線を最短にする。

## ユーザーストーリー

fleet の管理者として、実行中の委譲セッションと応答なしの疑いがあるセッションをボード上で検知し、カードからワンアクションで再開コマンド入りターミナルを開いて介入したい。

## 機能要件

- [x] **runs.jsonl パース**: 各 repo の `.flywheel/runs.jsonl` を watcher の監視対象に加え、append-only JSONL としてパースする。壊れた行は `parse_error` としてエラーカード表示（FR-07 の適用拡張。正本仕様も「消費者がパースエラーとして可視化する前提」と明記）
- [x] **実行中の導出**: start イベントに対応する end がないものを「実行中」とする。**対応付けキーはイベント種別ごと**（cycle→`cycle` / delegate→`session_id` / adhoc→`id`）。delegate の対応付けは「同一 `session_id` の**最新の未終了 start**」（別サイクル持ち越し resume で同一 ID が再登場するため）。カラム 1 段目「実行中」に課題 ID・委譲先 repo・経過時間を表示する（FR-05）
- [x] **差し込み（adhoc）の表示**: `adhoc_start/end` も実行中として表示する（`title` を表示。`challenge`/`repo` は任意フィールド）。**未終了 adhoc は claude-flywheel 側で代筆回収されない**ため、しきい値超過の要確認表示は board の責務（FR-13 の可視化）
- [x] **応答なし警告**: 実行中の経過時間がしきい値を超えたら `stale` フラグを付け、⚠「応答なし（要確認）」として警告表示する（FR-05）
- [x] **しきい値設定**: 既定 **30 分**・全体一律。起動引数 / 環境変数（例: `FLYWHEEL_BOARD_STALE_MINUTES`）で変更可能（AO-02 確定済み。エージェントごとの個別指定は必要になったらマニフェスト拡張で対応）
- [x] **カラムヘッダのサイクル状態**: `cycle_start`/`cycle_end` から「実行中 / idle / ⚠応答なし」をヘッダに表示する（FR-02 の残り）。ヘッダの「実行中」表示ラベルは「サイクル実行中」であり、1 段目の「⚡ 実行中」セクション（delegate/adhoc の実行中 Run 一覧）とは別概念（混同回避のためラベルを分けている）
- [x] **子セッション再開の連携**: ⚠応答なしカードとカード詳細モーダルの「再開コマンドを挿入」ボタンで、該当エージェントのタブに `cd <委譲先クローン> && claude -p --resume <session-id>` をプリフィルする（P2 のプリフィル基盤を使用。実行はしない。通常カードにはボタンを置かない）（FR-12）
- [x] **作業ログへの runs 統合**: カード詳細の作業ログタイムライン（P1・journal 由来）に、runs.jsonl 由来のイベント（delegate_start/end 等）をソースバッジ `runs` 付きで統合する（FR-08 の拡張）

## 非機能要件

- **契約追従**: runs.jsonl の解釈は claude-flywheel 側の正本仕様に従う。参考ドラフトと食い違った場合は正本を正とし、board のパーサを追従させる（NFR-05）
- **自動実行の禁止**: resume はプリフィルまで。Enter は人間が押す（NFR-01・設計原則 2）

## 技術的な制約・方針

- 使用技術: P1/P2 と同一スタック。追加ライブラリなし
- 変更対象: `src/server/parsers/runs.ts`（新規）、`src/server/cache.ts`（runs エンティティと stale 導出）、`src/server/watcher.ts`（監視対象追加）、`src/ui/components/`（実行中セクション・ヘッダ状態・セッションを開く動線）
- 既存コードとの関係: P1 のパーサ分離構造（ledger / runs で独立）と P2 のプリフィル API に載せる。本フェーズで新しい書き込み経路・API 形状は増やさない

## クリティカル設計決定

### runs.jsonl 契約への追従（外部契約）

- **採用案**: パーサを `parsers/runs.ts` に**単独分離**し、正本仕様（claude-flywheel `templates/runtime/README.md`）のうち board の消費に必要なフィールド（ts / event / cycle / challenge / repo / session_id / result / id / title）だけを解釈する。仕様変更時の追従はパーサ 1 ファイルに閉じる
- **理由**: 仕様の正本は claude-flywheel 側にあり、board は消費者に徹する（NFR-05）
- **影響範囲**: `parsers/runs.ts`・`cache.ts` の runs エンティティ。UI は導出済みの実行中 / stale だけを見る

### 契約追従の手順（着手前チェックリスト）

- [x] claude-flywheel 側 P0 完了を確認（PR #45 マージ済み・2026-07-16）
- [x] 本書とドラフトを正本仕様と突き合わせ、差分（adhoc イベント・種別ごとの対応キー・resume 規則・未終了 adhoc の扱い）を反映
- [x] architecture.md §4.1 を正本参照に差し替え（AO-04 クローズ）

## 機能全体の設計

### データモデル（キャッシュ内・非クリティカル）

```typescript
type Run = {
  agent: string;
  kind: "cycle" | "delegate" | "adhoc";
  key: string;             // 対応付けキー: cycle 名 | session_id | adhoc id
  challenge?: string;      // delegate は必須・adhoc は任意
  repo?: string;           // 委譲先クローン名（repos.tsv の <name>）
  title?: string;          // adhoc のみ
  startedAt: string;       // ISO 8601
  endedAt?: string;        // なければ実行中
  result?: string;         // *_end の result（cycle は completed | abandoned）
  stale: boolean;          // 実行中 かつ 経過 > しきい値
};
```

- delegate の start/end 対応付けは「同一 `session_id` の最新の未終了 start」（正本仕様の resume 規則に従う）

- stale の再評価はイベント駆動（ファイル変更）に加えて定期タイマー（1 分間隔）で行い、`agent_update` として push する（ファイルが動かなくても経過時間で ⚠ に変わるため）

### 実装計画（チケット分解の見通し）

1. runs パーサ＋キャッシュの実行中 / stale 導出（定期再評価含む）
2. UI: ⚡ 実行中セクション・⚠ 警告・カラムヘッダのサイクル状態
3. カード「セッションを開く」→ P2 プリフィル基盤との接続（cwd＝委譲先クローン）

## 受入基準

- [x] 委譲セッションの start が記録されると、数秒以内にカラムの ⚡ 実行中に課題 ID・委譲先・経過時間が表示され、end で消える
- [x] end のない実行中がしきい値（既定 30 分）を超えると ⚠ 応答なしに変わる。しきい値は環境変数 / 起動引数で変更できる
- [x] ⚠ カードの「セッションを開く」で、cwd を委譲先クローンに合わせた `claude -p --resume <session-id>` がプリフィルされたターミナルが開き、Enter を押すまで実行されない
- [x] カラムヘッダにサイクル状態（実行中 / idle / ⚠）が表示される
- [x] runs.jsonl に壊れた行を混ぜてもボードは落ちず、エラーカードとして表示される
