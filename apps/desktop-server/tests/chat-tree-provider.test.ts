import type { ChatSession } from "@another-workbench/shared";
import { describe, expect, it, vi } from "vitest";
import { ChatTreeProvider } from "../src/chat-tree-provider.js";
import type { CodexAppServerRuntimePort } from "../src/codex-app-server-runtime-port.js";
import type { WorkbenchRuntimeService } from "../src/runtime-service.js";

const createSession = (input: {
  sessionId: string;
  agentId: string;
}): ChatSession => ({
  sessionId: input.sessionId,
  conversationId: "conversation-1",
  agentId: input.agentId,
  status: "idle",
  title: input.sessionId,
  createdAt: "2026-04-18T00:00:01Z",
  updatedAt: "2026-04-18T00:00:01Z"
});

describe("ChatTreeProvider", () => {
  it("throws for unknown sessions", async () => {
    const provider = new ChatTreeProvider({
      runtimeService: {
        listSessions: vi.fn().mockReturnValue([])
      } as unknown as WorkbenchRuntimeService,
      codexRuntimePort: {
        getThreadIdForSession: vi.fn(),
        readChatTree: vi.fn(),
        setCurrentChatTreeNode: vi.fn(),
        setCurrentChatTreeNodeForSession: vi.fn()
      } as unknown as CodexAppServerRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never
    });

    await expect(provider.get("session-missing")).rejects.toThrow(
      "Unknown session: session-missing"
    );
    await expect(provider.jump("session-missing", "node-1")).rejects.toThrow(
      "Unknown session: session-missing"
    );
  });

  it("returns a non-jumpable empty snapshot for non-codex sessions", async () => {
    const readChatTreeForSession = vi.fn();
    const setCurrentChatTreeNodeForSession = vi.fn();
    const provider = new ChatTreeProvider({
      runtimeService: {
        listSessions: vi.fn().mockReturnValue([
          createSession({
            sessionId: "session-acp",
            agentId: "acp"
          })
        ])
      } as unknown as WorkbenchRuntimeService,
      codexRuntimePort: {
        getThreadIdForSession: vi.fn(),
        readChatTree: readChatTreeForSession,
        setCurrentChatTreeNodeForSession
      } as unknown as CodexAppServerRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never,
      now: () => "2026-04-18T00:10:00Z"
    });

    await expect(provider.get("session-acp")).resolves.toEqual({
      sessionId: "session-acp",
      agentId: "acp",
      supportsJump: false,
      nodes: [],
      fetchedAt: "2026-04-18T00:10:00Z"
    });
    await expect(provider.jump("session-acp", "node-1")).resolves.toEqual({
      jumped: false
    });
    expect(readChatTreeForSession).not.toHaveBeenCalled();
    expect(setCurrentChatTreeNodeForSession).not.toHaveBeenCalled();
  });

  it("maps codex chat tree nodes and delegates node jumps", async () => {
    const getThreadIdForSession = vi.fn().mockReturnValue("thread-1");
    const readChatTree = vi.fn().mockResolvedValue({
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
    });
    const setCurrentChatTreeNodeForSession = vi.fn().mockResolvedValue(true);
    const provider = new ChatTreeProvider({
      runtimeService: {
        listSessions: vi.fn().mockReturnValue([
          createSession({
            sessionId: "session-codex",
            agentId: "codex"
          })
        ])
      } as unknown as WorkbenchRuntimeService,
      codexRuntimePort: {
        getThreadIdForSession,
        readChatTree,
        setCurrentChatTreeNodeForSession
      } as unknown as CodexAppServerRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never,
      now: () => "2026-04-18T00:10:01Z"
    });

    const snapshot = await provider.get("session-codex");
    expect(snapshot).toEqual({
      sessionId: "session-codex",
      agentId: "codex",
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

    await expect(provider.jump("session-codex", "node-1")).resolves.toEqual({
      jumped: true
    });
    expect(setCurrentChatTreeNodeForSession).toHaveBeenCalledWith(
      "session-codex",
      "node-1"
    );
  });

  it("returns non-jumpable snapshots when a codex session has no chat tree", async () => {
    const provider = new ChatTreeProvider({
      runtimeService: {
        listSessions: vi.fn().mockReturnValue([
          createSession({
            sessionId: "session-codex",
            agentId: "codex"
          })
        ])
      } as unknown as WorkbenchRuntimeService,
      codexRuntimePort: {
        getThreadIdForSession: vi.fn().mockReturnValue("thread-1"),
        readChatTree: vi.fn().mockResolvedValue(undefined),
        setCurrentChatTreeNodeForSession: vi.fn()
      } as unknown as CodexAppServerRuntimePort,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never,
      now: () => "2026-04-18T00:10:02Z"
    });

    await expect(provider.get("session-codex")).resolves.toEqual({
      sessionId: "session-codex",
      agentId: "codex",
      supportsJump: false,
      nodes: [],
      fetchedAt: "2026-04-18T00:10:02Z"
    });
  });
});
