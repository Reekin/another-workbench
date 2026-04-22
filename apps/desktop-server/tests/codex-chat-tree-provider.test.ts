import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";
import { CodexChatTreeAgentProvider } from "../src/codex-chat-tree-provider.js";

describe("CodexChatTreeAgentProvider", () => {
  it("maps codex chat tree nodes into the shared snapshot shape", async () => {
    const provider = new CodexChatTreeAgentProvider({
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-1"),
        readChatTree: vi.fn().mockResolvedValue({
          threadId: "thread-1",
          chatTree: {
            currentNodeId: "node-2",
            nodes: [
              {
                nodeId: "node-1",
                parentNodeId: null,
                summary: "Start plan",
                turnId: "turn-1",
                order: 1
              },
              {
                nodeId: "node-2",
                parentNodeId: "node-1",
                summary: null,
                turnId: "turn-2",
                order: 2
              }
            ]
          }
        })
      } as unknown as CodexAppServerRuntimePort,
      now: () => "2026-04-18T00:10:01Z"
    });

    await expect(
      provider.get({
        sessionId: "session-codex",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).resolves.toEqual({
      sessionId: "session-codex",
      engineId: "codex",
      supportsJump: true,
      currentNodeId: "node-2",
      nodes: [
        {
          nodeId: "node-1",
          parentNodeId: undefined,
          label: "Start plan",
          turnId: "turn-1",
          order: 1,
          isCurrent: false
        },
        {
          nodeId: "node-2",
          parentNodeId: "node-1",
          label: "node-2",
          turnId: "turn-2",
          order: 2,
          isCurrent: true
        }
      ],
      fetchedAt: "2026-04-18T00:10:01Z"
    });
  });

  it("returns a non-jumpable snapshot when no chat tree is available", async () => {
    const provider = new CodexChatTreeAgentProvider({
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-1"),
        readChatTree: vi.fn().mockResolvedValue(undefined)
      } as unknown as CodexAppServerRuntimePort,
      now: () => "2026-04-18T00:10:02Z"
    });

    await expect(
      provider.get({
        sessionId: "session-codex",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never
      })
    ).resolves.toEqual({
      sessionId: "session-codex",
      engineId: "codex",
      supportsJump: false,
      nodes: [],
      fetchedAt: "2026-04-18T00:10:02Z"
    });
  });

  it("always jumps through the resolved thread id", async () => {
    const setCurrentChatTreeNode = vi.fn().mockResolvedValue(undefined);
    const getThreadIdForSession = vi
      .fn()
      .mockReturnValueOnce("thread-live")
      .mockReturnValueOnce(undefined);
    const provider = new CodexChatTreeAgentProvider({
      codexRuntimePort: {
        getThreadIdForSession,
        setCurrentChatTreeNode
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.jump(
        {
          sessionId: "session-codex",
          engineId: "codex",
          runtimeService: {} as never,
          sessionIndexStore: {} as never
        },
        "node-1"
      )
    ).resolves.toBe(true);

    await expect(
      provider.jump(
        {
          sessionId: "session-codex",
          engineId: "codex",
          runtimeService: {} as never,
          sessionIndexStore: {} as never,
          indexEntry: {
            sessionId: "session-codex",
            providerSessionId: "thread-indexed"
          } as never
        },
        "node-2"
      )
    ).resolves.toBe(true);

    expect(setCurrentChatTreeNode).toHaveBeenNthCalledWith(
      1,
      "thread-live",
      "node-1"
    );
    expect(setCurrentChatTreeNode).toHaveBeenNthCalledWith(
      2,
      "thread-indexed",
      "node-2"
    );
  });
});
