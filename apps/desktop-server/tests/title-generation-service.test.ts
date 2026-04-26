import { describe, expect, it, vi } from "vitest";
import {
  createOpenAiSessionTitleGenerator,
  sanitizeGeneratedTitle
} from "../src/title-generation-service.js";

describe("title generation service", () => {
  it("calls gpt-5.4-mini through the Responses API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "低功耗迷你主机调研"
              }
            ]
          }
        ]
      })
    });
    const generator = createOpenAiSessionTitleGenerator({
      apiKey: "test-key",
      fetch: fetchImpl as never
    });

    await expect(
      generator.generateTitle({
        content: "帮我调研低功耗迷你主机 CPU",
        attachments: []
      })
    ).resolves.toBe("低功耗迷你主机调研");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key"
        })
      })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string) as {
      model: string;
      input: Array<{ content: Array<{ text: string }> }>;
    };
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.input[1].content[0].text).toContain(
      "帮我调研低功耗迷你主机 CPU"
    );
  });

  it("sanitizes quoted labels and limits title length", () => {
    expect(
      sanitizeGeneratedTitle("标题：`这是一个非常非常非常非常非常非常非常长的标题`\nextra")
    ).toBe("这是一个非常非常非常非常非常非常非常长的标题");
  });

  it("does not call the API when no key is configured", async () => {
    const fetchImpl = vi.fn();
    const generator = createOpenAiSessionTitleGenerator({
      fetch: fetchImpl as never
    });

    await expect(
      generator.generateTitle({
        content: "hello",
        attachments: []
      })
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses lazily resolved Codex auth when no static key is configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: "借用 Codex Auth"
      })
    });
    const generator = createOpenAiSessionTitleGenerator({
      fetch: fetchImpl as never,
      resolveAuth: async () => ({
        apiKey: "codex-token",
        baseUrl: "https://codex.example.test/"
      })
    });

    await expect(
      generator.generateTitle({
        content: "用 Codex 的登录态总结标题",
        attachments: []
      })
    ).resolves.toBe("借用 Codex Auth");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://codex.example.test/v1/responses",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer codex-token"
        })
      })
    );
  });

  it("does not duplicate the responses API version segment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: "自定义代理标题"
      })
    });
    const generator = createOpenAiSessionTitleGenerator({
      fetch: fetchImpl as never,
      resolveAuth: async () => ({
        apiKey: "codex-token",
        baseUrl: "https://proxy.example.test/v1"
      })
    });

    await generator.generateTitle({
      content: "测试自定义代理 base_url",
      attachments: []
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://proxy.example.test/v1/responses",
      expect.anything()
    );
  });
});
