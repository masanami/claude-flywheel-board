/**
 * board サーバの待受ポート解決。
 *
 * ホスト（127.0.0.1）は NFR-03 により固定で、外部から上書きできる口を意図的に
 * 作らない。一方**ポートは上書きできる**。同一マシンで複数の OS アカウントが
 * board を並走させたい場合、127.0.0.1 はアカウント間で共有されるループバックの
 * ため、既定ポート固定だと 2 つ目が EADDRINUSE で起動できないため。
 *
 * 注意: ポートを分けても**アクセス制御にはならない**。同一マシンの他アカウントは
 * 相手のポートへそのまま接続できる（127.0.0.1 の共有は OS の性質）。ここで解決して
 * いるのは「衝突の回避」だけであり、アカウント間の分離ではない。
 */

/** 待受ポートを上書きする環境変数キー（FLYWHEEL_FLEET_MANIFEST と同じ命名規則）。 */
export const BOARD_PORT_ENV_KEY = "FLYWHEEL_BOARD_PORT";

/** 環境変数で上書きされなかった場合の既定ポート。 */
export const DEFAULT_PORT = 4317;

/**
 * 生の文字列から待受ポートを解決する。未設定（`undefined`）・空文字・空白のみなら
 * DEFAULT_PORT。
 *
 * この関数は **process.env を読まない純関数**である。環境変数を読む経路は
 * {@link resolveBoardPortFromEnv} に分離してある。かつては `raw` を
 * `= process.env[BOARD_PORT_ENV_KEY]` の既定引数にしていたが、JS の既定引数は
 * **明示的に渡した `undefined` でも発火する**ため、「値が無いこと」を表現しようと
 * `resolveBoardPort(undefined)` と書いた呼び出しが黙って環境変数へ落ちていた
 * （Issue #175: `FLYWHEEL_BOARD_PORT` を設定した環境で port.test.ts が落ちた原因）。
 * 引数を必須にして、この取り違えが型で起きないようにしている。
 *
 * 不正な値は既定へフォールバックせず Error を throw する。フォールバックすると
 * 「別ポートで起動したつもりが 4317 に戻り、先に動いていた別アカウントの board へ
 * ブラウザが繋がる」という**サイレントな取り違え**を招くため（fleet.tsv の不正行を
 * 起動時の致命的エラーとして扱う manifest.ts と同じ方針）。
 */
export function resolveBoardPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${BOARD_PORT_ENV_KEY} には 1〜65535 の整数を指定してください（指定値: ${JSON.stringify(raw)}）`,
    );
  }

  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    throw new Error(
      `${BOARD_PORT_ENV_KEY} は 1〜65535 の範囲で指定してください（指定値: ${JSON.stringify(raw)}）`,
    );
  }

  return port;
}

/**
 * 環境変数から待受ポートを解決する。本番経路（サーバ起動・vite dev proxy）はこちらを使う。
 *
 * @param env 差し替えシーム。テストは `{}`（＝未設定）や `{ [BOARD_PORT_ENV_KEY]: "4318" }`
 *   を明示的に渡すことで、実行環境の環境変数に左右されずに検証できる。
 */
export function resolveBoardPortFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveBoardPort(env[BOARD_PORT_ENV_KEY]);
}
