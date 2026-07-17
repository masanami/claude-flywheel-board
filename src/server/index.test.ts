import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { LISTEN_HOSTNAME, createApp, getServeOptions } from "./index.ts";

describe("getServeOptions", () => {
  it("常に 127.0.0.1 を hostname として返す", () => {
    const options = getServeOptions();

    expect(options.hostname).toBe("127.0.0.1");
    expect(LISTEN_HOSTNAME).toBe("127.0.0.1");
  });

  it("port を指定してもホストは 127.0.0.1 のまま変わらない", () => {
    const options = getServeOptions(0);

    expect(options.port).toBe(0);
    expect(options.hostname).toBe("127.0.0.1");
  });
});

describe("server smoke test", () => {
  let server: ReturnType<typeof serve> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("127.0.0.1 に実際に bind し、リクエストへ応答する", async () => {
    // port: 0 で OS に空きポートを割り当てさせ、実際に listen する。
    await new Promise<void>((resolve, reject) => {
      server = serve(getServeOptions(0), (info) => {
        expect(info.address).toBe("127.0.0.1");
        resolve();
      });
      server.on("error", reject);
    });

    const address = server?.address();
    if (!address || typeof address === "string") {
      throw new Error("server address が取得できない");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/does-not-exist`,
    );
    // 静的ファイルが無いので 404 だが、127.0.0.1 で応答が返ってくること自体を確認する。
    expect(response.status).toBe(404);
  });
});

describe("createApp", () => {
  it("Hono アプリを構築できる", () => {
    const app = createApp();
    expect(app.fetch).toBeTypeOf("function");
  });
});
