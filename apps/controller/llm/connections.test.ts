import { afterEach, describe, expect, it, vi } from "vitest";
import { testLlmEndpoint } from "./connections";

afterEach(() => vi.unstubAllGlobals());

describe("testLlmEndpoint", () => {
  it("tests the selected OpenAI-compatible API and model", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testLlmEndpoint({
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret",
      api: "openai-completions",
      model: "gateway/model-a",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gateway/model-a",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      }),
    );
  });

  it("uses Anthropic authentication and the messages endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testLlmEndpoint({
      baseUrl: "https://api.anthropic.com",
      apiKey: "secret",
      api: "anthropic-messages",
      model: "claude-sonnet",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/messages",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "secret",
          "anthropic-version": "2023-06-01",
        },
      }),
    );
  });

  it("returns the provider error instead of reporting false success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{"error":"model not found"}', { status: 404 })),
    );

    await expect(
      testLlmEndpoint({
        baseUrl: "https://gateway.example/v1",
        apiKey: "secret",
        api: "openai-responses",
        model: "missing-model",
      }),
    ).rejects.toThrow('model endpoint returned 404: {"error":"model not found"}');
  });
});
