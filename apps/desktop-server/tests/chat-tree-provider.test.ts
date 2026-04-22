import type { ChatSession } from "@another-workbench/shared";
import { describe, expect, it, vi } from "vitest";
import { ChatTreeProvider } from "../src/chat-tree-provider.js";
import type { WorkbenchRuntimeService } from "../src/runtime-service.js";

const createSession = (input: {
  sessionId: string;
  engineId: string;
}): ChatSession => ({
  sessionId: input.sessionId,
  conversationId: "conversation-1",
  engineId: input.engineId,
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

  it("returns a non-jumpable snapshot for agents without a registered provider", async () => {
    const provider = new ChatTreeProvider({
      runtimeService: {
        listSessions: vi.fn().mockReturnValue([
          createSession({
            sessionId: "session-acp",
            engineId: "acp"
          })
        ])
      } as unknown as WorkbenchRuntimeService,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never,
      now: () => "2026-04-18T00:10:00Z"
    });

    await expect(provider.get("session-acp")).resolves.toEqual({
      sessionId: "session-acp",
      engineId: "acp",
      supportsJump: false,
      nodes: [],
      fetchedAt: "2026-04-18T00:10:00Z"
    });
    await expect(provider.jump("session-acp", "node-1")).resolves.toEqual({
      jumped: false
    });
  });

  it("delegates chat tree reads and jumps to the matching agent provider", async () => {
    const get = vi.fn().mockResolvedValue({
      sessionId: "session-custom",
      engineId: "custom",
      supportsJump: true,
      currentNodeId: "node-1",
      nodes: [
        {
          nodeId: "node-1",
          label: "Node 1",
          order: 1,
          isCurrent: true
        }
      ],
      fetchedAt: "2026-04-18T00:10:01Z"
    });
    const jump = vi.fn().mockResolvedValue(true);
    const provider = new ChatTreeProvider({
      runtimeService: {
        listSessions: vi.fn().mockReturnValue([
          createSession({
            sessionId: "session-custom",
            engineId: "custom"
          })
        ])
      } as unknown as WorkbenchRuntimeService,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never,
      providers: [
        {
          engineId: "custom",
          get,
          jump
        }
      ]
    });

    await expect(provider.get("session-custom")).resolves.toEqual({
      sessionId: "session-custom",
      engineId: "custom",
      supportsJump: true,
      currentNodeId: "node-1",
      nodes: [
        {
          nodeId: "node-1",
          label: "Node 1",
          order: 1,
          isCurrent: true
        }
      ],
      fetchedAt: "2026-04-18T00:10:01Z"
    });
    await expect(provider.jump("session-custom", "node-2")).resolves.toEqual({
      jumped: true
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(jump).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-custom",
        engineId: "custom"
      }),
      "node-2"
    );
  });
});
