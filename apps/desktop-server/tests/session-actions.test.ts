import type { ChatSession } from "@another-workbench/shared";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchRuntimeService } from "../src/runtime-service.js";
import { SessionActionsProvider } from "../src/session-actions.js";

const createSession = (input: {
  sessionId: string;
  engineId: string;
  archivedAt?: string;
}): ChatSession => ({
  sessionId: input.sessionId,
  conversationId: "conversation-1",
  engineId: input.engineId,
  status: "idle",
  title: input.sessionId,
  createdAt: "2026-04-18T00:00:01Z",
  updatedAt: "2026-04-18T00:00:01Z",
  archivedAt: input.archivedAt
});

describe("SessionActionsProvider", () => {
  it("lists base actions for known sessions and only copy for unknown sessions", async () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        createSession({
          sessionId: "session-1",
          engineId: "pi-acp",
          archivedAt: "2026-04-18T00:01:00Z"
        })
      ])
    } as unknown as WorkbenchRuntimeService;
    const provider = new SessionActionsProvider({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never
    });

    await expect(provider.listActions("session-missing")).resolves.toEqual([
      {
        action: "copy_session_id",
        label: "Copy session id"
      }
    ]);

    await expect(provider.listActions("session-1")).resolves.toEqual([
      {
        action: "copy_session_id",
        label: "Copy session id"
      },
      {
        action: "archive",
        label: "Archive",
        disabled: true,
        reason: "Session is already archived."
      },
      {
        action: "reload",
        label: "Reload"
      }
    ]);
  });

  it("delegates provider-specific action contribution and provider-native session id copying", async () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        createSession({
          sessionId: "session-1",
          engineId: "custom"
        })
      ])
    } as unknown as WorkbenchRuntimeService;
    const provider = new SessionActionsProvider({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never,
      providers: [
        {
          engineId: "custom",
          resolveDisplayedSessionId: () => "provider-session-1",
          listAdditionalActions: async () => [
            {
              action: "open_rollout",
              label: "Open rollout"
            }
          ]
        }
      ]
    });

    await expect(provider.listActions("session-1")).resolves.toEqual([
      {
        action: "copy_session_id",
        label: "Copy session id"
      },
      {
        action: "archive",
        label: "Archive",
        disabled: false,
        reason: undefined
      },
      {
        action: "reload",
        label: "Reload"
      },
      {
        action: "open_rollout",
        label: "Open rollout"
      }
    ]);

    await expect(provider.runAction("session-1", "copy_session_id")).resolves.toEqual({
      action: "copy_session_id",
      copiedText: "provider-session-1"
    });
  });

  it("runs common archive/reload behavior while allowing providers to hook archive preparation", async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      commandId: "ignored",
      commandType: "listSessions",
      accepted: true
    });
    const prepareArchive = vi.fn().mockResolvedValue(undefined);
    const archiveSessions = vi.fn().mockResolvedValue(undefined);
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        createSession({
          sessionId: "session-1",
          engineId: "custom"
        })
      ]),
      executeCommand
    } as unknown as WorkbenchRuntimeService;
    const provider = new SessionActionsProvider({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn((sessionId: string) =>
          sessionId === "session-indexed"
            ? {
                sessionId,
                engineId: "custom",
                providerSessionId: "provider-session-1",
                workspaceId: "workspace-1"
              }
            : undefined
        ),
        archiveSession: vi.fn().mockResolvedValue(undefined),
        archiveSessions,
        listEntriesByProviderSessionId: vi.fn().mockReturnValue([
          {
            sessionId: "session-indexed",
            providerSessionId: "provider-session-1"
          },
          {
            sessionId: "session-1",
            providerSessionId: "provider-session-1"
          }
        ])
      } as never,
      providers: [
        {
          engineId: "custom",
          prepareArchive
        }
      ]
    });

    await expect(provider.runAction("session-1", "archive")).resolves.toEqual({
      action: "archive",
      archived: true
    });
    await expect(provider.runAction("session-1", "reload")).resolves.toEqual({
      action: "reload",
      resumed: true
    });
    await expect(provider.runAction("session-indexed", "archive")).resolves.toEqual({
      action: "archive",
      archived: true
    });
    await expect(provider.runAction("session-indexed", "reload")).resolves.toEqual({
      action: "reload",
      resumed: true
    });

    expect(prepareArchive).toHaveBeenCalledTimes(2);
    expect(archiveSessions).toHaveBeenCalledWith(["session-indexed", "session-1"]);
    expect(executeCommand).toHaveBeenNthCalledWith(1, {
      commandId: "archive-session-1",
      command: {
        type: "archiveSession",
        sessionId: "session-1"
      }
    });
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      commandId: "resume-session-1",
      command: {
        type: "resumeSession",
        sessionId: "session-1"
      }
    });
  });

  it("delegates provider-owned actions and rejects unsupported ones", async () => {
    const runtimeService = {
      listSessions: vi.fn().mockReturnValue([
        createSession({
          sessionId: "session-1",
          engineId: "custom"
        })
      ])
    } as unknown as WorkbenchRuntimeService;
    const provider = new SessionActionsProvider({
      runtimeService,
      sessionIndexStore: {
        getEntry: vi.fn().mockReturnValue(undefined)
      } as never,
      providers: [
        {
          engineId: "custom",
          runAction: async ({ action }) =>
            action === "open_rollout"
              ? {
                  action: "open_rollout",
                  rolloutPath: "I:/rollouts/thread-1.md",
                  rolloutDisplayPath: "I:\\rollouts\\thread-1.md",
                  rolloutFileUrl: "file:///I:/rollouts/thread-1.md"
                }
              : undefined
        }
      ]
    });

    await expect(provider.runAction("session-1", "open_rollout")).resolves.toEqual({
      action: "open_rollout",
      rolloutPath: "I:/rollouts/thread-1.md",
      rolloutDisplayPath: "I:\\rollouts\\thread-1.md",
      rolloutFileUrl: "file:///I:/rollouts/thread-1.md"
    });
    await expect(provider.runAction("session-missing", "archive")).rejects.toThrow(
      "Unknown session: session-missing"
    );
  });
});
