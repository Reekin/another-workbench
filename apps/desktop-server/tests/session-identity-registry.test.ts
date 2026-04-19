import { describe, expect, it, vi } from "vitest";
import { SessionIdentityRegistry } from "../src/session-identity-registry.js";
import type { WorkbenchRuntimeService } from "../src/runtime-service.js";

describe("SessionIdentityRegistry", () => {
  it("prefers runtime provider handles and falls back to indexed identity", () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        {
          sessionId: "session-runtime",
          conversationId: "conversation-1",
          agentId: "codex",
          status: "idle",
          title: "Runtime session",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z"
        }
      ]),
      resolveProviderSessionHandle: vi.fn((sessionId: string) =>
        sessionId === "session-runtime"
          ? {
              providerKind: "codex-thread",
              providerSessionId: "thread-runtime"
            }
          : undefined
      )
    } as unknown as WorkbenchRuntimeService;
    const registry = new SessionIdentityRegistry({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn((sessionId: string) =>
          sessionId === "session-indexed"
            ? {
                sessionId,
                workspaceId: "workspace-1",
                conversationId: "conversation-1",
                agentId: "codex",
                providerKind: "codex-thread",
                providerSessionId: "thread-indexed",
                createdAt: "2026-04-20T00:00:00.000Z",
                updatedAt: "2026-04-20T00:00:00.000Z",
                source: "reconciled"
              }
            : undefined
        ),
        listEntries: vi.fn().mockReturnValue([
          {
            sessionId: "session-indexed",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            agentId: "codex",
            providerKind: "codex-thread",
            providerSessionId: "thread-indexed",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
            source: "reconciled"
          }
        ])
      } as never
    });

    expect(registry.getProviderHandle("session-runtime")).toEqual({
      providerKind: "codex-thread",
      providerSessionId: "thread-runtime"
    });
    expect(registry.getProviderHandle("session-indexed")).toEqual({
      providerKind: "codex-thread",
      providerSessionId: "thread-indexed"
    });
  });

  it("resolves workbench aliases by provider handle across indexed and runtime sessions", () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        {
          sessionId: "session-runtime",
          conversationId: "conversation-1",
          agentId: "codex",
          status: "idle",
          title: "Runtime session",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          metadata: {
            providerKind: "codex-thread",
            providerSessionId: "thread-shared"
          }
        }
      ])
    } as unknown as WorkbenchRuntimeService;
    const registry = new SessionIdentityRegistry({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined),
        listEntries: vi.fn().mockReturnValue([
          {
            sessionId: "session-indexed",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            agentId: "codex",
            providerKind: "codex-thread",
            providerSessionId: "thread-shared",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
            source: "reconciled"
          }
        ])
      } as never
    });

    expect(
      registry.listSessionIdsByProviderHandle({
        providerKind: "codex-thread",
        providerSessionId: "thread-shared"
      })
    ).toEqual(["session-indexed", "session-runtime"]);
    expect(
      registry.resolveWorkbenchSessionId({
        providerKind: "codex-thread",
        providerSessionId: "thread-shared"
      })
    ).toBe("session-indexed");
  });
});
