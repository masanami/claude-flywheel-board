import { execFile } from "node:child_process";
import * as fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import * as path from "node:path";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentBoard, BoardCache } from "./cache.ts";
import { addFleetEntry } from "./fleet-agent-addition.ts";
import type { FleetEntry, GetFleetEntries } from "./manifest.ts";
import {
  appendFleetEntry,
  removeFleetEntry,
  resolveFleetManifestPath,
  validateFleetEntryFields,
} from "./manifest.ts";
import { validateMdPath } from "./md/path-validation.ts";
import { listMdTree } from "./md/tree.ts";
import type { MdFileChangedMessage } from "./md/watch.ts";
import { createMdWatchRegistry, handleMdClientMessage } from "./md/watch.ts";
import type { FleetWatcher } from "./watcher.ts";

/**
 * `GET /api/md/file` が読み取りを許可する上限サイズ（親 Issue #61 のクリティカル
 * 設計決定）。この基準を超えるファイルは `fs.stat` の時点で弾き、本文
 * （`fs.promises.readFile`）を一切読み込まない。
 */
const MD_FILE_MAX_BYTES = 1024 * 1024;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `POST /api/fleet/agents`（Issue #122）が必要とする書き込み系の依存。
 *
 * `fleetWatcher` は index.ts の起動シーケンス上、`registerApiRoutes` の
 * 呼び出し時点（fetch ハンドラの構築時）ではまだ生成されていない（後続の
 * startFleetWatcher ステップで作られる）。そのため `getFleetEntries`
 * （Issue #62）と同じ「呼び出し時点で遅延解決するコールバック」パターンで
 * DI する。起動シーケンス完了前にリクエストが来た場合、ハンドラは 503 を
 * 返す（起動直後のごく短い期間のみ発生しうる想定）。
 *
 * `fleetEntries`（セルフレビュー指摘対応の明記）: HTTP/WS/pty の全経路が
 * `getFleetEntries` 経由で共有する配列と**同一参照**を渡すこと（呼び出し元の
 * 契約。index.ts の本番配線では `getFleetEntries = () => fleetEntries` と
 * 同じ `fleetEntries` 変数をここへも渡している）。別の配列を渡すと、この
 * エンドポイントが追加したエージェントが `getFleetEntries()` 経由の読み取り
 * 系（GET /api/board 等）から見えなくなる。
 *
 * `getBroadcastAgentUpdate` を持たない理由: 新エージェントへの scan・
 * WS agent_update 配信は `fleetWatcher.addAgentWatch` が内部で行うため、
 * このハンドラ自身が broadcast を呼ぶ必要がない（YAGNI）。
 */
export type FleetAgentAdditionDeps = {
  /** HTTP/WS/pty の全経路が共有する fleetEntries 配列そのもの（同一参照）。 */
  fleetEntries: FleetEntry[];
  getFleetWatcher: () => FleetWatcher | undefined;
};

/**
 * `git init` のハング防止用タイムアウト（PR #134 レビュー指摘）。
 * 遅いネットワークマウント等で `git init` が返らなくなった場合、
 * `POST /api/fleet/agents` がリクエストを握ったまま返らなくなるのを防ぐ。
 * タイムアウト到達時は `error.killed === true` で既存の catch →
 * `cleanupSideEffects()` → 500 応答の経路にそのまま乗る。
 */
const GIT_INIT_TIMEOUT_MS = 30_000;

/** `git init` の標準出力/エラー出力バッファ上限（異常出力での無制限バッファリング防止）。 */
const GIT_INIT_MAX_BUFFER_BYTES = 1024 * 1024;

/** `git init` を子プロセスとして実行する（tmux.ts の execFile Promise 化パターンを踏襲）。 */
function runGitInit(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["init"],
      {
        cwd,
        timeout: GIT_INIT_TIMEOUT_MS,
        maxBuffer: GIT_INIT_MAX_BUFFER_BYTES,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

// クリティカル設計決定（親 Issue #1）: HTTP / WS とも 127.0.0.1 固定バインドを前提に、
// Host / Origin ヘッダを検証し localhost / 127.0.0.1 以外からのアクセスを拒否する。

const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
]);

/**
 * Host ヘッダ（ポート番号付きも許容）が localhost / 127.0.0.1 かどうかを判定する。
 * ヘッダが存在しない場合は拒否する（HTTP リクエストには常に Host が付与されるため）。
 */
export function isAllowedHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) {
    return false;
  }
  const hostname = hostHeader.split(":")[0] ?? "";
  return ALLOWED_HOSTNAMES.has(hostname);
}

/**
 * Origin ヘッダが http(s)://localhost / http(s)://127.0.0.1（ポート番号付きも許容）
 * かどうかを判定する。ヘッダが存在しない Origin（非ブラウザからの直接アクセス等）は許容する。
 */
export function isAllowedOrigin(
  originHeader: string | null | undefined,
): boolean {
  if (!originHeader) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  return ALLOWED_HOSTNAMES.has(url.hostname);
}

/**
 * /api/* ルートに Origin / Host 検証と board API を登録する。
 * 静的配信ミドルウェアより先に呼び出すこと（呼び出し側 index.ts の責務）。
 *
 * getFleetEntries（Issue #62）: md 系エンドポイント（Issue #65 以降）はすべて manifest
 * から repo ルートを解決する必要があるため、fleet entries を遅延参照できるコール
 * バックを受け取れるようにする（pty/bridge.ts の
 * createTerminalWebSocketServer({ getFleetEntries }) と同じ DI パターン。
 * TerminalBridgeDeps.getFleetEntries と同様、必須の依存として受け取る。省略時の
 * 既定値は上位の createApp / getServeOptions 側でのみ持たせ、この関数自身は暗黙に
 * 空 fleet へフォールバックしない）。ルート登録処理自体（この関数の呼び出し時点）は
 * getFleetEntries を呼び出さない。各 md ハンドラ内でリクエストのたびに呼び出す
 * （eager 評価を持ち込まない）。
 *
 * fleetAgentAdditionDeps（Issue #122）: `POST /api/fleet/agents` が必要とする
 * 書き込み系の依存。省略可能（既定 undefined）にすることで、この関数の既存
 * 呼び出し元（14箇所以上の既存テスト・`createApp`/`getServeOptions`）を
 * 書き換えずに済ませる。省略時、当該エンドポイントは 503 を返す。
 */
export function registerApiRoutes(
  app: Hono,
  cache: BoardCache,
  getFleetEntries: GetFleetEntries,
  fleetAgentAdditionDeps?: FleetAgentAdditionDeps,
): void {
  app.use("/api/*", async (c, next) => {
    if (!isAllowedHost(c.req.header("host"))) {
      return c.text("Forbidden", 403);
    }
    if (!isAllowedOrigin(c.req.header("origin"))) {
      return c.text("Forbidden", 403);
    }
    await next();
  });

  app.get("/api/board", (c) => c.json(cache.getSnapshot()));

  app.get("/api/log", (c) => {
    const agent = c.req.query("agent");
    const challenge = c.req.query("challenge");
    if (!agent || !challenge) {
      return c.text(
        "Bad Request: agent, challenge クエリパラメータが必要です",
        400,
      );
    }
    return c.json(cache.getLog(agent, challenge));
  });

  app.get("/api/md/tree", (c) => c.json(listMdTree(getFleetEntries())));

  // クリティカル設計決定（親 Issue #61）: 検証失敗・不存在・.md 以外はすべて同一の
  // 404 とし、パスの存在有無を漏らさない。理由は問わず validateMdPath の
  // ok:false をそのまま 404 に変換する（呼び出し側で理由分岐しない）。例外として
  // 検証をすべて通過したファイルのサイズ超過（1MB 超）のみ 413 で区別する。
  // サイズ判定は本文読み込み（fs.promises.readFile）より必ず先に fs.promises.stat
  // で行い、上限超過時は本文を一切読み込まない。
  app.get("/api/md/file", async (c) => {
    const repo = c.req.query("repo") ?? "";
    const repoRelativePath = c.req.query("path") ?? "";

    const validation = validateMdPath(
      getFleetEntries(),
      repo,
      repoRelativePath,
    );
    if (!validation.ok) {
      return c.text("Not Found", 404);
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(validation.resolvedPath);
    } catch {
      // validateMdPath 通過直後のレース（読み取り直前に削除された等）も
      // 存在有無を漏らさないため同一の 404 として扱う。
      return c.text("Not Found", 404);
    }
    if (stat.size > MD_FILE_MAX_BYTES) {
      return c.text("Payload Too Large", 413);
    }

    let content: string;
    try {
      content = await fs.promises.readFile(validation.resolvedPath, "utf-8");
    } catch (err) {
      // 権限不足・stat 後の削除レース等も、検証失敗・不存在と同様に
      // クライアントへの応答は同一の 404 とし、存在有無を漏らさない（500 を返さない）。
      // ただし運用時の切り分け（設定ミス等が「.md が読めない」と見分けが付かなくなる
      // ことを避ける目的で、tree.ts が repo ルート階層の走査失敗を console.warn で
      // 記録するのと同じ動機）のため、サーバ側ログには残す（クライアント応答は変えない）。
      // 注意: tree.ts は非ルート（個別ファイル/ディレクトリ）の走査失敗は黙殺する方針
      // であり、ここでの記録はその方針を単純に踏襲したものではない（本エンドポイントは
      // そもそも「1ファイルの読み取り」単位のため、tree.ts の非ルート走査とは対応しない）。
      console.warn(
        `GET /api/md/file: 検証通過後のファイル読み取りに失敗しました: ${validation.resolvedPath}`,
        err,
      );
      return c.text("Not Found", 404);
    }
    return c.json({ content });
  });

  // Issue #122: エージェント追加のオーケストレーション。
  // バリデーション → mkdir -p（必要なら git init）→ fleet.tsv 追記 → 動的監視登録
  // → 新エージェントの scan・WS agent_update 配信、の順で行う。途中で失敗した
  // 場合は、本エンドポイントが作成したディレクトリ・fleet.tsv への追記
  // ・fleetEntries 配列への追加を後始末し、追加前と同等の状態へ戻す
  // （既存ディレクトリ・既存 fleet.tsv 行は絶対に消さない）。
  app.post("/api/fleet/agents", async (c) => {
    if (!fleetAgentAdditionDeps) {
      return c.json({ error: "エージェント追加機能は現在利用できません" }, 503);
    }
    const fleetWatcher = fleetAgentAdditionDeps.getFleetWatcher();
    if (!fleetWatcher) {
      // サーバ起動シーケンス完了前のごく短いウィンドウにのみ発生しうる。
      return c.json(
        {
          error:
            "サーバの起動処理が完了していません。しばらく待ってから再試行してください",
        },
        503,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "リクエストボディが不正な JSON です" }, 400);
    }

    const { name: rawName, path: rawPath } = (body ?? {}) as {
      name?: unknown;
      path?: unknown;
    };
    if (typeof rawName !== "string" || rawName.trim() === "") {
      return c.json({ error: "name は必須の文字列です" }, 400);
    }
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      return c.json({ error: "path は必須の文字列です" }, 400);
    }

    // trim のみ行った時点で絶対パス判定する（セルフレビュー指摘対応:
    // path.resolve() は相対パスも cwd 基準で絶対化してしまうため、正規化済みの
    // 値で isAbsolute を判定すると常に true になり判定が無意味になる。
    // manifest.ts の appendFleetEntry と同じ「trim → isAbsolute 判定 → resolve」
    // の順序に揃える）。
    const trimmedRawPath = rawPath.trim();
    if (!path.isAbsolute(trimmedRawPath)) {
      return c.json(
        {
          error: `path は絶対パスである必要があります（相対パス・"~" 始まりの表記は使用できません）: "${rawPath}"`,
        },
        400,
      );
    }

    // 以降のすべての fs 操作・fleet.tsv 追記・レスポンスで単一の正規化済み値を
    // 使う（セルフレビュー指摘対応: mkdir/git init が生の rawPath を使う一方、
    // appendFleetEntry は trim + path.resolve した別の値を fleet.tsv へ書き込み
    // 返していたため、末尾空白等を含む入力では「実際に作られたディレクトリ」と
    // 「fleet.tsv・監視対象に登録されるパス」が食い違い、孤児ディレクトリと
    // 実体の無い監視対象エージェントが生まれる不具合があった）。
    const name = rawName.trim();
    const entryPath = path.resolve(trimmedRawPath);

    // 名前規則（タブ/改行混入・"#" 始まり・予約接尾辞 "-shell"）は
    // manifest.ts の validateFleetEntryFields をそのまま再利用し、
    // mkdir・git init という fs 副作用より前に検証する（セルフレビュー指摘
    // 対応: 以前は appendFleetEntry 呼び出し時＝mkdir/git init の後でしか
    // 検証されず、既存の未 git 化ディレクトリを指定して不正な name を送ると、
    // リクエストは 400 で拒否されつつ .git だけが残置されるロールバック漏れが
    // あった）。
    const fieldValidationError = validateFleetEntryFields(name, entryPath);
    if (fieldValidationError) {
      return c.json({ error: fieldValidationError }, 400);
    }

    // name/path の衝突は、後段の appendFleetEntry でも検証される（fleet.tsv 上の
    // 権威ある検証）が、ここで fs 側の副作用（mkdir・git init）より先に検出する。
    // 特に path 重複は「既存の登録済みエージェントのディレクトリを指す」ケースが
    // 主因であり、事前チェックを省いて mkdir/git init まで進めてしまうと、
    // 既存エージェントの作業ディレクトリに（未 git 化であれば）意図せず git init を
    // 実行してしまう恐れがある（「既存エージェントの観測・ターミナルセッションに
    // 影響しない」という完了条件に反する）。
    if (fleetAgentAdditionDeps.fleetEntries.some((e) => e.name === name)) {
      return c.json(
        {
          error: `fleet マニフェストへの追記に失敗しました（name "${name}" が既存 fleet と重複しています）`,
        },
        400,
      );
    }
    if (
      fleetAgentAdditionDeps.fleetEntries.some(
        (e) => path.resolve(e.path) === entryPath,
      )
    ) {
      return c.json(
        {
          error: `fleet マニフェストへの追記に失敗しました（path "${entryPath}" が既存 fleet と重複しています）`,
        },
        400,
      );
    }

    // mkdir -p。既に存在するディレクトリの場合、recursive: true は何も作らず
    // undefined を返す（本エンドポイントが作った場合のみ後始末するための判定に使う）。
    let createdDirRoot: string | undefined;
    try {
      createdDirRoot =
        fs.mkdirSync(entryPath, { recursive: true }) ?? undefined;
    } catch (error) {
      // mkdir 失敗（権限不足・パス途中に非ディレクトリが存在する等）はクライアント
      // の入力誤りというよりサーバ/環境側の問題のため 500 で返す
      // （セルフレビュー指摘対応: 以前はここも含めすべての失敗を 400 にしていた）。
      return c.json(
        { error: `ディレクトリの作成に失敗しました: ${toErrorMessage(error)}` },
        500,
      );
    }

    // 本エンドポイントが実行した git init（既存ディレクトリに対して行った場合）も
    // 後始末の対象に含める（セルフレビュー指摘対応: 以前は mkdir で新規作成した
    // 場合のみ後始末しており、既存の未 git 化ディレクトリに git init した後で
    // 別の理由（fleet.tsv 側の重複・監視登録失敗等）で失敗すると、.git だけが
    // 残置されてしまっていた）。
    let weRanGitInit = false;

    // 副作用（mkdir で作ったディレクトリ、または既存ディレクトリに対して実行した
    // git init）を後始末する。rmSync 自体の失敗（セルフレビュー指摘対応: 並行して
    // 同じパスへ別のリクエストが書き込み中の場合に ENOTEMPTY 等で例外を投げうる）
    // で呼び出し元のエラーレスポンス（構造化 JSON）が壊れないよう、ここで確実に
    // 例外を握り潰す。
    function cleanupSideEffects(): void {
      try {
        if (createdDirRoot) {
          fs.rmSync(createdDirRoot, { recursive: true, force: true });
          return;
        }
        if (weRanGitInit) {
          fs.rmSync(path.join(entryPath, ".git"), {
            recursive: true,
            force: true,
          });
        }
      } catch (error) {
        console.error(
          "[api] 作成したディレクトリ／git 初期化の後始末に失敗しました:",
          error,
        );
      }
    }

    // 必要なら git init（既に .git があるリポジトリには実行しない）。
    if (!fs.existsSync(path.join(entryPath, ".git"))) {
      // 実行前にフラグを立てる（セルフレビュー指摘対応: await 成功後にのみ
      // 立てていると、git init 自体が失敗した場合に部分的に生成されうる
      // .git ディレクトリが後始末対象から漏れる。cleanupSideEffects の
      // rmSync は force: true のため、.git が実際には存在しない/未完成でも
      // 安全に no-op として扱える）。
      weRanGitInit = true;
      try {
        await runGitInit(entryPath);
      } catch (error) {
        cleanupSideEffects();
        return c.json(
          { error: `git init に失敗しました: ${toErrorMessage(error)}` },
          500,
        );
      }
    }

    // fleet.tsv 自体が読み書きできることを事前に確認する（存在しない・権限不足等は
    // クライアント入力の問題ではないため 500 として appendFleetEntry の一般的な
    // 400 経路とは区別する）。後続の appendFleetEntry は追記（書き込み）を行うため、
    // 読み取り権限のみの確認では書き込み不可のケースを検出できず、appendFileSync が
    // EACCES で失敗して下の catch により 400（入力エラー扱い）に誤分類されてしまう。
    // そのため R_OK と併せて W_OK も検査する。
    const manifestPath = resolveFleetManifestPath();
    try {
      fs.accessSync(manifestPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      cleanupSideEffects();
      return c.json(
        {
          error: `fleet マニフェストの読み書きに失敗しました: ${toErrorMessage(error)}`,
        },
        500,
      );
    }

    // overridePath は本番配線では絶対に渡さない（manifest.ts のコメント参照）。
    let entries: FleetEntry[];
    try {
      entries = appendFleetEntry({ name, path: entryPath });
    } catch (error) {
      cleanupSideEffects();
      return c.json({ error: toErrorMessage(error) }, 400);
    }

    // 追加された entry は name で特定する（セルフレビュー指摘対応: 以前は
    // `entries[entries.length - 1]` と末尾要素決め打ちで取得しており、
    // appendFleetEntry の戻り値の順序という実装詳細に依存していた）。name は
    // 上のバリデーション・重複チェックで一意性が保証されている。
    const newEntry = entries.find((e) => e.name === name);
    if (!newEntry) {
      cleanupSideEffects();
      return c.json(
        { error: "fleet エントリの追記に失敗しました（想定外の状態）" },
        500,
      );
    }

    try {
      // addFleetEntry（fleet-agent-addition.ts、Issue #121）をそのまま使う
      // （独自の再実装をしない）。内部で fleetEntries.push →
      // fleetWatcher.addAgentWatch を行う。addAgentWatch は当該 entry の
      // scan → cache 反映 → broadcastAgentUpdate（onAgentUpdate 経由）まで
      // 内部で行うため、ここで scanAndUpdateAgent を重ねて呼ばない
      // （二重スキャンの防止）。
      await addFleetEntry(
        fleetAgentAdditionDeps.fleetEntries,
        fleetWatcher,
        newEntry,
      );
    } catch (error) {
      // addFleetEntry は push 成功後に addAgentWatch が失敗しても push した
      // entry をロールバックしない（fleet-agent-addition.ts にドキュメント化
      // された既知の挙動）。ここで確実に取り除く。
      const idx = fleetAgentAdditionDeps.fleetEntries.indexOf(newEntry);
      if (idx !== -1) {
        fleetAgentAdditionDeps.fleetEntries.splice(idx, 1);
      }
      // fleet.tsv への追記の取り消しは manifest.ts の removeFleetEntry に委ねる
      // （セルフレビュー指摘対応: 以前は api.ts 側でバイトオフセット truncate や
      // 差分文字列の抜き出しを自前で行っており、(a) 追記〜失敗判明までの間に
      // 別リクエストが追記した行を巻き添えで消す、(b) 末尾改行の無い既存内容に
      // 対する行区切り用の補完 \n を誤って一緒に消し前後の行を連結させ fleet.tsv
      // を壊す、という実問題があった。fleet.tsv の書式・除去ロジックは
      // manifest.ts に一本化し、api.ts は結果のみを見る）。
      try {
        const removed = removeFleetEntry(name, entryPath);
        if (!removed) {
          console.error(
            "[api] fleet.tsv のロールバックに失敗しました（追記した行が見つかりません）:",
            manifestPath,
          );
        }
      } catch (rollbackError) {
        console.error(
          "[api] fleet.tsv のロールバックに失敗しました:",
          rollbackError,
        );
      }
      cleanupSideEffects();
      return c.json(
        { error: `監視登録に失敗しました: ${toErrorMessage(error)}` },
        500,
      );
    }

    return c.json({ agent: { name: newEntry.name, path: newEntry.path } }, 201);
  });
}

export type BoardWebSocketServer = {
  wss: WebSocketServer;
  /** repo 単位の全量置き換え（watcher 由来）を接続中の全クライアントへ配信する。 */
  broadcastAgentUpdate(agent: AgentBoard): void;
  /**
   * Issue #67 の md watch レジストリが保持する chokidar watch をすべて解除する
   * （サーバシャットダウン用）。既存 FleetWatcher.close() と同じ位置付けで、
   * 呼び出し元（index.ts の SIGINT/SIGTERM ハンドラ）から fire-and-forget で
   * 呼ばれる想定。
   */
  closeMdWatches(): Promise<void>;
};

/**
 * @hono/node-server の serve() が返す http.Server に WebSocket（/ws）をアタッチする。
 * noServer: true で生成し、upgrade イベントを手動でハンドシェイクすることで
 * Origin / Host 検証を挟む（HTTP と同じ許可条件）。
 *
 * getFleetEntries（Issue #62）: registerApiRoutes と同じ受け皿（必須の依存として
 * 受け取る。既定値は上位の createApp / getServeOptions 側でのみ持たせる）。
 * Issue #67 の md watch レジストリ（createMdWatchRegistry）へこのコールバックを
 * そのまま渡し、md_subscribe ハンドラ内で repo ルート解決のたびに呼び出す
 * （eager 評価しない DI パターンは維持する）。
 */
export function attachWebSocketServer(
  server: ServerType,
  cache: BoardCache,
  getFleetEntries: GetFleetEntries,
): BoardWebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // セルフレビュー指摘対応（DRY）: 「JSON化 → 接続中の OPEN なクライアントへ
  // 送る」という配信ループは broadcastAgentUpdate と md_file_changed の配信で
  // 完全に重複していたため、共通の broadcastJson に集約する（バックプレッシャー
  // 対応（#26）等、将来この配信経路に手を入れる箇所を1つに保つ）。
  function broadcastJson(payload: unknown): void {
    const json = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  // Issue #67: プレビュー用の動的 watch（開いている1ファイルのみ）を仲介する
  // レジストリ。fleet 全体の再帰監視を行う既存 watcher.ts（board 用キャッシュ
  // 責務）とは別モジュールとして分離済み（#36 の責務分離方針）。
  function broadcastMdFileChanged(message: MdFileChangedMessage): void {
    broadcastJson(message);
  }
  const mdWatchRegistry = createMdWatchRegistry(
    getFleetEntries,
    broadcastMdFileChanged,
  );

  server.on(
    "upgrade",
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      // pathname のみを厳密一致で判定する（bridge.ts の /ws/terminal 判定と統一）。
      // request.url の完全一致だと `/ws?x` のようなクエリ付き URL がどちらの
      // upgrade ハンドラにも一致せず、半開き接続のまま残ってしまうため。
      const pathname = new URL(request.url ?? "", "http://localhost").pathname;
      if (pathname !== "/ws") {
        // このハンドラの対象外。/ws/terminal 等、他の upgrade リスナーと共存
        // させるため socket には触れない（destroy しない）。
        return;
      }
      if (
        !isAllowedHost(request.headers.host) ||
        !isAllowedOrigin(request.headers.origin)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    },
  );

  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "snapshot", board: cache.getSnapshot() }));

    // Issue #67: md_subscribe / md_unsubscribe（クライアント→サーバ）。
    // 既存の snapshot / agent_update はサーバ→クライアント一方向 push のみ
    // だったため、このメッセージ種別が最初の ws.on("message", ...) 追加になる。
    ws.on("message", (data) => {
      handleMdClientMessage(mdWatchRegistry, ws, data.toString());
    });

    // WS 切断時にも該当クライアントの購読を確実に除去する（親 Issue #61 の
    // クリティカル設計決定）。close イベントを取り逃すと refcount が
    // 減らないまま chokidar watch が残り続けてしまう。
    ws.on("close", () => {
      mdWatchRegistry.unsubscribeClient(ws);
    });
    // ws は EventEmitter のため、close を伴わない異常切断（'error'）だけが
    // 発生するケースでも購読を取りこぼさないよう、pty/bridge.ts の
    // cleanupOnDisconnect と同じ方針で 'error' でも同じクリーンアップを行う
    // （セルフレビュー指摘対応）。
    ws.on("error", () => {
      mdWatchRegistry.unsubscribeClient(ws);
    });
  });

  function broadcastAgentUpdate(agent: AgentBoard): void {
    broadcastJson({ type: "agent_update", agent });
  }

  return {
    wss,
    broadcastAgentUpdate,
    closeMdWatches: () => mdWatchRegistry.closeAll(),
  };
}
