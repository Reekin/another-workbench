import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../src/codex-app-server-generated/v2/Thread.js";
import {
  CodexSessionDiscoveryProvider,
  SessionReconciliationService
} from "../src/session-discovery.js";
import {
  clearCodexTurnChangesStore,
  getRecordedCodexTurnChanges
} from "../src/engine-extensions/codex/turn-changes-store.js";
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

const buildHydratedWindow = (sessionId = "session-1") => ({
  workspaceId: "workspace-1",
  conversation: {
    conversationId: "conversation-1",
    workspaceId: "workspace-1",
    participantEngineIds: ["codex"],
    activeSessionId: sessionId,
    sessionIds: [sessionId],
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z"
  },
  session: {
    sessionId,
    conversationId: "conversation-1",
    engineId: "codex",
    status: "idle",
    title: "Session",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z"
  },
  turns: [
    {
      turnId: "turn-1",
      sessionId,
      status: "completed",
      finishReason: "completed",
      startedAt: "2026-04-19T00:00:00.000Z",
      completedAt: "2026-04-19T00:00:01.000Z",
      messageIds: [],
      toolCallIds: [],
      terminalIds: [],
      approvalRequestIds: []
    }
  ],
  messageBlocks: [],
  toolCalls: [],
  terminalStreams: [],
  sessionRelations: [],
  hasOlder: true,
  hasNewer: false,
  olderCursor: "older-cursor",
  runtimeBinding: {
    providerKind: "codex-thread",
    providerSessionId: "thread-1"
  }
});

afterEach(async () => {
  clearCodexTurnChangesStore();
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

  it("discovers last completed turn time by reading full codex threads", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-discovery-completed-at.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-08T09:59:59.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-recent"
          }
        },
        {
          timestamp: "2026-05-08T10:06:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-recent"
          }
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8"
    );
    const listedThread = createThread({
      id: "thread-recent",
      cwd: "I:/workspace-alpha"
    });
    const readThread = vi.fn().mockResolvedValue({
      ...listedThread,
      path: rolloutPath,
      turns: [
        {
          id: "turn-recent",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "user-1",
              timestamp: "2026-05-08T10:00:00Z",
              content: [
                {
                  type: "text",
                  text: "Build it.",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "agent-1",
              timestamp: "2026-05-08T10:05:00Z",
              text: "Done.",
              phase: "final_answer",
              memoryCitation: null
            }
          ]
        }
      ]
    } as Thread);
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        listThreads: vi.fn().mockResolvedValue({
          data: [listedThread],
          nextCursor: null
        }),
        readThread
      } as never
    });

    const discovered = await provider.discoverWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });

    expect(readThread).toHaveBeenCalledWith("thread-recent", true);
    expect(discovered.sessions[0]).toMatchObject({
      sessionId: "codex-thread:thread-recent",
      lastCompletedTurnAt: "2026-05-08T10:06:00.000Z"
    });
  });

  it("hydrates cold session windows from paged codex turns without resuming", async () => {
    const readThread = vi.fn().mockResolvedValue(createThread({ id: "thread-page" }));
    const listThreadTurns = vi.fn().mockResolvedValue({
      data: [
        {
          id: "turn-page",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "msg-user-page",
              content: [
                {
                  type: "text",
                  text: "Open just this page.",
                  text_elements: []
                }
              ]
            }
          ]
        }
      ],
      nextCursor: "older-cursor",
      backwardsCursor: "newer-cursor"
    });
    const resumeThread = vi.fn();
    const attachThreadToSession = vi.fn();
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        readThread,
        listThreadTurns,
        resumeThread,
        attachThreadToSession
      } as never
    });

    const hydrated = await provider.hydrateSessionWindow?.(
      {
        sessionId: "codex-thread:thread-page",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        engineId: "codex",
        providerKind: "codex-thread",
        providerSessionId: "thread-page",
        title: "Thread page",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:01:00.000Z",
        unreadState: "read",
        source: "reconciled"
      },
      {
        limit: 1,
        cursor: "cursor-1"
      }
    );

    expect(hydrated).toEqual(
      expect.objectContaining({
        hasOlder: true,
        hasNewer: true,
        olderCursor: "older-cursor",
        newerCursor: "newer-cursor",
        turns: [
          expect.objectContaining({
            turnId: "turn-page",
            sessionId: "codex-thread:thread-page"
          })
        ]
      })
    );
    expect(readThread).toHaveBeenCalledWith("thread-page", false);
    expect(listThreadTurns).toHaveBeenCalledWith({
      threadId: "thread-page",
      cursor: "cursor-1",
      limit: 1,
      sortDirection: "desc"
    });
    expect(resumeThread).not.toHaveBeenCalled();
    expect(attachThreadToSession).toHaveBeenCalledWith(
      "codex-thread:thread-page",
      "thread-page"
    );
  });

  it("uses turn-level rollout timestamps for paged turns that start with compaction", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-paged-compaction.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-10T19:10:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-older"
          }
        },
        {
          timestamp: "2026-05-10T19:10:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "older" }]
          }
        },
        {
          timestamp: "2026-05-10T19:11:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Older done." }]
          }
        },
        {
          timestamp: "2026-05-10T19:11:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-older"
          }
        },
        {
          timestamp: "2026-05-10T19:22:38.814Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-latest"
          }
        },
        {
          timestamp: "2026-05-10T19:22:38.815Z",
          type: "compacted",
          payload: {
            type: "compacted"
          }
        },
        {
          timestamp: "2026-05-10T19:22:38.816Z",
          type: "event_msg",
          payload: {
            type: "context_compacted"
          }
        },
        {
          timestamp: "2026-05-10T19:24:00.000Z",
          type: "compacted",
          payload: {
            type: "compacted"
          }
        },
        {
          timestamp: "2026-05-10T19:24:00.001Z",
          type: "event_msg",
          payload: {
            type: "context_compacted"
          }
        },
        {
          timestamp: "2026-05-10T19:23:28.232Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "修2/4/5/6" }]
          }
        },
        {
          timestamp: "2026-05-10T19:27:08.508Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "已按 review 修完。" }]
          }
        },
        {
          timestamp: "2026-05-10T19:27:08.629Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-latest"
          }
        }
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8"
    );
    const readThread = vi.fn().mockResolvedValue({
      ...createThread({ id: "thread-paged-compaction" }),
      createdAt: 1_776_420_000,
      path: rolloutPath
    });
    const listThreadTurns = vi.fn().mockResolvedValue({
      data: [
        {
          id: "turn-latest",
          status: "completed",
          error: null,
          items: [
            {
              type: "contextCompaction",
              id: "compact-latest-1"
            },
            {
              type: "contextCompaction",
              id: "compact-latest-2"
            },
            {
              type: "userMessage",
              id: "user-latest",
              content: [
                {
                  type: "text",
                  text: "修2/4/5/6",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "agent-latest",
              text: "已按 review 修完。",
              phase: "final_answer",
              memoryCitation: null
            }
          ]
        },
        {
          id: "turn-older",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              id: "user-older",
              content: [
                {
                  type: "text",
                  text: "older",
                  text_elements: []
                }
              ]
            },
            {
              type: "agentMessage",
              id: "agent-older",
              text: "Older done.",
              phase: "final_answer",
              memoryCitation: null
            }
          ]
        }
      ],
      nextCursor: null,
      backwardsCursor: null
    });
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        readThread,
        listThreadTurns,
        attachThreadToSession: vi.fn()
      } as never
    });

    const hydrated = await provider.hydrateSessionWindow?.(
      {
        sessionId: "codex-thread:thread-paged-compaction",
        workspaceId: "workspace-1",
        conversationId: "conversation-paged-compaction",
        engineId: "codex",
        providerKind: "codex-thread",
        providerSessionId: "thread-paged-compaction",
        createdAt: "2026-05-10T07:07:20.000Z",
        updatedAt: "2026-05-10T19:27:08.000Z",
        unreadState: "read",
        source: "reconciled"
      },
      {
        limit: 8
      }
    );

    expect(hydrated?.turns).toEqual([
      expect.objectContaining({
        turnId: "turn-latest",
        startedAt: "2026-05-10T19:22:38.815Z",
        completedAt: "2026-05-10T19:27:08.629Z",
        finalMessageId:
          "hydrated:codex-thread:thread-paged-compaction:agent-latest"
      }),
      expect.objectContaining({
        turnId: "turn-older",
        startedAt: "2026-05-10T19:10:02.000Z",
        completedAt: "2026-05-10T19:11:01.000Z"
      })
    ]);
    expect(hydrated?.turns[0]).toMatchObject({
      turnId: "turn-latest",
      startedAt: "2026-05-10T19:22:38.815Z",
      completedAt: "2026-05-10T19:27:08.629Z",
      finalMessageId:
        "hydrated:codex-thread:thread-paged-compaction:agent-latest"
    });
    expect(hydrated?.toolCalls[0]).toMatchObject({
      toolCallId:
        "hydrated:codex-thread:thread-paged-compaction:compact-latest-1",
      startedAt: "2026-05-10T19:22:38.815Z"
    });
    expect(hydrated?.toolCalls[1]).toMatchObject({
      toolCallId:
        "hydrated:codex-thread:thread-paged-compaction:compact-latest-2",
      startedAt: "2026-05-10T19:24:00.000Z"
    });
  });

  it("shares window hydration without letting a cancelled caller cancel an active caller", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    const runtimeService = new WorkbenchRuntimeService({
      engines: [
        {
          engineId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Session",
        createdAt: "2026-04-19T00:00:00.000Z",
        updatedAt: "2026-04-19T00:00:00.000Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-1"
    });

    let sharedIsCancelled: (() => boolean) | undefined;
    let resolveHydration:
      | ((value: ReturnType<typeof buildHydratedWindow>) => void)
      | undefined;
    const hydrateSessionWindow = vi.fn((_entry, input) => {
      sharedIsCancelled = input.isCancelled;
      return new Promise<ReturnType<typeof buildHydratedWindow>>((resolve) => {
        resolveHydration = resolve;
      });
    });
    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [
        {
          engineId: "codex",
          discoverWorkspace: vi.fn(),
          hydrateSession: vi.fn(),
          hydrateSessionWindow
        }
      ] as never
    });

    const cancelledOpen = reconciliation.hydrateSessionWindow("session-1", {
      limit: 2,
      isCancelled: () => true
    });
    await vi.waitFor(() => {
      expect(hydrateSessionWindow).toHaveBeenCalledTimes(1);
    });
    const activeOpen = reconciliation.hydrateSessionWindow("session-1", {
      limit: 2,
      isCancelled: () => false
    });

    expect(hydrateSessionWindow).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(sharedIsCancelled?.()).toBe(false);
    });
    resolveHydration?.(buildHydratedWindow());

    await expect(cancelledOpen).resolves.toBeUndefined();
    await expect(activeOpen).resolves.toEqual(
      expect.objectContaining({
        olderCursor: "older-cursor"
      })
    );
    expect(runtimeService.listSessions({ includeArchived: true })).toEqual([
      expect.objectContaining({
        sessionId: "session-1"
      })
    ]);
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
            },
            {
              type: "fileChange",
              id: "file-change-1",
              status: "completed",
              changes: [
                {
                  path: "src/foo.ts",
                  kind: {
                    type: "update",
                    move_path: null
                  },
                  diff: `@@ -1 +1 @@
-old
+new`
                }
              ]
            },
            {
              type: "collabAgentToolCall",
              id: "collab-1",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: "thread-root",
              receiverThreadIds: ["thread-child"],
              prompt: "Review this change",
              model: "gpt-5",
              reasoningEffort: "high",
              agentsStates: {
                "thread-child": {
                  status: "completed",
                  message: "Reviewed successfully"
                }
              }
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
      engines: [
        {
          engineId: "codex",
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
    expect(sessionIndexStore.getEntry("codex-thread:thread-root")).toMatchObject({
      lastCompletedTurnAt: "2026-04-17T10:01:01.000Z"
    });
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
    expect(runtimeService.getSnapshot().toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "codex-thread:thread-root",
          turnId: "turn-1",
          toolName: "subagent.spawn",
          inputSummary: expect.stringContaining("Review this change"),
          outputSummary: expect.stringContaining("thread-child: completed")
        })
      ])
    );
    expect(runtimeService.getSnapshot().turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: "turn-1"
        }),
        expect.objectContaining({
          turnId: "turn-2",
          status: "completed",
          finishReason: "failed"
        })
      ])
    );
    expect(
      getRecordedCodexTurnChanges("codex-thread:thread-root", "turn-1")
    ).toMatchObject({
      changes: [
        expect.objectContaining({
          path: "src/foo.ts",
          changeKind: "update"
        })
      ]
    });
  });

  it("aliases discovered subagent relations onto an existing local parent session by provider session id", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const sessionIndexStore = new SessionIndexStore({
      baseDir
    });
    const runtimeService = new WorkbenchRuntimeService({
      engines: [
        {
          engineId: "codex",
          displayName: "Codex",
          capabilities: ["chat"]
        }
      ]
    });

    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await sessionIndexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-root-local",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Local Root",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-root"
    });

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        listThreads: vi.fn().mockResolvedValue({
          data: [
            createThread({
              id: "thread-root",
              name: "Root Thread"
            }),
            createThread({
              id: "thread-child",
              name: "Child Thread",
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
            })
          ],
          nextCursor: null
        })
      } as never
    });

    const reconciliation = new SessionReconciliationService({
      workspaceRegistry,
      sessionIndexStore,
      runtimeService,
      providers: [provider]
    });

    await reconciliation.reconcileWorkspace("workspace-1");

    expect(sessionIndexStore.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "session-root-local",
        childSessionId: "codex-thread:thread-child",
        relationType: "subagent"
      })
    ]);
    expect(sessionIndexStore.getEntry("codex-thread:thread-child")).toMatchObject({
      conversationId: "conversation-discovered:session-root-local",
      providerSessionId: "thread-child"
    });
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
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-a",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });
    const second = await provider.hydrateSession({
      workspaceId: "workspace-1",
      sessionId: "codex-thread:thread-b",
      conversationId: "conversation-b",
      engineId: "codex",
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

  it("uses rollout timestamps when hydrating restored codex messages", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-02T02:48:38.930Z",
          type: "event_msg",
          payload: {
            type: "task_started"
          }
        },
        {
          timestamp: "2026-05-02T02:48:39.123Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Please summarize."
          }
        },
        {
          timestamp: "2026-05-02T02:48:51.597Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Done."
              }
            ]
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        resumeThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-rollout-time",
            name: "Thread rollout time",
            preview: "Preview rollout time"
          }),
          path: rolloutPath,
          turns: [
            {
              id: "turn-rollout-time",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-1",
                  content: [
                    {
                      type: "text",
                      text: "Please summarize.",
                      text_elements: []
                    }
                  ]
                },
                {
                  type: "agentMessage",
                  id: "agent-1",
                  text: "Done.",
                  phase: "final_answer",
                  memoryCitation: null
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
      sessionId: "codex-thread:thread-rollout-time",
      conversationId: "conversation-rollout-time",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-rollout-time",
      createdAt: "2026-05-01T01:20:36.847Z",
      updatedAt: "2026-05-02T02:48:53.187Z"
    });

    expect(hydrated?.turns[0]).toMatchObject({
      startedAt: "2026-05-02T02:48:39.123Z",
      completedAt: "2026-05-02T02:48:51.597Z"
    });
    expect(hydrated?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "hydrated:codex-thread:thread-rollout-time:user-1",
          startedAt: "2026-05-02T02:48:39.123Z"
        }),
        expect.objectContaining({
          messageId: "hydrated:codex-thread:thread-rollout-time:agent-1",
          startedAt: "2026-05-02T02:48:51.597Z",
          completedAt: "2026-05-02T02:48:51.597Z"
        })
      ])
    );
  });

  it("matches rollout timestamps by turn id without hydrating rollout-only messages", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-repeated-prompt.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-03T17:25:32.164Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-old"
          }
        },
        {
          timestamp: "2026-05-03T17:25:32.165Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "build个exe" }]
          }
        },
        {
          timestamp: "2026-05-03T17:25:37.793Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Old build answer." }],
            phase: "final_answer"
          }
        },
        {
          timestamp: "2026-05-03T17:50:32.030Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-new"
          }
        },
        {
          timestamp: "2026-05-03T17:50:32.031Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "build个exe" }]
          }
        },
        {
          timestamp: "2026-05-03T17:53:20.979Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "New build answer." }],
            phase: "final_answer"
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        resumeThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-repeated-prompt",
            name: "Thread repeated prompt",
            preview: "Preview repeated prompt"
          }),
          path: rolloutPath,
          turns: [
            {
              id: "turn-new",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-new",
                  content: [
                    {
                      type: "text",
                      text: "build个exe",
                      text_elements: []
                    }
                  ]
                },
                {
                  type: "agentMessage",
                  id: "agent-new",
                  text: "New build answer.",
                  phase: "final_answer",
                  memoryCitation: null
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
      sessionId: "codex-thread:thread-repeated-prompt",
      conversationId: "conversation-repeated-prompt",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-repeated-prompt",
      createdAt: "2026-05-01T01:20:36.847Z",
      updatedAt: "2026-05-03T17:53:21.097Z"
    });

    expect(hydrated?.turns[0]).toMatchObject({
      startedAt: "2026-05-03T17:50:32.031Z",
      completedAt: "2026-05-03T17:53:20.979Z",
      finalMessageId: "hydrated:codex-thread:thread-repeated-prompt:agent-new"
    });
    expect(hydrated?.messageBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "hydrated:codex-thread:thread-repeated-prompt:user-new",
          startedAt: "2026-05-03T17:50:32.031Z",
          text: "build个exe"
        }),
        expect.objectContaining({
          messageId: "hydrated:codex-thread:thread-repeated-prompt:agent-new",
          role: "assistant",
          startedAt: "2026-05-03T17:53:20.979Z",
          text: "New build answer."
        })
      ])
    );
    expect(hydrated?.messageBlocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Old build answer."
        })
      ])
    );
  });

  it("does not hydrate codex injected user context as a user prompt", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-injected-user-context.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-02T04:40:11.866Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-injected-context"
          }
        },
        {
          timestamp: "2026-05-02T04:40:11.866Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for I:\\gpt-projects\\tqqq-tracker\n\n<INSTRUCTIONS>\n## Shell\nUse bash.\n</INSTRUCTIONS>"
              },
              {
                type: "input_text",
                text: "<environment_context>\n  <cwd>I:\\gpt-projects\\tqqq-tracker</cwd>\n</environment_context>"
              }
            ]
          }
        },
        {
          timestamp: "2026-05-02T04:40:11.866Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "review当前目录下的量化交易方案" }]
          }
        },
        {
          timestamp: "2026-05-02T04:40:11.866Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "review当前目录下的量化交易方案"
          }
        },
        {
          timestamp: "2026-05-02T04:40:18.672Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "我会先快速梳理项目结构。" }],
            phase: "commentary"
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        resumeThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-injected-context",
            name: "Thread injected context",
            preview: "Preview injected context"
          }),
          path: rolloutPath,
          turns: [
            {
              id: "turn-injected-context",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-injected-context",
                  content: [
                    {
                      type: "text",
                      text: "review当前目录下的量化交易方案",
                      text_elements: []
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
      sessionId: "codex-thread:thread-injected-context",
      conversationId: "conversation-injected-context",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-injected-context",
      createdAt: "2026-05-02T04:40:11.866Z",
      updatedAt: "2026-05-02T04:40:18.672Z"
    });

    const userMessages = hydrated?.messageBlocks.filter((block) => block.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages?.[0]).toMatchObject({
      text: "review当前目录下的量化交易方案"
    });
    expect(hydrated?.messageBlocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("AGENTS.md instructions")
        }),
        expect.objectContaining({
          text: expect.stringContaining("<environment_context>")
        })
      ])
    );
    expect(hydrated?.messageBlocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: "我会先快速梳理项目结构。"
        })
      ])
    );
  });

  it("does not hydrate rollout-only assistant messages after compaction", async () => {
    const baseDir = await createTempDir();
    const rolloutPath = join(baseDir, "rollout-compacted-turn.jsonl");
    await writeFile(
      rolloutPath,
      [
        {
          timestamp: "2026-05-03T18:28:10.013Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-compacted"
          }
        },
        {
          timestamp: "2026-05-03T18:28:10.013Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "我已关闭卡巴斯基，继续完成开发" }]
          }
        },
        {
          timestamp: "2026-05-03T18:28:14.963Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "恢复刚才被杀软中断后的验证状态。" }],
            phase: "commentary"
          }
        },
        {
          timestamp: "2026-05-03T18:44:57.330Z",
          type: "compacted",
          payload: {
            type: "compacted"
          }
        },
        {
          timestamp: "2026-05-03T18:44:57.330Z",
          type: "event_msg",
          payload: {
            type: "context_compacted"
          }
        },
        {
          timestamp: "2026-05-03T18:45:03.557Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "继续定位当前 app-server 测试栈溢出的原因。",
            phase: "commentary"
          }
        },
        {
          timestamp: "2026-05-04T04:01:02.174Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-compacted",
            last_agent_message: ""
          }
        }
      ].map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8"
    );

    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        resumeThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-compacted",
            name: "Thread compacted",
            preview: "Preview compacted"
          }),
          path: rolloutPath,
          turns: [
            {
              id: "turn-compacted",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-compacted",
                  content: [
                    {
                      type: "text",
                      text: "我已关闭卡巴斯基，继续完成开发",
                      text_elements: []
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
      sessionId: "codex-thread:thread-compacted",
      conversationId: "conversation-compacted",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-compacted",
      createdAt: "2026-05-01T01:20:36.847Z",
      updatedAt: "2026-05-04T04:01:02.174Z"
    });

    expect(hydrated?.turns[0]?.messageIds).toEqual([
      "hydrated:codex-thread:thread-compacted:user-compacted"
    ]);
    expect(hydrated?.messageBlocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: "恢复刚才被杀软中断后的验证状态。"
        }),
        expect.objectContaining({
          role: "assistant",
          text: "继续定位当前 app-server 测试栈溢出的原因。"
        })
      ])
    );
  });

  it("hydrates reasoning and web search items as generic tool calls", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        resumeThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-process",
            name: "Process thread",
            preview: "Process thread"
          }),
          turns: [
            {
              id: "turn-process",
              status: "completed",
              error: null,
              items: [
                {
                  type: "reasoning",
                  id: "reason-1",
                  summary: ["Checked official CPU specs"],
                  content: ["Compared low-power options"]
                },
                {
                  type: "reasoning",
                  id: "reason-empty",
                  summary: [],
                  content: []
                },
                {
                  type: "webSearch",
                  id: "search-1",
                  query: "Intel N150 official specs",
                  action: {
                    type: "search",
                    query: "Intel N150 official specs",
                    queries: ["Intel N150 Processor Base Power"]
                  }
                },
                {
                  type: "contextCompaction",
                  id: "compact-1"
                },
                {
                  type: "agentMessage",
                  id: "msg-1",
                  text: "Done",
                  phase: "final_answer",
                  memoryCitation: null
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
      sessionId: "codex-thread:thread-process",
      conversationId: "conversation-process",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-process",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });

    expect(hydrated?.turns[0]?.toolCallIds).toEqual([
      "hydrated:codex-thread:thread-process:reason-1",
      "hydrated:codex-thread:thread-process:search-1",
      "hydrated:codex-thread:thread-process:compact-1"
    ]);
    const reasoningTool = hydrated?.toolCalls.find(
      (toolCall) =>
        toolCall.toolCallId === "hydrated:codex-thread:thread-process:reason-1"
    );
    const webSearchTool = hydrated?.toolCalls.find(
      (toolCall) =>
        toolCall.toolCallId === "hydrated:codex-thread:thread-process:search-1"
    );
    const compactionTool = hydrated?.toolCalls.find(
      (toolCall) =>
        toolCall.toolCallId === "hydrated:codex-thread:thread-process:compact-1"
    );
    expect(reasoningTool).toMatchObject({
      toolName: "reasoning",
      outputSummary: expect.stringContaining("Checked official CPU specs")
    });
    expect(webSearchTool).toMatchObject({
      toolName: "webSearch",
      inputSummary: expect.stringContaining("Intel N150 official specs")
    });
    expect(webSearchTool?.outputSummary).toBeUndefined();
    expect(compactionTool).toMatchObject({
      toolName: "contextCompaction",
      inputSummary: "compacting...",
      outputSummary: "compaction finished"
    });
  });

  it("recovers turn.finalMessageId only when a hydrated agent message is marked final_answer", async () => {
    const provider = new CodexSessionDiscoveryProvider({
      codexRuntimePort: {
        resumeThread: vi.fn().mockResolvedValue({
          ...createThread({
            id: "thread-final-answer",
            name: "Thread final answer",
            preview: "Preview final answer"
          }),
          turns: [
            {
              id: "turn-final",
              status: "completed",
              error: null,
              items: [
                {
                  type: "agentMessage",
                  id: "msg-commentary",
                  text: "Thinking...",
                  phase: "commentary",
                  memoryCitation: null
                },
                {
                  type: "agentMessage",
                  id: "msg-final",
                  text: "Ship it.",
                  phase: "final_answer",
                  memoryCitation: null
                }
              ]
            },
            {
              id: "turn-legacy",
              status: "completed",
              error: null,
              items: [
                {
                  type: "agentMessage",
                  id: "msg-legacy",
                  text: "Legacy answer",
                  phase: null,
                  memoryCitation: null
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
      sessionId: "codex-thread:thread-final-answer",
      conversationId: "conversation-final-answer",
      engineId: "codex",
      providerKind: "codex-thread",
      providerSessionId: "thread-final-answer",
      createdAt: "2026-04-19T00:00:00.000Z",
      updatedAt: "2026-04-19T00:00:01.000Z"
    });

    expect(hydrated?.turns[0]).toMatchObject({
      turnId: "turn-final",
      finalMessageId: "hydrated:codex-thread:thread-final-answer:msg-final",
      messageIds: [
        "hydrated:codex-thread:thread-final-answer:msg-commentary",
        "hydrated:codex-thread:thread-final-answer:msg-final"
      ]
    });
    expect(hydrated?.turns[1]).toMatchObject({
      turnId: "turn-legacy",
      messageIds: ["hydrated:codex-thread:thread-final-answer:msg-legacy"]
    });
    expect(hydrated?.turns[1]).not.toHaveProperty("finalMessageId");
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
      engineId: "codex",
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
        engineId: "codex",
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
      engines: [
        {
          engineId: "codex",
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
