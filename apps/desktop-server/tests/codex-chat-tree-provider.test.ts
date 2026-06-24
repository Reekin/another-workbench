import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";
import { CodexChatTreeAgentProvider } from "../src/codex-chat-tree-provider.js";

describe("CodexChatTreeAgentProvider", () => {
  it("maps codex chat tree nodes into the shared snapshot shape", async () => {
    const provider = new CodexChatTreeAgentProvider({
      codexRuntimePort: {
        readChatTree: vi.fn().mockResolvedValue({
          threadId: "thread-1",
          chatTree: {
            version: 1,
            revision: 7,
            currentNodeId: "node-2",
            visibleNodeIds: ["node-1", "node-2"],
            visibleTurnIds: ["turn-1", "turn-2"],
            nodes: [
              {
                nodeId: "node-1",
                parentNodeId: null,
                turnId: "turn-1",
                order: 1,
                status: "completed",
                summary: "Start plan"
              },
              {
                nodeId: "node-2",
                parentNodeId: "node-1",
                turnId: "turn-2",
                order: 2,
                status: "pending",
                summary: null
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
        sessionIndexStore: {} as never,
        providerHandle: {
          providerKind: "codex-thread",
          providerSessionId: "thread-1"
        }
      })
    ).resolves.toEqual({
      sessionId: "session-codex",
      engineId: "codex",
      supportsJump: true,
      version: 1,
      revision: 7,
      currentNodeId: "node-2",
      visibleNodeIds: ["node-1", "node-2"],
      visibleTurnIds: ["turn-1", "turn-2"],
      nodes: [
        {
          nodeId: "node-1",
          parentNodeId: undefined,
          label: "Start plan",
          summary: "Start plan",
          turnId: "turn-1",
          order: 1,
          isCurrent: false,
          status: "completed"
        },
        {
          nodeId: "node-2",
          parentNodeId: "node-1",
          label: "node-2",
          turnId: "turn-2",
          order: 2,
          isCurrent: true,
          status: "pending"
        }
      ],
      fetchedAt: "2026-04-18T00:10:01Z"
    });
  });

  it("returns a non-jumpable snapshot when no chat tree is available", async () => {
    const provider = new CodexChatTreeAgentProvider({
      codexRuntimePort: {
        readChatTree: vi.fn().mockResolvedValue(undefined)
      } as unknown as CodexAppServerRuntimePort,
      now: () => "2026-04-18T00:10:02Z"
    });

    await expect(
      provider.get({
        sessionId: "session-codex",
        engineId: "codex",
        runtimeService: {} as never,
        sessionIndexStore: {} as never,
        providerHandle: {
          providerKind: "codex-thread",
          providerSessionId: "thread-1"
        }
      })
    ).resolves.toEqual({
      sessionId: "session-codex",
      engineId: "codex",
      supportsJump: false,
      nodes: [],
      fetchedAt: "2026-04-18T00:10:02Z"
    });
  });

  it("jumps through canonical provider thread ids only", async () => {
    const setCurrentChatTreeNode = vi.fn().mockResolvedValue(undefined);
    const provider = new CodexChatTreeAgentProvider({
      codexRuntimePort: {
        setCurrentChatTreeNode
      } as unknown as CodexAppServerRuntimePort
    });

    await expect(
      provider.jump(
        {
          sessionId: "session-codex",
          engineId: "codex",
          runtimeService: {} as never,
          sessionIndexStore: {} as never,
          providerHandle: {
            providerKind: "codex-thread",
            providerSessionId: "thread-handle"
          }
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
        "node-2",
        7
      )
    ).resolves.toBe(false);

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
        "node-3",
        8
      )
    ).resolves.toBe(false);

    expect(setCurrentChatTreeNode).toHaveBeenNthCalledWith(
      1,
      "thread-handle",
      "node-1",
      undefined
    );
    expect(setCurrentChatTreeNode).toHaveBeenCalledTimes(1);
  });
});
