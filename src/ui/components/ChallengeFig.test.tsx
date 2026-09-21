import { render, screen, waitFor } from "@testing-library/react";
import mermaid from "mermaid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChallengeFig } from "./ChallengeFig.tsx";

// mermaid は実際に図をレンダリングすると重く jsdom 依存の懸念もあるため、
// PreviewPanel.test.tsx と同じ方針で mermaid 自体をモックし、「render に渡り、
// 戻り値（信頼済み SVG 文字列）が描画コンテナへ反映される」という結線だけを見る。
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

function stubFetch(
  response: (url: string) => Partial<Response> | Promise<Partial<Response>>,
) {
  const fetchMock = vi.fn((url: string) => Promise.resolve(response(url)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function figResponse(source: string): Partial<Response> {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ source }),
  };
}

const NOT_FOUND: Partial<Response> = {
  ok: false,
  status: 404,
  json: () => Promise.resolve({ error: "図が見つかりません" }),
};

beforeEach(() => {
  vi.mocked(mermaid.render).mockReset();
  vi.mocked(mermaid.initialize).mockReset();
  vi.mocked(mermaid.render).mockResolvedValue({
    svg: '<svg data-testid="mock-fig-svg"></svg>',
    // biome-ignore lint/suspicious/noExplicitAny: mermaid の RenderResult 型に合わせた最小スタブ
  } as any);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChallengeFig（Issue #180・FR-14）", () => {
  it("マウント時に GET /api/fig?agent=<agentName>&challenge=<id> を呼び出す", () => {
    const fetchMock = stubFetch(() => NOT_FOUND);

    render(<ChallengeFig agentName="bi" challengeId="C-007" />);

    expect(fetchMock).toHaveBeenCalledWith("/api/fig?agent=bi&challenge=C-007");
  });

  it("figs/<課題ID>.mmd がある課題では mermaid が strict で描画され、図が表示される", async () => {
    stubFetch(() => figResponse("flowchart LR\n  A --> B\n"));

    render(<ChallengeFig agentName="medical" challengeId="C-001" />);

    expect(await screen.findByTestId("mock-fig-svg")).toBeInTheDocument();
    expect(screen.getByTestId("card-detail-fig")).toBeInTheDocument();
    expect(screen.getByText("図")).toBeInTheDocument();
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict" }),
    );
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.any(String),
      "flowchart LR\n  A --> B\n",
      expect.anything(),
    );
  });

  it("図が無い課題（404）では何も描画せず、mermaid も呼ばない", async () => {
    stubFetch(() => NOT_FOUND);

    const { container } = render(
      <ChallengeFig agentName="medical" challengeId="C-002" />,
    );

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
    expect(screen.queryByTestId("card-detail-fig")).not.toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("取得が失敗（ネットワーク断）しても何も描画しない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    const { container } = render(
      <ChallengeFig agentName="medical" challengeId="C-003" />,
    );

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it("空のソースは図なしとして扱う（空の図枠を出さない）", async () => {
    stubFetch(() => figResponse("   \n"));

    const { container } = render(
      <ChallengeFig agentName="medical" challengeId="C-004" />,
    );

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("mermaid の描画に失敗した場合は図の領域ごと畳む（エラー表示を出さない）", async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error("parse error"));
    stubFetch(() => figResponse("not a valid diagram"));

    const { container } = render(
      <ChallengeFig agentName="medical" challengeId="C-005" />,
    );

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
    expect(
      screen.queryByText("mermaid 図の描画に失敗しました"),
    ).not.toBeInTheDocument();
  });
});
