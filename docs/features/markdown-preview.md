# マークダウンプレビュー（右サイドパネル）

## 概要

board 右サイドの開閉式パネルに、エージェント repo 配下の Markdown ファイルを読み取り専用でレンダリング表示する。fs-watch 連動で「nvim で保存 → 即時再レンダリング」のライブプレビューを提供する。

## 背景・目的

ユーザーの編集環境は nvim（埋め込みターミナル / ネイティブ tmux attach）に決定済み。nvim 側のプレビュー手段は「別途ブラウザを開く」か「ターミナル内擬似レンダリング」で体験の上限が低い。board には chokidar（fs-watch）と React が既にあり、保存→即時再レンダリングのライブプレビューが既存スタックの自然な延長で実現できる。台帳・docs/ を board 上で読む観測用途とも兼用する。読み取り専用であり、書き込み経路を持たない（NFR-01 維持）。

## ユーザーストーリー

fleet の管理者として、nvim でドキュメントを編集しながら board の右サイドパネルでレンダリング結果をリアルタイムに確認したい。また、エージェントの docs や台帳を board 上でレンダリングされた状態で読みたい。

## 機能要件

- [ ] **右サイドパネル**: board 画面右側の開閉式パネルとしてプレビューを表示する。ボード・下部ターミナル領域とは同時表示（ターミナル領域を閉じない・高さに影響しない）。パネル幅はドラッグで調整できる
- [ ] **簡易ファイルツリー**: manifest 登録済みの各エージェント repo 配下の `.md` ファイルをツリー表示し、クリックで開く。`.` 始まりの全ディレクトリ（`.git` を含む）と `node_modules` は走査から除外する（除外ルールはこの機械的判定のみ。明示リストや .gitignore 解釈は行わない）。ツリー走査はシンボリックリンクを辿らない（lstat で判定し、ディレクトリの symlink は除外する。循環参照による無限ループ防止）。ツリーはパネルを開いたとき、およびパネルヘッダのリフレッシュボタン押下時に取得する（常時監視しない）
- [ ] **レンダリング**: GFM（テーブル・チェックボックス）、コードブロックのシンタックスハイライト、mermaid 図に対応する
- [ ] **ライブ更新**: プレビュー表示中のファイルの変更（保存）を fs-watch で検知し、手動操作なしで再レンダリングする
- [ ] **読み取り専用**: 編集 UI・保存 API は持たない。board からの書き込み経路を一切追加しない

## 非機能要件

- **セキュリティ**: ファイル読み取り API はパストラバーサル対策（クリティカル設計決定に従う）を必須とする。レンダリングは XSS 対策（同）を必須とする。エンドポイントは既存の 127.0.0.1 バインド・Origin/Host 検証を継承する
- **パフォーマンス**: repo 全体の再帰 fs-watch を常時追加しない（既存 watcher の「個別ファイル＋repo 直下 depth:0 のみ」というガードを維持する）。動的 watch はプレビューで開いているファイルに限定し、閉じたら解除する
- **サイズ上限**: 1MB を超えるファイルはレンダリングしない。読み取り API は 413 を返し、UI は「サイズが大きすぎるため表示できません」という専用エラーメッセージを表示する（プレビュー用途の想定外入力への防御）

## 技術的な制約・方針

- 使用技術: react-markdown + remark-gfm + rehype-highlight、mermaid（`securityLevel: 'strict'`）
- 変更対象: `src/server/api.ts`（エンドポイント追加）、`src/server/index.ts`（fleet entries の供給経路）、`src/server/`（プレビュー用の動的 watch モジュールを新規追加。既存 `watcher.ts` の board 用キャッシュ責務とは分離する — #36 の責務分離方針と整合）、`src/ui/components/`（PreviewPanel・FileTree を新規追加）
- **fleet entries の供給経路**: 現在の起動順は `createApp → attachWebSocketServer → loadFleetManifest` であり、API 登録時点では manifest が未ロード。`src/server/pty/bridge.ts` の `createTerminalWebSocketServer({ getFleetEntries })` と同じコールバックパターンで registerApiRoutes / attachWebSocketServer に fleet entries を供給する（`loadFleetManifest()` をハンドラ内で再呼び出しして別インスタンスを持たないこと）
- 既存コードとの関係: repo 一覧は manifest（`src/server/manifest.ts`）から取得する。変更通知は既存 WS `/ws` にメッセージ種別を追加して送る

## クリティカル設計決定

### ファイル読み取り API のパス検証（パストラバーサル対策）

- **採用案**: 正規化＋realpath 封じ込め検証。リクエストは `repo 名 + repo 相対パス` で受け、(1) manifest から repo ルートを引く（ルート自体も realpath 済みとする）、(2) 結合パスを `fs.realpath` で解決（シンボリックリンクを辿った実体で判定）、(3) 解決後パスが repo ルート配下であること、(4) 拡張子が `.md` であることをすべて満たす場合のみ読み取る。検証失敗・ファイル不存在はいずれも同一のエラー応答（404）とし、パスの存在有無を漏らさない。例外として、検証をすべて通過したファイルのサイズ超過（1MB 超）のみ 413 で区別する（「存在するが大きい」という情報は漏れるが、ローカル個人利用の脅威モデルでは許容と判断。2026-07-21 ユーザー決定）。サイズ判定はパス検証後に `fs.stat` で行い、1MB 超なら本文を読み込まずに 413 を返す（巨大ファイルの全読み込みを防ぐ）。この検証関数は HTTP の読み取り API と WS の `md_subscribe`（watch 登録）の両方に適用し、検証失敗時は watch を開始しない
- **理由**: ステートレスで実装・テストが単純。シンボリックリンク経由の脱出も realpath 解決後の封じ込め判定で防げる
- **代替案**: サーバ発行 ID 方式（ツリー API が列挙したファイルに ID を振り、読み取り API は ID のみ受理）— パスを受け取らない点で最も堅牢だが、サーバに列挙状態の保持が必要で実装が重い。ローカル個人利用の脅威モデルに対して過剰（YAGNI）のため不採用
- **影響範囲**: `src/server/api.ts` の新規エンドポイントおよび WS の `md_subscribe` ハンドラ（検証関数を共有する）。検証ロジックは単体テストの重点対象とする（`../` 相対・絶対パス・シンボリックリンク経由・`.md` 以外、の拒否ケースを HTTP・WS 両経路で網羅）

### Markdown 描画の XSS 対策

- **採用案**: react-markdown（remark-gfm / rehype-highlight）で React 要素として描画する。raw HTML は無効のまま（rehype-raw を導入しない）とし、Markdown 中の生 HTML・script はテキスト扱いで実行されない。mermaid は `securityLevel: 'strict'` で描画する
- **理由**: `dangerouslySetInnerHTML` を使わず構造的に XSS を防ぐ。React スタックとの相性が良く、サニタイザ設定の維持責任を負わない
- **代替案**: marked ＋ DOMPurify ＋ `dangerouslySetInnerHTML` — 高速だがサニタイザの許可リスト管理を自前で負い続けるため不採用
- **影響範囲**: UI（PreviewPanel）のみ。サーバは Markdown をプレーンテキストとして返すだけで HTML 変換に関与しない

## 機能全体の設計

### アーキテクチャ決定

- **ツリー列挙はオンデマンド走査**: パネルを開いたとき／手動リフレッシュ時に API が repo 配下を走査して `.md` 一覧を返す。ツリーのための fs-watch は追加しない（既存 watcher の非再帰ガードを崩さないため）
- **ライブ更新は「開いている 1 ファイルだけの動的 watch ＋ WS 通知 ＋ クライアント再フェッチ」**: クライアントが WS でプレビュー対象を subscribe すると、サーバはそのファイルだけを chokidar で watch し、変更時に変更通知メッセージを broadcast する。クライアントは自分が開いているファイルと一致する通知を受けたら HTTP で再フェッチする（WS でファイル内容は送らない。内容の取得経路を読み取り API に一本化する）。同一ファイルを複数クライアントが同時に subscribe する場合に備え、ファイルパスをキーにした購読クライアント集合（refcount）をメモリ上に保持し、unsubscribe・WS 切断のたびに該当クライアントを集合から除去する。集合が空になった時点でのみ chokidar watch を解除する（他クライアントが同じファイルを開いている間はライブ更新を止めない）。また、サーバは WS クライアントごとに現在の購読を最大 1 件保持し、新たな `md_subscribe` を受けたら同一クライアントの既存購読を自動解除してから切り替える（プレビュー対象の切替時にクライアントからの明示的な `md_unsubscribe` 送信は必須としない。送信漏れによる watch リークを構造的に防ぐ）
- **パネルを閉じる操作時は明示的に `md_unsubscribe` を送信する**: WS 接続自体は維持されたままパネルのみを閉じるケースでは自動解除のトリガー（subscribe 切替・WS 切断）が働かないため、クライアントはパネルを閉じる操作時に `md_unsubscribe` を送信し、サーバ側の購読クライアント集合から自身を除去する
- **既存 board watcher からの分離**: プレビュー用の動的 watch は台帳キャッシュ用 watcher とは別モジュールにする。subscribe 状態はメモリのみ・破棄可（NFR-04 の「キャッシュは捨てて再構築できる」と同じ性質）
- **UI レイアウト**: 右サイドパネルは flex でボードカラム領域を圧縮して確保する。下部ターミナル領域の高さ・幅には影響しない

### IF / API

```text
GET /api/md/tree
  → { repos: [{ name: string, files: string[] }] }   # files は repo 相対パス

GET /api/md/file?repo=<name>&path=<repo相対パス>
  → 200 { content: string }
  → 404（パス検証失敗・不存在・.md 以外はすべて同一応答）
  → 413（パス検証を通過したファイルの 1MB 超過のみ）

WS /ws（既存エンドポイントにメッセージ種別を追加。命名は既存の snapshot / agent_update に合わせ snake_case）
  client→server: { type: "md_subscribe",   repo: string, path: string }
  client→server: { type: "md_unsubscribe", repo: string, path: string }
  server→client: { type: "md_file_changed", repo: string, path: string }   # broadcast。クライアント側でフィルタ
  server→client: { type: "md_subscribe_error", repo: string, path: string } # 検証失敗時に該当クライアントへ返す。
                                                                            # UI は「ライブ更新は無効」の注記を表示する

既存の attachWebSocketServer はサーバ→クライアントの一方向 push のみのため、
接続ごとの購読状態（Map<WebSocket, 購読中ファイル>）と ws.on("message") ハンドラ・
close 時のクリーンアップを新規に追加する。
```

### 実装計画（チケット分解の見通し）

1. サーバ: tree / file API ＋ パス検証（単体テスト重点）
2. サーバ: 動的 watch モジュール ＋ WS 通知
3. UI: PreviewPanel（開閉・幅調整）＋ FileTree ＋ レンダリング（react-markdown / highlight / mermaid）＋ ライブ更新結線

最終分解は `/create-ticket` で行う。

## 受入基準

- [ ] manifest 登録 repo の `.md` がファイルツリーに表示され、クリックすると右サイドパネルにレンダリング表示される
- [ ] `.` 始まりディレクトリ（`.git` 含む）・`node_modules` 配下の `.md` はファイルツリーに表示されない
- [ ] パネルヘッダのリフレッシュボタン押下でファイルツリーが再取得される
- [ ] 1MB を超えるファイルを開こうとすると読み取り API が 413 を返し、UI に専用エラーメッセージが表示される（単体テストで検証）
- [ ] GFM のテーブル・チェックボックス、コードブロックのシンタックスハイライト、mermaid 図が描画される
- [ ] プレビュー表示中のファイルを nvim で保存すると、手動操作なしに再レンダリングされる
- [ ] `../` を含むパス・絶対パス・シンボリックリンク経由の repo 外パス・`.md` 以外の拡張子への読み取りリクエストがすべて 404 で拒否される（HTTP 読み取り API・WS `md_subscribe` の両経路で単体テストにより検証し、`md_subscribe` の場合は watch が開始されないことも確認する）
- [ ] Markdown 内の生 HTML・script タグが実行されずテキストとして扱われる
- [ ] パネルの開閉・幅調整ができ、ボード・ターミナル領域と同時に表示される（ターミナル領域の高さは変化しない）
- [ ] 本機能の追加コードに状態ファイル（台帳・journal・memory・runs.jsonl）への書き込み経路が存在しない（E2E ではなくコードレビュー／grep で検証する）
