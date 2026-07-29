import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";
import type { WebSocket } from "ws";
import type { GetFleetEntries } from "../manifest.ts";
import { validateMdPath } from "./path-validation.ts";

// Issue #67: プレビュー用の動的 watch モジュール。
//
// 既存 watcher.ts（board 用キャッシュ責務。fleet 全体の固定パス・repo 直下
// depth:0 の非再帰ガード）とは目的も対象も異なる別モジュールとして分離する
// （#36 の責務分離方針）。こちらは「クライアントが開いている .md ファイルだけ」を
// 動的に増減する watch 対象とし、repo 全体の再帰監視は一切追加しない。
//
// 購読状態（どのクライアントがどのファイルを見ているか）はメモリ上にのみ保持し
// 破棄可能（NFR-04 の「キャッシュは捨てて再構築できる」と同じ性質）。状態ファイル
// （台帳・journal・memory・runs.jsonl）への書き込み経路はこのモジュールにも
// 一切存在しない（NFR-01）。

export type MdFileChangedMessage = {
  type: "md_file_changed";
  repo: string;
  path: string;
};
export type MdSubscribeErrorMessage = {
  type: "md_subscribe_error";
  repo: string;
  path: string;
};

type Subscription = {
  repo: string;
  path: string;
  resolvedPath: string;
};

type WatchEntry = {
  clients: Set<WebSocket>;
  watcher: FSWatcher;
};

export type MdWatchRegistry = {
  /**
   * repo/path（repo 相対パス）の購読を要求する。#63 の共有パス検証
   * （validateMdPath）に通らない場合は watch を一切開始せず、該当クライアントへ
   * のみ md_subscribe_error を返す。
   *
   * クライアントごとに購読は最大1件のため、別ファイルへの新規購読・切り替え時は
   * 既存の購読を自動的に解除してから行う（親 Issue #61 の決定「新たな
   * md_subscribe 受信時は既存購読を自動解除してから切り替える」に従う。新規
   * 購読の検証に失敗した場合、旧購読は復元しない＝クライアントは無購読状態に
   * なる。これは仕様上の「切替」の一部と解釈した設計判断であり、md_subscribe
   * に対する明示的な取り消し操作は無い）。
   *
   * ただし「今まさに購読中の同じファイル」への再 subscribe は例外的に
   * no-op に近い扱いとする（watch の張り直しは行わずラベルのみ更新する。
   * 理由は subscribe() 実装のコメントを参照）。
   */
  subscribe(ws: WebSocket, repo: string, path: string): void;
  /**
   * 該当クライアントの現在の購読（あれば）を解除する。refcount が 0 になった
   * ファイルの chokidar watch のみを解除する。購読していないクライアントに
   * 対して呼んでも no-op（例外を投げない）。md_unsubscribe メッセージ・WS
   * 切断（close/error）の両方からこの1つのメソッドを呼び出せば足りる設計。
   *
   * `match`（repo/path）を渡した場合、現在の購読ラベルと一致する場合のみ
   * 解除する（md_unsubscribe メッセージ経由の呼び出し向け。順序が入れ替わった
   * ／遅延したリクエストが、その後に成立した別ファイルの購読を誤って解除
   * しないためのガード）。省略した場合（WS 切断由来のクリーンアップ向け）は
   * 現在の購読が何であれ常に解除する。
   */
  unsubscribeClient(
    ws: WebSocket,
    match?: { repo: string; path: string },
  ): void;
  /**
   * このレジストリが保持する全 chokidar watch を解除し、購読状態も破棄する
   * （サーバシャットダウン時の解放用。既存 FleetWatcher.close() と同じ位置付け）。
   */
  closeAll(): Promise<void>;
};

/**
 * WS `/ws` に prefixした md_subscribe / md_unsubscribe を処理するレジストリを
 * 生成する。
 *
 * @param getFleetEntries repo ルート解決に使う fleet entries の遅延参照
 *   （#62 と同じ DI パターン。呼び出しごとに参照するため、生成時点では
 *   評価しない）。
 * @param broadcastFileChanged ファイル変更検知時に呼ばれるコールバック。
 *   接続中の全クライアントへ配信する処理は呼び出し側（api.ts）の責務とする
 *   （wss.clients の走査は attachWebSocketServer が既に broadcastAgentUpdate
 *   で行っているのと同じ場所に集約する）。
 */
export function createMdWatchRegistry(
  getFleetEntries: GetFleetEntries,
  broadcastFileChanged: (message: MdFileChangedMessage) => void,
): MdWatchRegistry {
  const watchesByResolvedPath = new Map<string, WatchEntry>();
  const subscriptionByClient = new Map<WebSocket, Subscription>();

  /**
   * entry.clients に属する各クライアントの「現在の購読ラベル」（repo/path）を
   * subscriptionByClient から引き直し、ラベルの重複を除いて md_file_changed を
   * 配信する。
   *
   * セルフレビュー指摘対応: 当初は entry 自体に repo/path を1組だけ持たせ、
   * 最初にその resolvedPath を購読したクライアントのラベルで固定していた。
   * しかし同一実体（resolvedPath）に別ラベルで到達できるケース（symlink 経由の
   * 別名パス・repo 相対パスの表記揺れ等）では、2人目以降のクライアントが
   * 自分の購読ラベルと一致しない通知を受け取れず、クライアント側でラベル
   * 一致フィルタをかけた場合にライブ更新が黙って止まる不具合があった。
   * entry には repo/path を持たせず、都度 subscriptionByClient から実体を
   * 引くことで、購読中の全ラベルへ正しく配信する。
   */
  function notifyChangedForEntry(entry: WatchEntry): void {
    const notifiedLabels = new Set<string>();
    for (const client of entry.clients) {
      const subscription = subscriptionByClient.get(client);
      if (!subscription) {
        continue;
      }
      // セルフレビュー指摘対応: repo/path をスペース区切りで連結すると、
      // (repo="a b", path="c.md") と (repo="a", path="b c.md") のように
      // 異なるラベルが同一キーへ衝突しうる（repo 名は fleet.tsv 由来で
      // スペースを含む名前を書式上排除できない）。JSON.stringify による
      // タプル表現なら区切り文字の曖昧さが生じない。
      const labelKey = JSON.stringify([subscription.repo, subscription.path]);
      if (notifiedLabels.has(labelKey)) {
        continue;
      }
      notifiedLabels.add(labelKey);
      broadcastFileChanged({
        type: "md_file_changed",
        repo: subscription.repo,
        path: subscription.path,
      });
    }
  }

  /**
   * resolvedPath に対応する WatchEntry を返す（無ければ chokidar watch を
   * 開始して新規作成する）。
   */
  function ensureWatchEntry(resolvedPath: string): WatchEntry {
    const existing = watchesByResolvedPath.get(resolvedPath);
    if (existing) {
      return existing;
    }

    // 新規ファイル: chokidar watch を開始する。エディタのアトミック保存
    // （unlink→add でファイルを差し替える方式）にも追従できるよう、change に
    // 加えて add も変更通知の対象とする。
    //
    // セルフレビュー指摘対応: 当初 unlink（削除）は「ファイル自体が消えるため
    // 通知対象に含めない。クライアントは再取得時に消失を検知できる」としていたが、
    // 通知が飛ばない以上クライアントには再取得のトリガーが無く、削除・リネーム後も
    // プレビューが古い内容を無言で表示し続ける不具合があった。unlink も
    // notify 対象に含め、クライアントが再フェッチして GET /api/md/file 側の
    // 404（Issue #63/#66 で検証済み）を得られるようにする（watcher.ts が
    // add/change/unlink すべてを再スキャン契機にしているのと同じ方針）。
    // depth: 0 は単一ファイル watch では通常無関係だが、watcher.ts の非再帰
    // ガード方針（repo 全体を再帰監視しない）をこのモジュールでも明示するため
    // 防御的に指定する。
    const watcher = watch(resolvedPath, { ignoreInitial: true, depth: 0 });
    // 監視失敗（権限不足等）で watcher プロセス全体が落ちないよう、
    // 'error' イベントには必ずハンドラを付ける（EventEmitter は未処理の
    // 'error' で throw する。watcher.ts と同じ理由）。
    watcher.on("error", (error: unknown) => {
      console.error(
        `[md/watch] chokidar でエラーが発生しました (${resolvedPath}):`,
        error,
      );
    });

    const entry: WatchEntry = { clients: new Set(), watcher };
    // change イベントの debounce は意図的に持たない: #26（バックプレッシャー）
    // は「問題が出てから対処」と決定済みであり、対象は開いている1ファイルの
    // 保存イベントのみ（watcher.ts が対象とする複数エージェントの連続書き込み
    // ほど頻度・規模が大きくない）ため、現時点では簡潔さを優先する。
    const notify = () => notifyChangedForEntry(entry);
    watcher.on("change", notify);
    watcher.on("add", notify);
    watcher.on("unlink", notify);

    watchesByResolvedPath.set(resolvedPath, entry);
    return entry;
  }

  function removeClientFromEntry(ws: WebSocket, resolvedPath: string): void {
    const entry = watchesByResolvedPath.get(resolvedPath);
    if (!entry) {
      return;
    }
    entry.clients.delete(ws);
    if (entry.clients.size > 0) {
      return;
    }
    // refcount が 0 になった時点でのみ chokidar watch を解除する
    // （親 Issue #61 の決定）。close() の結果は待たずに切り離す
    // （fleetWatcher.close() と異なりプロセス終了ではなく都度発生する
    // イベントのため、呼び出し元を待たせない）。失敗時もプロセス全体を
    // 落とさないよう必ず catch する。
    watchesByResolvedPath.delete(resolvedPath);
    entry.watcher.close().catch((error: unknown) => {
      console.error(
        `[md/watch] chokidar watch の解除に失敗しました (${resolvedPath}):`,
        error,
      );
    });
  }

  function unsubscribeClient(
    ws: WebSocket,
    match?: { repo: string; path: string },
  ): void {
    const existing = subscriptionByClient.get(ws);
    if (!existing) {
      return;
    }
    // セルフレビュー指摘対応: md_unsubscribe メッセージ経由（match 指定あり）で
    // 呼ばれた場合のみ、要求された repo/path が現在の購読ラベルと一致するかを
    // 照合する。順序が入れ替わった／遅延した md_unsubscribe（例: 旧ファイル A
    // 用のリクエストが、A→B への切替が既に成立した後にサーバへ届く）が、
    // 直後に成立した別ファイル（B）の購読を誤って解除してしまう事故を防ぐ。
    // WS 切断（close/error）由来のクリーンアップは repo/path を伴わない
    // （match 省略）ため、この照合を経ず常に解除する（切断時は現在の購読が
    // 何であれ確実に除去する必要があるため）。
    if (
      match &&
      (existing.repo !== match.repo || existing.path !== match.path)
    ) {
      return;
    }
    subscriptionByClient.delete(ws);
    removeClientFromEntry(ws, existing.resolvedPath);
  }

  // セルフレビュー指摘対応（設計判断）: md_file_changed は複数クライアントへの
  // broadcast のため呼び出し側（api.ts）へコールバック注入する設計としたが、
  // md_subscribe_error は「リクエストした当該クライアント1件だけへの応答」で
  // あり broadcast 対象ではないため、ここで直接 ws.send する。両者を同じ
  // 経路（コールバック注入）に統一する案も検討したが、送信先が単一 vs 複数で
  // 性質が異なる操作を無理に1つの抽象に押し込めるとかえって呼び出し側の
  // シグネチャが複雑になるため見送った（KISS）。
  function sendSubscribeError(ws: WebSocket, repo: string, path: string): void {
    const message: MdSubscribeErrorMessage = {
      type: "md_subscribe_error",
      repo,
      path,
    };
    // subscribe() は ws.on("message") リスナから同期的に呼ばれるため、ここで
    // 例外が漏れると uncaughtException でプロセスごと落ちる。ws.send は相手が
    // CONNECTING（到着直後に切断したケース等）だと同期 throw するため防御する。
    // 送信失敗はエラー通知が届かないだけで、購読状態には影響しない。
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.warn(`md_subscribe_error の送信に失敗しました: ${String(error)}`);
    }
  }

  function subscribe(ws: WebSocket, repo: string, path: string): void {
    const validation = validateMdPath(getFleetEntries(), repo, path);
    if (!validation.ok) {
      // 検証失敗時も既存購読は解除する（親 Issue #61 の「自動解除してから
      // 切り替える」決定。新規購読が成立しない以上、クライアントは無購読状態
      // になる）。
      unsubscribeClient(ws);
      sendSubscribeError(ws, repo, path);
      return;
    }
    const { resolvedPath } = validation;

    // セルフレビュー指摘対応: 同一クライアントが「今まさに購読中の同じ
    // resolvedPath」へ再度 subscribe した場合（UI の再マウント等）、無条件に
    // unsubscribeClient → 新規 entry 作成を行うと、そのクライアントが唯一の
    // 購読者だったケースで既存 watch を一度 close し、直後に同じパスへ
    // 新しい watch を張り直す不要な churn が生じる。close の実処理は非同期
    // （watch() 呼び出し自体は同期的に次の watcher を張るため多重 watcher の
    // 並走自体は起きないが、旧 watcher の解除が完了するまでの間、監視の
    // 張り替えに伴う短い隙間で保存イベントを取りこぼすリスクがある）ため、
    // 実体としてファイルが変わらない再 subscribe では watch を張り直さず、
    // repo/path のラベルだけを更新する。
    const existingSubscription = subscriptionByClient.get(ws);
    if (existingSubscription?.resolvedPath === resolvedPath) {
      existingSubscription.repo = repo;
      existingSubscription.path = path;
      return;
    }

    // 1クライアント1購読: 別ファイルへの切り替え・新規購読は、常に既存購読を
    // 先に解除してから行う（親 Issue #61 の決定）。
    unsubscribeClient(ws);
    // セルフレビュー指摘対応: chokidar watch の確立（ensureWatchEntry）を
    // 先に行い、成功した後で subscriptionByClient へ登録する。逆順（先に
    // 購読状態を登録）だと、watch() が同期的に例外を投げた場合に「購読状態は
    // あるが対応する WatchEntry が無い」幻の購読が残り、しかも同一
    // resolvedPath への再 subscribe は上の fast path でラベル更新のみして
    // 早期 return するため、当該クライアントは以後 watch が張られないまま
    // ライブ更新が恒久的に無効化されてしまう（unsubscribeClient も entry
    // 不在で no-op になり自己回復しない）。
    // ensureWatchEntry（chokidar watch()）の同期例外も message リスナ経由で
    // uncaughtException になりうるため捕捉する。確立に失敗した場合は購読を
    // 登録せず、クライアントへ md_subscribe_error を返して無購読状態に倒す
    // （幻の購読を残さないという上記コメントの不変条件はそのまま保たれる）。
    let entry: WatchEntry;
    try {
      entry = ensureWatchEntry(resolvedPath);
    } catch (error) {
      console.warn(`md watch の確立に失敗しました: ${String(error)}`);
      sendSubscribeError(ws, repo, path);
      return;
    }
    entry.clients.add(ws);
    subscriptionByClient.set(ws, { repo, path, resolvedPath });
  }

  /**
   * このレジストリが保持する全 chokidar watch を解除し、購読状態も破棄する
   * （サーバ全体のシャットダウン用）。既存 startFleetWatcher の
   * FleetWatcher.close() と同じ位置付け（NFR-04: 購読状態はメモリのみ・
   * 破棄可であり、破棄後に再購読があれば自然に再構築される）。
   */
  async function closeAll(): Promise<void> {
    const entries = [...watchesByResolvedPath.values()];
    watchesByResolvedPath.clear();
    subscriptionByClient.clear();
    await Promise.all(
      entries.map((entry) =>
        entry.watcher.close().catch((error: unknown) => {
          console.error(
            "[md/watch] closeAll 中に chokidar watch の解除に失敗しました:",
            error,
          );
        }),
      ),
    );
  }

  return { subscribe, unsubscribeClient, closeAll };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * WS `ws.on("message", ...)` から呼び出す薄いディスパッチャ。JSON として
 * 解釈できない・スキーマに一致しないメッセージは黙って無視する（既存の
 * ui/ws.ts 側のパース失敗時の扱いと同じ方針。呼び出し元の接続を切断しない）。
 * md_subscribe / md_unsubscribe 以外の type（将来の拡張・未知のメッセージ）も
 * 同様に無視する。
 */
export function handleMdClientMessage(
  registry: Pick<MdWatchRegistry, "subscribe" | "unsubscribeClient">,
  ws: WebSocket,
  raw: unknown,
): void {
  if (typeof raw !== "string") {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isPlainObject(parsed)) {
    return;
  }

  if (parsed.type === "md_subscribe") {
    if (typeof parsed.repo !== "string" || typeof parsed.path !== "string") {
      return;
    }
    registry.subscribe(ws, parsed.repo, parsed.path);
    return;
  }

  if (parsed.type === "md_unsubscribe") {
    if (typeof parsed.repo !== "string" || typeof parsed.path !== "string") {
      return;
    }
    // セルフレビュー指摘対応: repo/path を match として渡し、現在の購読
    // ラベルと一致する場合のみ解除する（unsubscribeClient の設計判断を参照。
    // 順序が入れ替わった／遅延した md_unsubscribe が、その後に成立した
    // 別ファイルの購読を誤って解除しないためのガード）。
    registry.unsubscribeClient(ws, { repo: parsed.repo, path: parsed.path });
  }
}
