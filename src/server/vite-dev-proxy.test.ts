import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
