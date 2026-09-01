import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkbenchRuntimeService
} from "../src/prod-service.js";

const codexFixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url)
);
const piFixturePath = fileURLToPath(
  new URL("./fixtures/fake-pi-acp.mjs", import.meta.url)
);

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000
): Promise<void> => {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const readRequestLog = async (path: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("prod runtime service", () => {
  const disposers: Array<() => Promise<void>> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      if (dispose) {
        await dispose();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("reports the same configured program path used by the runtime", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "awb-program-resolution-"));
    tempDirs.push(baseDir);
    const service = createWorkbenchRuntimeService({
      codexCommandPath: "C:\\configured\\codex.exe",
      piAcpCommandPath: "C:\\configured\\pi-acp.cmd",
      persistenceBaseDir: baseDir
    });
    disposers.push(() => service.dispose());

    await expect(service.getSettings()).resolves.toMatchObject({
      engineProgramResolutionsByEngineId: {
        codex: {
          path: "C:\\configured\\codex.exe",
          source: "configured"
        },
        "pi-acp": {
          path: "C:\\configured\\pi-acp.cmd",
          source: "configured"
        }
      }
    });

    await service.updateSettings({
      engineProgramPathsByEngineId: {
        codex: "C:\\custom\\codex.exe"
      }
    });
    await expect(service.getSettings()).resolves.toMatchObject({
      engineProgramResolutionsByEngineId: {
        codex: {
          path: "C:\\custom\\codex.exe",
          source: "custom"
        }
      }
    });
  });

  it("uses the real Codex runtime composition instead of demo placeholder text", async () => {
    const service = createWorkbenchRuntimeService({
      codexCommandPath: process.execPath,
      codexCommandArgs: [codexFixturePath],
      piAcpCommandPath: process.execPath,
      piAcpCommandArgs: [piFixturePath]
    });
    disposers.push(() => service.dispose());

    await service.executeCommand({
      commandId: "create-codex-session",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-prod"
      }
    });

    const sessionId = service.listSessions({
      conversationId: "conversation-prod",
      includeArchived: true
    })[0]?.sessionId;

    expect(sessionId).toBeDefined();

    const deltas: string[] = [];
    service.subscribe((envelope) => {
      if (envelope.event.type === "message.delta") {
        deltas.push(envelope.event.delta);
      }
      if (envelope.event.type === "terminal.output") {
        deltas.push(envelope.event.chunk);
      }
    }, {
      conversationId: "conversation-prod"
    });

    await service.executeCommand({
      commandId: "send-codex",
      command: {
        type: "sendUserMessage",
        sessionId: sessionId!,
        messageId: "msg-1",
        content: "hello real codex",
        attachments: []
      }
    });

    await waitFor(() =>
      service.getSnapshot().messageBlocks.some((block) =>
        block.sessionId === sessionId &&
        block.role === "assistant" &&
        block.text.includes("Real Codex says: hello real codex")
      )
    );

    const snapshot = service.getSnapshot();
    const joinedText = deltas.join("");

    expect(joinedText).toContain("Real Codex says: hello real codex");
    expect(joinedText).not.toContain("Codex response");
    expect(
      snapshot.messageBlocks.some((block) =>
        block.messageId === "msg-1" && block.role === "user" && block.text.includes("hello real codex")
      )
    ).toBe(true);
    expect(snapshot.messageBlocks.some((block) =>
      block.text.includes("Real Codex says: hello real codex")
    )).toBe(true);
    expect(snapshot.toolCalls.some((toolCall) =>
      toolCall.toolName === "commandExecution"
    )).toBe(true);
    expect(snapshot.terminalStreams.some((stream) =>
      stream.outputText.includes("D:/workspace")
    )).toBe(true);
  });

  it("borrows Codex auth for first-message title generation", async () => {
    const previousFakeToken = process.env.FAKE_CODEX_AUTH_TOKEN;
    const previousFakeBaseUrl = process.env.FAKE_CODEX_AUTH_BASE_URL;
    process.env.FAKE_CODEX_AUTH_TOKEN = "codex-borrowed-token";
    process.env.FAKE_CODEX_AUTH_BASE_URL = "https://codex-auth.example.test/v1";

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: "Codex borrowed title"
      })
    });
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const service = createWorkbenchRuntimeService({
        codexCommandPath: process.execPath,
        codexCommandArgs: [codexFixturePath],
        piAcpCommandPath: process.execPath,
        piAcpCommandArgs: [piFixturePath]
      });
      disposers.push(() => service.dispose());

      await service.executeCommand({
        commandId: "create-codex-title-session",
        command: {
          type: "createSession",
          engineId: "codex",
          conversationId: "conversation-title"
        }
      });

      const sessionId = service.listSessions({
        conversationId: "conversation-title",
        includeArchived: true
      })[0]?.sessionId;

      expect(sessionId).toBeDefined();

      await service.executeCommand({
        commandId: "send-codex-title",
        command: {
          type: "sendUserMessage",
          sessionId: sessionId!,
          messageId: "msg-title-1",
          content: "帮我调研低功耗迷你主机 CPU",
          attachments: []
        }
      });

      await waitFor(() =>
        service.getSnapshot().sessions.some((session) =>
          session.sessionId === sessionId && session.title === "Codex borrowed title"
        )
      );

      expect(fetchImpl).toHaveBeenCalledWith(
        "https://codex-auth.example.test/v1/responses",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer codex-borrowed-token"
          })
        })
      );
    } finally {
      if (previousFakeToken === undefined) {
        delete process.env.FAKE_CODEX_AUTH_TOKEN;
      } else {
        process.env.FAKE_CODEX_AUTH_TOKEN = previousFakeToken;
      }
      if (previousFakeBaseUrl === undefined) {
        delete process.env.FAKE_CODEX_AUTH_BASE_URL;
      } else {
        process.env.FAKE_CODEX_AUTH_BASE_URL = previousFakeBaseUrl;
      }
    }
  });

  it("registers read_session as a Codex dynamic host tool", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "awb-read-session-prod-"));
    tempDirs.push(tempDir);
    const requestLogPath = join(tempDir, "requests.jsonl");
    vi.stubEnv("FAKE_CODEX_REQUEST_LOG", requestLogPath);
    const service = createWorkbenchRuntimeService({
      codexCommandPath: process.execPath,
      codexCommandArgs: [codexFixturePath],
      piAcpCommandPath: process.execPath,
      piAcpCommandArgs: [piFixturePath]
    });
    disposers.push(() => service.dispose());

    await service.executeCommand({
      commandId: "create-read-session-tool-session",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-read-session-tool"
      }
    });

    const sessionId = service.listSessions({
      conversationId: "conversation-read-session-tool",
      includeArchived: true
    })[0]?.sessionId;
    expect(sessionId).toBeDefined();

    await service.executeCommand({
      commandId: "send-read-session-tool",
      command: {
        type: "sendUserMessage",
        sessionId: sessionId!,
        messageId: "msg-read-session-tool",
        content: "hello dynamic tools",
        attachments: []
      }
    });

    await waitFor(async () => {
      try {
        const requests = await readRequestLog(requestLogPath);
        return requests.some((request) => request.method === "thread/start");
      } catch {
        return false;
      }
    });

    const threadStart = (await readRequestLog(requestLogPath)).find(
      (request) => request.method === "thread/start"
    );
    expect(threadStart?.params).toEqual(
      expect.objectContaining({
        dynamicTools: expect.arrayContaining([
          expect.objectContaining({
            namespace: "another_workbench",
            name: "read_session",
            inputSchema: expect.objectContaining({
              properties: expect.objectContaining({
                sessionId: expect.objectContaining({
                  minLength: 1
                }),
                limit: expect.objectContaining({
                  default: 50,
                  maximum: 200
                }),
                maxChars: expect.objectContaining({
                  default: 60000,
                  maximum: 200000
                })
              }),
              required: ["sessionId"]
            })
          })
        ])
      })
    );
  });

  it("exposes pi-acp as a real ACP-backed agent with streamed transcript and tool output", async () => {
    const service = createWorkbenchRuntimeService({
      codexCommandPath: process.execPath,
      codexCommandArgs: [codexFixturePath],
      piAcpCommandPath: process.execPath,
      piAcpCommandArgs: [piFixturePath]
    });
    disposers.push(() => service.dispose());

    expect(service.listEngines().some((engine) => engine.engineId === "pi-acp")).toBe(true);

    await service.executeCommand({
      commandId: "create-pi-session",
      command: {
        type: "createSession",
        engineId: "pi-acp",
        conversationId: "conversation-pi"
      }
    });

    const sessionId = service.listSessions({
      conversationId: "conversation-pi",
      includeArchived: true
    })[0]?.sessionId;

    expect(sessionId).toBeDefined();

    const deltas: string[] = [];
    service.subscribe((envelope) => {
      if (envelope.event.type === "message.delta") {
        deltas.push(envelope.event.delta);
      }
      if (envelope.event.type === "tool.delta") {
        deltas.push(envelope.event.delta);
      }
    }, {
      conversationId: "conversation-pi"
    });

    await service.executeCommand({
      commandId: "send-pi",
      command: {
        type: "sendUserMessage",
        sessionId: sessionId!,
        messageId: "msg-pi-1",
        content: "hello pi agent",
        attachments: []
      }
    });

    await waitFor(() =>
      service.getSnapshot().turns.some((turn) =>
        turn.sessionId === sessionId && turn.status === "completed"
      )
    );

    const snapshot = service.getSnapshot();
    const joinedText = deltas.join("");
    const sessionBlocks = snapshot.messageBlocks.filter((block) =>
      block.sessionId === sessionId
    );
    const sessionBlockTexts = sessionBlocks.map((block) => block.text);

    expect(joinedText).toContain("Pi ACP says: hello pi agent");
    expect(sessionBlocks.length).toBeGreaterThanOrEqual(3);
    expect(
      sessionBlockTexts.some((text) => text.includes("hello pi agent"))
    ).toBe(true);
    expect(sessionBlockTexts.some((text) => text.includes("## Skills"))).toBe(true);
    expect(
      sessionBlockTexts.some((text) => text.includes("Pi ACP says: hello pi agent"))
    ).toBe(true);
    expect(snapshot.toolCalls.some((toolCall) =>
      toolCall.sessionId === sessionId &&
      toolCall.toolName === "Execute shell command" &&
      toolCall.outputSummary?.includes("D:/workspace")
    )).toBe(true);
  });
});
