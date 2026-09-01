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
 * 待受ポートを解決する。未設定（または空文字）なら DEFAULT_PORT。
 *
 * 不正な値は既定へフォールバックせず Error を throw する。フォールバックすると
 * 「別ポートで起動したつもりが 4317 に戻り、先に動いていた別アカウントの board へ
 * ブラウザが繋がる」という**サイレントな取り違え**を招くため（fleet.tsv の不正行を
 * 起動時の致命的エラーとして扱う manifest.ts と同じ方針）。
 *
 * @param raw テスト用の差し替えシーム。本番経路では省略し環境変数を読む。
 */
export function resolveBoardPort(
  raw: string | undefined = process.env[BOARD_PORT_ENV_KEY],
): number {
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
