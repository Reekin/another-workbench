import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "@another-workbench/adapters";
import { SessionIndexStore } from "../src/session-index.js";
import { WorkbenchRuntimeService } from "../src/runtime-service.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-runtime-service-"));
  tempDirs.push(dir);
  return dir;
};

const flushAsyncEffects = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createService = (options: {
  persistenceBaseDir?: string;
  agentBindings?: ConstructorParameters<typeof WorkbenchRuntimeService>[0]["agentBindings"];
} = {}) =>
  new WorkbenchRuntimeService({
    now: (() => {
      let tick = 0;
      return () => `2026-04-18T00:00:${String(++tick).padStart(2, "0")}Z`;
    })(),
    createConversationId: (() => {
      let index = 0;
      return () => `conversation-${++index}`;
    })(),
    createRelationId: (() => {
      let index = 0;
      return () => `relation-${++index}`;
    })(),
    createSessionId: (() => {
      let index = 0;
      return () => `session-${++index}`;
    })(),
    createEventId: (() => {
      let index = 0;
      return () => `event-${++index}`;
    })(),
    workspaceRegistry: options.persistenceBaseDir
      ? new WorkspaceRegistryService({
          baseDir: options.persistenceBaseDir
        })
      : undefined,
    sessionIndexStore: options.persistenceBaseDir
      ? new SessionIndexStore({
          baseDir: options.persistenceBaseDir
        })
      : undefined,
    agentBindings: options.agentBindings,
    engines: [
      {
        engineId: "codex",
        displayName: "Codex",
        capabilities: ["chat", "terminal"]
      },
      {
        engineId: "acp",
        displayName: "ACP",
        capabilities: ["chat"]
      }
    ]
  });

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("WorkbenchRuntimeService", () => {
  it("persists workspace-backed session index entries for created, archived, and forked sessions via SessionIndexSyncService", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir,
      createWorkspaceId: () => "workspace-1"
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "D:/workspace/another-workbench"
    });

    const service = createService({
      persistenceBaseDir: baseDir
    });

    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });
    await service.executeCommand({
      commandId: "cmd-fork",
      command: {
        type: "forkSession",
        sessionId: "session-1",
        fromTurnId: "turn-9"
      }
    });
    await service.executeCommand({
      commandId: "cmd-archive",
      command: {
        type: "archiveSession",
        sessionId: "session-1"
      }
    });

    const indexEntries = service.getSessionIndexStore()?.listEntries("workspace-1");
    expect(indexEntries?.map((entry) => entry.sessionId)).toEqual([
      "session-1",
      "session-2"
    ]);
    expect(indexEntries?.find((entry) => entry.sessionId === "session-1")?.archivedAt).toBeDefined();
    expect(service.getSessionIndexStore()?.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "session-1",
        childSessionId: "session-2",
        relationType: "fork",
        sourceTurnId: "turn-9"
      })
    ]);
    expect(service.getWorkspaceRegistry()?.getState()).toMatchObject({
      lastActiveWorkspaceId: "workspace-1",
      lastActiveSessionId: "session-2"
    });
  });

  it("persists provider session identity after adapter events for workspace-backed sessions", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir,
      createWorkspaceId: () => "workspace-1"
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "D:/workspace/another-workbench"
    });

    let listener: Parameters<AgentAdapter["subscribe"]>[0] | undefined;
    const providerSessionIdBySessionId = new Map<string, string>();
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => "idle",
      initialize: async () => {},
      executeCommand: async (envelope) => {
        if (envelope.command.type === "sendUserMessage") {
          providerSessionIdBySessionId.set(envelope.command.sessionId, "thread-123");
          listener?.({
            event: {
              type: "session.updated",
              conversationId: "conversation-1",
              sessionId: envelope.command.sessionId,
              status: "running"
            },
            eventId: "evt-provider-link",
            cursor: "1",
            occurredAt: "2026-04-18T00:00:09Z"
          });
        }
        return {
          commandId: envelope.commandId,
          commandType: envelope.command.type,
          accepted: true
        };
      },
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      dispose: async () => {}
    };

    const service = createService({
      persistenceBaseDir: baseDir,
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          },
          adapter,
          providerKind: "codex-thread",
          resolveProviderSessionId: (sessionId: string) =>
            providerSessionIdBySessionId.get(sessionId)
        }
      ]
    });

    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });
    await service.executeCommand({
      commandId: "cmd-send",
      command: {
        type: "sendUserMessage",
        sessionId: "session-1",
        messageId: "msg-1",
        content: "hello",
        attachments: []
      }
    });

    expect(service.getSessionIndexStore()?.getEntry("session-1")).toMatchObject({
      providerKind: "codex-thread",
      providerSessionId: "thread-123"
    });
  });

  it("keeps the active workspace-backed session read when a turn completes", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir,
      createWorkspaceId: () => "workspace-1"
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "D:/workspace/another-workbench"
    });

    const service = createService({
      persistenceBaseDir: baseDir
    });

    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });

    await service.executeCommand({
      commandId: "cmd-send",
      command: {
        type: "sendUserMessage",
        sessionId: "session-1",
        messageId: "msg-1",
        content: "hello",
        attachments: []
      }
    });
    await flushAsyncEffects();

    expect(service.getSessionIndexStore()?.getEntry("session-1")).toMatchObject({
      unreadState: "read"
    });
  });

  it("marks inactive workspace-backed sessions unread when a turn completes", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir,
      createWorkspaceId: () => "workspace-1"
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "D:/workspace/another-workbench"
    });

    const service = createService({
      persistenceBaseDir: baseDir
    });

    await service.executeCommand({
      commandId: "cmd-create-1",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });
    await service.executeCommand({
      commandId: "cmd-create-2",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });

    service.applyRuntimeEvent({
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1"
    });
    service.applyRuntimeEvent({
      type: "turn.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      finishReason: "completed"
    });
    await flushAsyncEffects();

    expect(service.getSessionIndexStore()?.getEntry("session-1")).toMatchObject({
      unreadState: "unread_completed"
    });
    expect(service.getSessionIndexStore()?.getEntry("session-2")).toMatchObject({
      unreadState: "read"
    });
  });

  it("creates, lists, archives, and resumes sessions while maintaining participants", async () => {
    const service = createService();

    const createReceipt = await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });

    expect(createReceipt).toEqual({
      commandId: "cmd-create",
      commandType: "createSession",
      accepted: true
    });

    const sessionsAfterCreate = service.listSessions();
    expect(sessionsAfterCreate).toHaveLength(1);
    expect(sessionsAfterCreate[0]).toMatchObject({
      sessionId: "session-1",
      conversationId: "conversation-1",
      engineId: "codex",
      status: "idle"
    });

    await service.executeCommand({
      commandId: "cmd-archive",
      command: {
        type: "archiveSession",
        sessionId: "session-1"
      }
    });
    expect(service.listSessions()).toHaveLength(0);
    expect(service.listSessions({ includeArchived: true })).toHaveLength(1);

    await service.executeCommand({
      commandId: "cmd-resume",
      command: {
        type: "resumeSession",
        sessionId: "session-1"
      }
    });
    expect(service.listSessions()).toHaveLength(1);

    const snapshot = service.getSnapshot();
    expect(snapshot.conversations[0]).toMatchObject({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      activeSessionId: "session-1",
      sessionIds: ["session-1"],
      participantEngineIds: ["codex"]
    });
    expect(snapshot.participants[0]).toMatchObject({
      participantId: "participant-conversation-1-codex",
      role: "primary",
      activeSessionIds: ["session-1"]
    });
  });

  it("renders local attachment markdown into the optimistic user message snapshot", async () => {
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => "idle",
      initialize: async () => {},
      executeCommand: async (envelope) => ({
        commandId: envelope.commandId,
        commandType: envelope.command.type,
        accepted: true
      }),
      subscribe: () => () => {},
      dispose: async () => {}
    };

    const service = createService({
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          },
          adapter,
          providerKind: "codex-thread"
        }
      ]
    });

    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });

    await service.executeCommand({
      commandId: "cmd-send",
      command: {
        type: "sendUserMessage",
        sessionId: "session-1",
        messageId: "msg-1",
        content: "Please review these files.",
        attachments: [
          {
            attachmentId: "image-1",
            mimeType: "image/png",
            uri: "file:///C:/Users/TestUser/Pictures/reference.png",
            name: "reference.png"
          },
          {
            attachmentId: "file-1",
            mimeType: "text/plain",
            uri: "file:///D:/workspace/another-workbench/README.md",
            name: "README.md"
          }
        ]
      }
    });

    const snapshot = service.getSnapshot();
    const block = snapshot.messageBlocks.find((entry) => entry.messageId === "msg-1");
    expect(block?.text).toBe(
      "Please review these files.\n\n![reference.png](file:///C:/Users/TestUser/Pictures/reference.png)\n[README.md](file:///D:/workspace/another-workbench/README.md)"
    );
  });

  it("keeps a session running after sendUserMessage when the adapter accepts but has not emitted runtime events yet", async () => {
    let listener: Parameters<AgentAdapter["subscribe"]>[0] | undefined;
    const adapter: AgentAdapter = {
      id: "codex-adapter",
      kind: "codex",
      getLifecycleState: () => "idle",
      initialize: async () => {},
      executeCommand: async (envelope) => ({
        commandId: envelope.commandId,
        commandType: envelope.command.type,
        accepted: true
      }),
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      dispose: async () => {}
    };

    const service = createService({
      agentBindings: [
        {
          descriptor: {
            engineId: "codex",
            displayName: "Codex",
            capabilities: ["chat", "terminal"]
          },
          adapter,
          providerKind: "codex-thread"
        }
      ]
    });

    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        workspaceId: "workspace-1"
      }
    });

    await service.executeCommand({
      commandId: "cmd-send",
      command: {
        type: "sendUserMessage",
        sessionId: "session-1",
        messageId: "msg-running",
        content: "hello",
        attachments: []
      }
    });

    expect(listener).toBeTypeOf("function");
    expect(service.getSnapshot().sessions.find((session) => session.sessionId === "session-1"))
      .toMatchObject({
        status: "running"
      });
  });


  it("forks sessions and records the session relation in the snapshot", async () => {
    const service = createService();
    const received: string[] = [];
    const unsubscribe = service.subscribe((envelope) => {
      if (envelope.event.type === "session.created") {
        received.push(
          JSON.stringify({
            sessionId: envelope.event.sessionId,
            relation: envelope.event.relation
          })
        );
      }
    }, {
      conversationId: "conversation-main"
    });

    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-main"
      }
    });

    const forkReceipt = await service.executeCommand({
      commandId: "cmd-fork",
      command: {
        type: "forkSession",
        sessionId: "session-1",
        fromTurnId: "turn-7"
      }
    });

    expect(forkReceipt).toEqual({
      commandId: "cmd-fork",
      commandType: "forkSession",
      accepted: true
    });
    unsubscribe();

    const snapshot = service.getSnapshot();
    expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
      "session-2",
      "session-1"
    ]);
    expect(snapshot.sessionRelations).toEqual([
      expect.objectContaining({
        relationId: "relation-1",
        parentSessionId: "session-1",
        childSessionId: "session-2",
        relationType: "fork",
        sourceTurnId: "turn-7"
      })
    ]);
    expect(received.some((entry) => {
      const parsed = JSON.parse(entry) as {
        sessionId: string;
        relation?: {
          relationId: string;
          parentSessionId: string;
          childSessionId: string;
          relationType: string;
          sourceTurnId?: string;
          createdAt?: string;
        };
      };
      return (
        parsed.sessionId === "session-2" &&
        parsed.relation?.relationId === "relation-1" &&
        parsed.relation.parentSessionId === "session-1" &&
        parsed.relation.childSessionId === "session-2" &&
        parsed.relation.relationType === "fork" &&
        parsed.relation.sourceTurnId === "turn-7"
      );
    })).toBe(true);
  });

  it("publishes and replays session lifecycle events with filtering", async () => {
    const service = createService();
    const received: string[] = [];
    const unsubscribe = service.subscribe((envelope) => {
      received.push(`${envelope.cursor}:${envelope.event.type}`);
    }, {
      conversationId: "conversation-1"
    });

    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex"
      }
    });
    await service.executeCommand({
      commandId: "cmd-archive",
      command: {
        type: "archiveSession",
        sessionId: "session-1"
      }
    });

    unsubscribe();

    expect(received).toEqual([
      "1:participant.updated",
      "2:session.created",
      "3:conversation.updated",
      "4:session.archived",
      "5:conversation.updated"
    ]);

    const replayed = service.replay({
      fromCursor: "3",
      filter: {
        conversationId: "conversation-1"
      }
    });

    expect(replayed.map((envelope) => `${envelope.cursor}:${envelope.event.type}`)).toEqual([
      "4:session.archived",
      "5:conversation.updated"
    ]);

    expect(
      service.replayResult({
        fromCursor: "cursor-missing"
      })
    ).toMatchObject({
      status: "gap",
      reason: "cursor_not_found",
      replayed: 0,
      fromCursor: "cursor-missing",
      envelopes: []
    });
  });

  it("continues runtime-service delivery when a subscriber throws", async () => {
    const service = createService();
    const received: string[] = [];
    const unsubscribeFailing = service.subscribe(() => {
      throw new Error("diagnostics subscriber failed");
    });
    const unsubscribeReceiving = service.subscribe((envelope) => {
      received.push(`${envelope.cursor}:${envelope.event.type}`);
    }, {
      conversationId: "conversation-1"
    });

    await expect(
      service.executeCommand({
        commandId: "cmd-create",
        command: {
          type: "createSession",
          engineId: "codex"
        }
      })
    ).resolves.toMatchObject({
      commandId: "cmd-create",
      commandType: "createSession",
      accepted: true
    });

    unsubscribeFailing();
    unsubscribeReceiving();

    expect(received).toEqual([
      "1:participant.updated",
      "2:session.created",
      "3:conversation.updated"
    ]);
  });

  it("tracks the selected engine across runtime configuration changes", () => {
    const service = createService();

    expect(service.getSelectedEngineId()).toBe("codex");

    expect(service.selectEngine({ engineId: "acp" })).toEqual({
      selectedEngineId: "acp"
    });
    expect(service.getSelectedEngineId()).toBe("acp");
  });

  it("disposes sessions through live events and removes relations from the snapshot", async () => {
    const service = createService();
    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-main"
      }
    });
    await service.executeCommand({
      commandId: "cmd-fork",
      command: {
        type: "forkSession",
        sessionId: "session-1",
        fromTurnId: "turn-7"
      }
    });

    const received: string[] = [];
    const unsubscribe = service.subscribe((envelope) => {
      received.push(`${envelope.cursor}:${envelope.event.type}`);
    }, {
      conversationId: "conversation-main"
    });

    await service.executeCommand({
      commandId: "cmd-dispose",
      command: {
        type: "disposeSession",
        sessionId: "session-1"
      }
    });
    unsubscribe();

    expect(received.map((entry) => entry.replace(/^\d+:/, ""))).toEqual([
      "session.disposed",
      "conversation.updated"
    ]);
    expect(service.getSnapshot().sessions.map((session) => session.sessionId)).toEqual([
      "session-2"
    ]);
    expect(service.getSnapshot().sessionRelations).toEqual([]);
  });

  it("keeps awaiting_approval status until an explicit runtime status event arrives", async () => {
    const service = createService();
    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-main"
      }
    });

    const applyRuntimeEvent = (
      service as unknown as {
        applyRuntimeEvent: (event: unknown, occurredAt?: string) => void;
      }
    ).applyRuntimeEvent.bind(service);

    applyRuntimeEvent(
      {
        type: "approval.requested",
        sessionId: "session-1",
        turnId: "turn-1",
        requestId: "approval-deny",
        approvalKind: "tool",
        title: "Need permission",
        engineId: "codex"
      },
      "2026-04-18T00:00:10Z"
    );
    expect(service.getSnapshot().sessions.find((session) => session.sessionId === "session-1"))
      .toMatchObject({
        status: "awaiting_approval"
      });

    applyRuntimeEvent(
      {
        type: "approval.resolved",
        sessionId: "session-1",
        turnId: "turn-1",
        requestId: "approval-deny",
        action: "deny",
        engineId: "codex"
      },
      "2026-04-18T00:00:11Z"
    );
    expect(service.getSnapshot().sessions.find((session) => session.sessionId === "session-1"))
      .toMatchObject({
        status: "awaiting_approval"
      });

    applyRuntimeEvent(
      {
        type: "approval.requested",
        sessionId: "session-1",
        turnId: "turn-2",
        requestId: "approval-approve",
        approvalKind: "tool",
        title: "Need permission again",
        engineId: "codex"
      },
      "2026-04-18T00:00:12Z"
    );
    applyRuntimeEvent(
      {
        type: "approval.resolved",
        sessionId: "session-1",
        turnId: "turn-2",
        requestId: "approval-approve",
        action: "approve",
        engineId: "codex"
      },
      "2026-04-18T00:00:13Z"
    );
    expect(service.getSnapshot().sessions.find((session) => session.sessionId === "session-1"))
      .toMatchObject({
        status: "awaiting_approval"
      });

    applyRuntimeEvent(
      {
        type: "session.updated",
        conversationId: "conversation-main",
        sessionId: "session-1",
        status: "running"
      },
      "2026-04-18T00:00:14Z"
    );

    expect(service.getSnapshot().sessions.find((session) => session.sessionId === "session-1"))
      .toMatchObject({
        status: "running"
      });
  });

  it("stores a single markdown block per message in runtime snapshots", async () => {
    const service = createService();
    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-main"
      }
    });

    const applyRuntimeEvent = (
      service as unknown as {
        applyRuntimeEvent: (event: unknown, occurredAt?: string) => void;
      }
    ).applyRuntimeEvent.bind(service);

    applyRuntimeEvent(
      {
        type: "message.started",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        role: "assistant",
        engineId: "codex"
      },
      "2026-04-18T00:00:20Z"
    );
    applyRuntimeEvent(
      {
        type: "message.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "hello",
        engineId: "codex"
      },
      "2026-04-18T00:00:21Z"
    );
    applyRuntimeEvent(
      {
        type: "message.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        engineId: "codex"
      },
      "2026-04-18T00:00:22Z"
    );

    expect(service.getSnapshot().messageBlocks).toEqual([
      expect.objectContaining({
        blockId: "message-1:md",
        text: "hello"
      })
    ]);
  });

  it("reconciles assistant message text from message.completed finalText", async () => {
    const service = createService();
    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-main"
      }
    });

    const applyRuntimeEvent = (
      service as unknown as {
        applyRuntimeEvent: (event: unknown, occurredAt?: string) => void;
      }
    ).applyRuntimeEvent.bind(service);

    applyRuntimeEvent(
      {
        type: "message.started",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        role: "assistant",
        engineId: "codex"
      },
      "2026-04-18T00:00:20Z"
    );
    applyRuntimeEvent(
      {
        type: "message.delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "更精确的。验证",
        engineId: "codex"
      },
      "2026-04-18T00:00:21Z"
    );
    applyRuntimeEvent(
      {
        type: "message.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        finalText: "更精确的验证。",
        engineId: "codex"
      },
      "2026-04-18T00:00:22Z"
    );

    expect(service.getSnapshot().messageBlocks).toEqual([
      expect.objectContaining({
        blockId: "message-1:md",
        text: "更精确的验证。"
      })
    ]);
  });

  it("converts runtime errors into visible failed turn content", async () => {
    const service = createService();
    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-main"
      }
    });

    const applyRuntimeEvent = (
      service as unknown as {
        applyRuntimeEvent: (event: unknown, occurredAt?: string) => void;
      }
    ).applyRuntimeEvent.bind(service);

    applyRuntimeEvent(
      {
        type: "turn.started",
        sessionId: "session-1",
        turnId: "turn-err"
      },
      "2026-04-18T00:00:20Z"
    );
    applyRuntimeEvent(
      {
        type: "message.started",
        sessionId: "session-1",
        turnId: "turn-err",
        messageId: "message-err",
        role: "assistant",
        engineId: "codex"
      },
      "2026-04-18T00:00:21Z"
    );
    applyRuntimeEvent(
      {
        type: "runtime.error",
        sessionId: "session-1",
        turnId: "turn-err",
        code: "CODEX_APP_SERVER_ERROR",
        message: "Boom",
        recoverable: false
      },
      "2026-04-18T00:00:22Z"
    );

    const snapshot = service.getSnapshot();
    expect(snapshot.sessions.find((session) => session.sessionId === "session-1")).toMatchObject({
      status: "error",
      lastTurnId: "turn-err"
    });
    expect(snapshot.turns.find((turn) => turn.turnId === "turn-err")).toMatchObject({
      status: "completed",
      finishReason: "failed"
    });
    expect(snapshot.messageBlocks.find((block) => block.blockId === "message-err:md")).toMatchObject({
      role: "system",
      text: "Runtime error (CODEX_APP_SERVER_ERROR): Boom"
    });
  });
});
