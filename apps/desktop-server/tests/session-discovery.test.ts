import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../src/codex-app-server-generated/v2/Thread.js";
import {
  CodexSessionDiscoveryProvider,
  SessionReconciliationService
} from "../src/session-discovery.js";
import { SessionIndexStore } from "../src/session-index.js";
import { WorkbenchRuntimeService } from "../src/runtime-service.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-session-discovery-"));
  tempDirs.push(dir);
  return dir;
};

const createThread = (input: {
  id: string;
  source?: Thread["source"];
  name?: string | null;
  preview?: string;
  cwd?: string;
}): Thread => ({
  id: input.id,
  preview: input.preview ?? `Preview ${input.id}`,
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1_776_420_000,
  updatedAt: 1_776_420_120,
  status: {
    type: "idle"
  },
  path: `I:/rollouts/${input.id}.md`,
  cwd: input.cwd ?? "I:/workspace-alpha",
  cliVersion: "1.0.0",
  source: input.source ?? "appServer",
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: input.name ?? null,
  turns: []
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("Session discovery and reconciliation", () => {
  it("matches codex thread cwd values that include the windows device prefix", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        listThreads: vi.fn().mockResolvedValue({
          data: [
            createThread({
              id: "thread-root",
              cwd: "\\\\?\\I:\\workspace-alpha"
            }),
            createThread({
              id: "thread-child",
              cwd: "\\\\?\\I:\\workspace-alpha\\apps\\desktop"
            }),
            createThread({
              id: "thread-other",
              cwd: "\\\\?\\I:\\other-workspace"
            })
          ],
          nextCursor: null
        })
      } as never
    });

    await expect(
      provider.discoverWorkspace({
        workspaceId: "workspace-1",
        absolutePath: "I:/workspace-alpha",
        label: "Alpha"
      })
    ).resolves.toEqual({
      sessions: [
        expect.objectContaining({ sessionId: "codex-thread:thread-root" }),
        expect.objectContaining({ sessionId: "codex-thread:thread-child" })
      ],
      relations: []
    });
  });

  it("discovers codex threads, derives subagent relations, and hydrates discovered sessions", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });

    const rootThread = createThread({
      id: "thread-root",
      name: "Root Thread",
      preview: "Root preview"
    });
    const childThread = createThread({
      id: "thread-child",
      name: "Child Thread",
      preview: "Child preview",
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "thread-root",
            depth: 1,
            agent_nickname: "child",
            agent_role: "reviewer"
          }
        }
      }
    });

    const attachThreadToSession = vi.fn();
    const resumeThread = vi.fn().mockResolvedValue({
      ...rootThread,
      turns: [
        {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "msg-user-1",
              content: [
                {
                  type: "text",
                  text: "Reply with exactly hi.",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "msg-1",
              text: "Hydrated root response",
              phase: null,
              memoryCitation: null
            }
          ]
        },
        {
          id: "turn-2",
          status: "failed",
          error: {
            message: "Boom",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: "Try again later."
          },
          items: []
        }
      ]
    });
    const listThreads = vi.fn().mockResolvedValue({
      data: [rootThread, childThread],
      nextCursor: null
    });

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        listThreads,
        resumeThread,
        attachThreadToSession
      } as never
    });

    const runtimeService = new WorkbenchRuntimeService({
      agents: [
        {
          agentId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });

    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [provider]
    });

    await expect(reconciliation.reconcileWorkspace("workspace-1")).resolves.toEqual({
      workspaces: 1,
      sessions: 2,
      relations: 1
    });

    expect(sessionIndexStore.getEntry("codex-thread:thread-root")).toMatchObject({
      providerKind: "codex-thread",
      providerSessionId: "thread-root",
      conversationId: "conversation-discovered:codex-thread:thread-root",
      source: "reconciled"
    });
    expect(sessionIndexStore.getEntry("codex-thread:thread-child")).toMatchObject({
      providerSessionId: "thread-child",
      conversationId: "conversation-discovered:codex-thread:thread-root"
    });
    expect(sessionIndexStore.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "codex-thread:thread-root",
        childSessionId: "codex-thread:thread-child",
        relationType: "subagent"
      })
    ]);

    await expect(
      reconciliation.ensureSessionLoaded("codex-thread:thread-root")
    ).resolves.toBe(true);

    expect(attachThreadToSession).toHaveBeenCalledWith(
      "codex-thread:thread-root",
      "thread-root"
    );
    expect(runtimeService.listSessions({ includeArchived: true })).toEqual([
      expect.objectContaining({
        sessionId: "codex-thread:thread-root",
        conversationId: "conversation-discovered:codex-thread:thread-root"
      })
    ]);
    expect(runtimeService.getSnapshot().messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          role: "user",
          text: "Reply with exactly hi."
        }),
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          role: "assistant",
          text: "Hydrated root response"
        }),
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          turnId: "turn-2",
          role: "system",
          text: "Runtime error (usageLimitExceeded): Boom\n\nTry again later."
        })
      ])
    );
    expect(runtimeService.getSnapshot().messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "hydrated:codex-thread:thread-root:msg-user-1:md",
          messageId: "hydrated:codex-thread:thread-root:msg-user-1"
        }),
        expect.objectContaining({
          blockId: "hydrated:codex-thread:thread-root:msg-1:md",
          messageId: "hydrated:codex-thread:thread-root:msg-1"
        })
      ])
    );
    expect(runtimeService.getSnapshot().turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: "turn-2",
          status: "completed",
          finishReason: "failed"
        })
      ])
    );
  });

  it("keeps hydrated message blocks distinct when different sessions reuse item ids", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        resumeThread: vi
          .fn()
          .mockImplementation(async (threadId: string) => ({
            ...createThread({
              id: threadId,
              name: `Thread ${threadId}`,
              preview: `Preview ${threadId}`
            }),
            turns: [
              {
                id: `${threadId}-turn-1`,
                status: "completed",
                error: null,
                items: [
                  {
                    type: "userMessage",
                    id: "item-1",
                    content: [
                      {
                        type: "text",
                        text: `Prompt ${threadId}`,
                        text_elements: []
                      }
                    ]
                  },
                  {
                    type: "agentMessage",
                    id: "item-2",
                    text: `Answer ${threadId}`,
                    phase: null,
                    memoryCitation: null
                  }
                ]
              }
            ]
          })),
        attachThreadToSession: vi.fn()
      } as never
    });

    const first = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-a",
      conversationId: "conversation-a",
      agentId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-a",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });
    const second = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-b",
      conversationId: "conversation-b",
      agentId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-b",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });

    expect(first?.turns[0]?.messageIds).toEqual([
      "hydrated:codex-thread:thread-a:item-1",
      "hydrated:codex-thread:thread-a:item-2"
    ]);
    expect(second?.turns[0]?.messageIds).toEqual([
      "hydrated:codex-thread:thread-b:item-1",
      "hydrated:codex-thread:thread-b:item-2"
    ]);
    expect(first?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "hydrated:codex-thread:thread-a:item-1:md",
          text: "Prompt thread-a"
        }),
        expect.objectContaining({
          blockId: "hydrated:codex-thread:thread-a:item-2:md",
          text: "Answer thread-a"
        })
      ])
    );
    expect(second?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockId: "hydrated:codex-thread:thread-b:item-1:md",
          text: "Prompt thread-b"
        }),
        expect.objectContaining({
          blockId: "hydrated:codex-thread:thread-b:item-2:md",
          text: "Answer thread-b"
        })
      ])
    );
  });

  it("serializes local image inputs as markdown images with file URLs", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        resumeThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-images",
            name: "Images",
            preview: "Images"
          }),
          turns: [
            {
              id: "turn-image",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "msg-image",
                  content: [
                    {
                      type: "text",
                      text: "Look at this",
                      text_elements: []
                    },
                    {
                      type: "localImage",
                      path: "C:\\\\Users\\\\TestUser\\\\Pictures\\\\cat.png"
                    }
                  ]
                }
              ]
            }
          ]
        }),
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-images",
      conversationId: "conversation-images",
      agentId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-images",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });

    expect(hydrated?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          text:
            "Look at this\n\n![image](file:///C:/Users/TestUser/Pictures/cat.png)"
        })
      ])
    );
  });

  it("archives stale reconciled Codex entries that disappear from discovery", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "codex-thread:thread-stale",
        conversationId: "conversation-stale",
        agentId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-stale",
      source: "reconciled"
    });

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        listThreads: vi.fn().mockResolvedValue({
          data: [createThread({ id: "thread-fresh" })],
          nextCursor: null
        })
      } as never
    });
    const runtimeService = new WorkbenchRuntimeService({
      agents: [
        {
          agentId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });

    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [provider]
    });

    await reconciliation.reconcileWorkspace("workspace-1");

    expect(sessionIndexStore.getEntry("codex-thread:thread-stale")?.archivedAt).toBeDefined();
    expect(sessionIndexStore.getEntry("codex-thread:thread-fresh")).toMatchObject({
      providerSessionId: "thread-fresh",
      archivedAt: undefined
    });
  });
});
