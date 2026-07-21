import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedHost, isAllowedOrigin } from "./api.ts";

// vite.config.ts（プロジェクトルート）の dev サーバ proxy 設定を検証する。
// Issue #43: UI(Vite:5173) と API/WS(Node:4317) が別オリジンのため、
// proxy が無いと初回スナップショットが届かず board が「読み込み中」のまま固まる。
// WS の proxy キーは正規表現でなければならない（`Board.tsx` が import する
// `/ws.ts` というソースモジュール配信パスまで巻き込んで 404 になる既知の落とし穴）。
const CONFIG_PATH = fileURLToPath(
  new URL("../../vite.config.ts", import.meta.url),
);

async function loadViteConfig() {
  const mod = await import(CONFIG_PATH);
  return mod.default as {
    server?: {
      host?: string;
      proxy?: Record<string, unknown>;
    };
  };
}

describe("vite dev server proxy config (Issue #43)", () => {
  it("keeps the existing 127.0.0.1 固定 host（NFR-03）", async () => {
    const config = await loadViteConfig();
    expect(config.server?.host).toBe("127.0.0.1");
  });

  it("proxies /api to the Node server (127.0.0.1:4317)", async () => {
    const config = await loadViteConfig();
    expect(config.server?.proxy?.["/api"]).toMatchObject({
      target: "http://127.0.0.1:4317",
      changeOrigin: true,
    });
  });

  it("proxies the /ws WebSocket endpoint via a regex key scoped to exactly /ws", async () => {
    const config = await loadViteConfig();
    expect(config.server?.proxy?.["^/ws$"]).toMatchObject({
      target: "ws://127.0.0.1:4317",
      ws: true,
    });
  });

  it("proxies the /ws/terminal WebSocket endpoint via a regex key", async () => {
    const config = await loadViteConfig();
    expect(config.server?.proxy?.["^/ws/terminal"]).toMatchObject({
      target: "ws://127.0.0.1:4317",
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
