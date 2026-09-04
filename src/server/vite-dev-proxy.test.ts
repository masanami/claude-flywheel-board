import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedHost, isAllowedOrigin } from "./api.ts";
import { BOARD_PORT_ENV_KEY, DEFAULT_PORT } from "./port.ts";

// vite.config.ts（プロジェクトルート）の dev サーバ proxy 設定を検証する。
// Issue #43: UI(Vite:5173) と API/WS(Node:4317) が別オリジンのため、
// proxy が無いと初回スナップショットが届かず board が「読み込み中」のまま固まる。
// WS の proxy キーは正規表現でなければならない（`Board.tsx` が import する
// `/ws.ts` というソースモジュール配信パスまで巻き込んで 404 になる既知の落とし穴）。
//
// Issue #175: 転送先ポートは実行環境の FLYWHEEL_BOARD_PORT に依存させない。
// 構造の検証は `buildViteConfig(port)` へ**ポートを注入**して行い、環境変数との
// 結線は default export（遅延評価される設定ファクトリ）を env スタブ下で呼んで
// 別途固定する。以前はモジュールスコープで解決した設定を import していたため、
// FLYWHEEL_BOARD_PORT を設定している開発者だけがここで赤になっていた。
const CONFIG_PATH = fileURLToPath(
  new URL("../../vite.config.ts", import.meta.url),
);

type ViteConfigShape = {
  server?: {
    host?: string;
    proxy?: Record<string, unknown>;
  };
};

type ConfigModule = {
  default: (env: { command: string; mode: string }) => ViteConfigShape;
  buildViteConfig: (boardPort: number) => ViteConfigShape;
};

/** 検証用に注入する転送先ポート。既定値とも実行環境の設定値とも別の値を使う。 */
const INJECTED_PORT = 4321;

async function importConfigModule(): Promise<ConfigModule> {
  return (await import(CONFIG_PATH)) as unknown as ConfigModule;
}

/** ポートを注入して設定を組み立てる（実行環境の環境変数を一切参照しない経路）。 */
async function loadViteConfig(
  boardPort: number = INJECTED_PORT,
): Promise<ViteConfigShape> {
  const { buildViteConfig } = await importConfigModule();
  return buildViteConfig(boardPort);
}

/** default export（設定ファクトリ）を呼び出す。env は呼び出し時点で読まれる。 */
async function loadDefaultConfig(): Promise<ViteConfigShape> {
  const mod = await importConfigModule();
  return mod.default({ command: "serve", mode: "development" });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vite dev server proxy config (Issue #43)", () => {
  it("keeps the existing 127.0.0.1 固定 host（NFR-03）", async () => {
    const config = await loadViteConfig();
    expect(config.server?.host).toBe("127.0.0.1");
  });

  it("proxies /api to the Node server on the injected port", async () => {
    const config = await loadViteConfig();
    expect(config.server?.proxy?.["/api"]).toMatchObject({
      target: `http://127.0.0.1:${INJECTED_PORT}`,
      changeOrigin: true,
    });
  });

  it("proxies the /ws WebSocket endpoint via a regex key scoped to exactly /ws", async () => {
    const config = await loadViteConfig();
    expect(config.server?.proxy?.["^/ws$"]).toMatchObject({
      target: `ws://127.0.0.1:${INJECTED_PORT}`,
      ws: true,
    });
  });

  it("proxies the /ws/terminal WebSocket endpoint via a regex key", async () => {
    const config = await loadViteConfig();
    expect(config.server?.proxy?.["^/ws/terminal"]).toMatchObject({
      target: `ws://127.0.0.1:${INJECTED_PORT}`,
      ws: true,
    });
  });

  it("does not use a plain '/ws' prefix key (would also match the /ws.ts source module and 404)", async () => {
    const config = await loadViteConfig();
    expect(config.server?.proxy?.["/ws"]).toBeUndefined();
  });
});

// 上のブロックは proxy キー文字列の存在/不在を検証するに留まる。ここでは Vite が
// `^` 始まりキーを正規表現として解釈する挙動そのものを実 URL に対して exercise し、
// 「既知の落とし穴（`/ws.ts` を巻き込む）を実際に回避できているか」を回帰として固定する。
describe("vite dev proxy regex keys match real request URLs (Issue #43)", () => {
  it("^/ws$ matches /ws but NOT the /ws.ts source module nor /ws/terminal", async () => {
    const config = await loadViteConfig();
    const key = "^/ws$";
    expect(config.server?.proxy?.[key]).toBeDefined();
    const re = new RegExp(key);
    expect(re.test("/ws")).toBe(true);
    expect(re.test("/ws.ts")).toBe(false); // 落とし穴: ソースモジュールを巻き込まない
    expect(re.test("/ws/terminal")).toBe(false); // `$` アンカーで terminal は別ルールへ
  });

  it("^/ws/terminal matches the terminal endpoint including its query string", async () => {
    const config = await loadViteConfig();
    const key = "^/ws/terminal";
    expect(config.server?.proxy?.[key]).toBeDefined();
    const re = new RegExp(key);
    expect(re.test("/ws/terminal")).toBe(true);
    expect(re.test("/ws/terminal?agent=medical")).toBe(true); // req.url はクエリを含む
    expect(re.test("/ws.ts")).toBe(false);
  });
});

// dev(5173 別オリジン)→prod(4317 同一オリジン)の二経路が壊れずに成立するのは、
// api.ts の Origin/Host 許可がポートを無視しホスト名のみで判定するため。ここを
// :4317 固定に厳格化すると prod は動いたまま dev proxy 経由(:5173)だけ 403 で
// 沈黙破損する『片方だけ壊れる罠』になるため、その前提を回帰テストで固定する。
describe("dev proxy prerequisite: Origin/Host allowlist is port-independent (Issue #43)", () => {
  it("accepts the Vite dev origin/host on port 5173 (different from the 4317 backend)", () => {
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedHost("127.0.0.1:5173")).toBe(true);
  });

  it("still accepts the backend origin/host on port 4317", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4317")).toBe(true);
    expect(isAllowedHost("127.0.0.1:4317")).toBe(true);
  });
});

// Issue #175 の回帰本体。上のブロックはポートを注入して構造を見るため、
// 「default export が実際に FLYWHEEL_BOARD_PORT を読んでいるか」は担保しない。
// ここで結線そのものと、注入経路が環境変数から独立していることを固定する。
describe("dev proxy port resolution is env-driven but test-injectable (Issue #175)", () => {
  it("default export は呼び出し時点の FLYWHEEL_BOARD_PORT を反映する（遅延評価）", async () => {
    vi.stubEnv(BOARD_PORT_ENV_KEY, "4318");
    const config = await loadDefaultConfig();
    expect(config.server?.proxy?.["/api"]).toMatchObject({
      target: "http://127.0.0.1:4318",
    });
    expect(config.server?.proxy?.["^/ws$"]).toMatchObject({
      target: "ws://127.0.0.1:4318",
    });
    expect(config.server?.proxy?.["^/ws/terminal"]).toMatchObject({
      target: "ws://127.0.0.1:4318",
    });
  });

  it("default export は FLYWHEEL_BOARD_PORT 未設定なら既定ポートへ転送する", async () => {
    vi.stubEnv(BOARD_PORT_ENV_KEY, "");
    const config = await loadDefaultConfig();
    expect(config.server?.proxy?.["/api"]).toMatchObject({
      target: `http://127.0.0.1:${DEFAULT_PORT}`,
    });
  });

  // 同一モジュールを再 import しても env の変化が反映される＝モジュールスコープで
  // 固定されていないこと（Issue #175 の原因はまさにモジュールスコープ解決だった）。
  it("同一プロセス内で env を変えると転送先も変わる（モジュールスコープに固定されない）", async () => {
    vi.stubEnv(BOARD_PORT_ENV_KEY, "4318");
    const first = await loadDefaultConfig();
    vi.stubEnv(BOARD_PORT_ENV_KEY, "4322");
    const second = await loadDefaultConfig();
    expect(first.server?.proxy?.["/api"]).toMatchObject({
      target: "http://127.0.0.1:4318",
    });
    expect(second.server?.proxy?.["/api"]).toMatchObject({
      target: "http://127.0.0.1:4322",
    });
  });

  // 注入経路は実行環境の env に一切左右されない。この期待が壊れると、
  // FLYWHEEL_BOARD_PORT を設定している開発者だけがテスト赤になる状態へ逆戻りする。
  it("注入経路は実行環境の FLYWHEEL_BOARD_PORT を無視する", async () => {
    vi.stubEnv(BOARD_PORT_ENV_KEY, "4318");
    const config = await loadViteConfig(INJECTED_PORT);
    expect(config.server?.proxy?.["/api"]).toMatchObject({
      target: `http://127.0.0.1:${INJECTED_PORT}`,
    });
    expect(config.server?.host).toBe("127.0.0.1");
  });
});
