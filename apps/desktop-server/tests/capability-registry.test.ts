import { describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "../src/capability-registry.js";
import { SessionIdentityRegistry } from "../src/session-identity-registry.js";
import type { WorkbenchRuntimeService } from "../src/runtime-service.js";

const createRuntimeService = () =>
  ({
    listSessions: vi.fn().mockReturnValue([
      {
        sessionId: "session-codex",
        conversationId: "conversation-1",
        engineId: "codex",
        status: "idle",
        title: "Codex session",
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z"
      },
      {
        sessionId: "session-pi",
        conversationId: "conversation-2",
        engineId: "pi-acp",
        status: "idle",
        title: "Pi session",
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z"
      }
    ]),
    executeCommand: vi.fn().mockResolvedValue({
      commandId: "ignored",
      commandType: "resumeSession",
      accepted: true
    }),
    resolveProviderSessionHandle: vi.fn((sessionId: string) =>
      sessionId === "session-codex"
        ? {
            providerKind: "codex-thread",
            providerSessionId: "thread-1"
          }
        : undefined
    )
  }) as unknown as WorkbenchRuntimeService;

describe("CapabilityRegistry", () => {
  it("returns unsupported snapshots for agents without optional capabilities", async () => {
    const runtimeService = createRuntimeService();
    const sessionIndexStore = {
      getEntry: vi.fn().mockImplementation((sessionId: string) => ({
        sessionId,
        workspaceId: "workspace-1",
        conversationId: `conversation-for-${sessionId}`,
        engineId: sessionId === "session-pi" ? "pi-acp" : "codex",
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        source: "registry"
      })),
      listEntries: vi.fn().mockReturnValue([])
    } as never;
    const sessionIdentity = new SessionIdentityRegistry({
      runtimeService,
      sessionIndexStore
    });
    const registry = new CapabilityRegistry({
      runtimeService,
      sessionIndexStore,
      sessionIdentity,
      capabilities: [
        {
          engineId: "codex"
        },
        {
          engineId: "pi-acp"
        }
      ],
      now: () => "2026-04-20T00:10:00.000Z"
    });

    await expect(registry.getConversationGraph("session-pi")).resolves.toEqual({
      sessionId: "session-pi",
      engineId: "pi-acp",
      supportsJump: false,
      nodes: [],
      fetchedAt: "2026-04-20T00:10:00.000Z"
    });
    await expect(registry.getDelegation("session-pi")).resolves.toEqual({
      sessionId: "session-pi",
      engineId: "pi-acp",
      supported: false,
      supportsControl: false,
      nodes: [],
      edges: [],
      fetchedAt: "2026-04-20T00:10:00.000Z"
    });
    await expect(registry.getWorktree("session-pi")).resolves.toEqual({
      sessionId: "session-pi",
      engineId: "pi-acp",
      supported: false,
      fetchedAt: "2026-04-20T00:10:00.000Z"
    });
    await expect(registry.getCheckpoint("session-pi")).resolves.toEqual({
      sessionId: "session-pi",
      engineId: "pi-acp",
      supported: false,
      supportsRestore: false,
      checkpoints: [],
      fetchedAt: "2026-04-20T00:10:00.000Z"
    });
    await expect(registry.getDiagnostics("session-pi")).resolves.toEqual({
      sessionId: "session-pi",
      engineId: "pi-acp",
      supported: false,
      authenticated: false,
      fetchedAt: "2026-04-20T00:10:00.000Z"
    });
    await expect(registry.getBackgroundRun("session-pi")).resolves.toEqual({
      sessionId: "session-pi",
      engineId: "pi-acp",
      supported: false,
      status: "unsupported",
      fetchedAt: "2026-04-20T00:10:00.000Z"
    });
  });

  it("routes actions and graph requests through the matching agent capability set", async () => {
    const runtimeService = createRuntimeService();
    const sessionIndexStore = {
      getEntry: vi.fn().mockImplementation((sessionId: string) => ({
        sessionId,
        workspaceId: "workspace-1",
        conversationId: `conversation-for-${sessionId}`,
        engineId: "codex",
        providerKind: "codex-thread",
        providerSessionId: "thread-1",
        createdAt: "2026-04-20T00:00:00.000Z",
        updatedAt: "2026-04-20T00:00:00.000Z",
        source: "registry"
      })),
      listEntries: vi.fn().mockReturnValue([]),
      listEntriesByProviderSessionId: vi.fn().mockReturnValue([
        {
          sessionId: "session-codex",
          providerSessionId: "thread-1"
        }
      ]),
      archiveSessions: vi.fn().mockResolvedValue(undefined)
    } as never;
    const sessionIdentity = new SessionIdentityRegistry({
      runtimeService,
      sessionIndexStore
    });
    const registry = new CapabilityRegistry({
      runtimeService,
      sessionIndexStore,
      sessionIdentity,
      capabilities: [
        {
          engineId: "codex",
          operationGuards: {
            "conversationGraph.jump": ["interactive-session"]
          },
          sessionActions: {
            resolveDisplayedSessionId: () => "thread-1",
            listAdditionalActions: async () => [
              {
                action: "open_rollout",
                label: "Open rollout"
              }
            ]
          },
          conversationGraph: {
            get: async () => ({
              sessionId: "session-codex",
              engineId: "codex",
              supportsJump: true,
              currentNodeId: "node-1",
              nodes: [
                {
                  nodeId: "node-1",
                  label: "Node 1",
                  order: 0,
                  isCurrent: true
                }
              ],
              fetchedAt: "2026-04-20T00:10:00.000Z"
            }),
            jump: async () => true
          },
          worktree: {
            get: async () => ({
              sessionId: "session-codex",
              engineId: "codex",
              supported: true,
              workspaceRoot: "I:\\repo-a",
              gitBranch: "main",
              fetchedAt: "2026-04-20T00:10:00.000Z"
            })
          },
          checkpoint: {
            get: async () => ({
              sessionId: "session-codex",
              engineId: "codex",
              supported: true,
              supportsRestore: true,
              currentCheckpointId: "node-1",
              checkpoints: [
                {
                  checkpointId: "node-1",
                  label: "Node 1",
                  order: 0,
                  isCurrent: true
                }
              ],
              fetchedAt: "2026-04-20T00:10:00.000Z"
            })
          },
          diagnostics: {
            get: async () => ({
              sessionId: "session-codex",
              engineId: "codex",
              supported: true,
              authenticated: true,
              authMethod: "chatgpt",
              fetchedAt: "2026-04-20T00:10:00.000Z"
            })
          },
          backgroundRun: {
            get: async () => ({
              sessionId: "session-codex",
              engineId: "codex",
              supported: false,
              status: "unsupported",
              fetchedAt: "2026-04-20T00:10:00.000Z"
            })
          }
        }
      ]
    });

    await expect(registry.listSessionActions("session-codex")).resolves.toContainEqual({
      action: "open_rollout",
      label: "Open rollout"
    });
    await expect(
      registry.runSessionAction("session-codex", "copy_session_id")
    ).resolves.toEqual({
      action: "copy_session_id",
      copiedText: "thread-1"
    });
    await expect(
      registry.runSessionAction("session-codex", "copy_awb_session_id")
    ).resolves.toEqual({
      action: "copy_awb_session_id",
      copiedText: "session-codex"
    });
    await expect(registry.getConversationGraph("session-codex")).resolves.toEqual({
      sessionId: "session-codex",
      engineId: "codex",
      supportsJump: true,
      currentNodeId: "node-1",
      nodes: [
        {
          nodeId: "node-1",
          label: "Node 1",
          order: 0,
          isCurrent: true
        }
      ],
      fetchedAt: "2026-04-20T00:10:00.000Z"
    });
    expect(
      registry.getOperationGuards("session-codex", "conversationGraph.jump")
    ).toEqual(["interactive-session"]);
    await expect(
      registry.jumpConversationGraph("session-codex", "node-2")
    ).resolves.toEqual({
      jumped: true
    });
    await expect(registry.getWorktree("session-codex")).resolves.toMatchObject({
      workspaceRoot: "I:\\repo-a",
      gitBranch: "main"
    });
    await expect(registry.getCheckpoint("session-codex")).resolves.toMatchObject({
      currentCheckpointId: "node-1"
    });
    await expect(registry.getDiagnostics("session-codex")).resolves.toMatchObject({
      authenticated: true,
      authMethod: "chatgpt"
    });
    await expect(registry.getBackgroundRun("session-codex")).resolves.toMatchObject({
      status: "unsupported"
    });
  });
});
