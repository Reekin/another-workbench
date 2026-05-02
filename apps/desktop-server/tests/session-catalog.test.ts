import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainSnapshot } from "@another-workbench/shared";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCatalogService } from "../src/session-catalog.js";
import { SessionIndexStore } from "../src/session-index.js";
import type { WorkbenchRuntimeService } from "../src/runtime-service.js";
import { WorkspaceRegistryService } from "../src/workspace-registry.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-session-catalog-"));
  tempDirs.push(dir);
  return dir;
};

const emptySnapshot = (): DomainSnapshot => ({
  conversations: [],
  sessions: [],
  turns: [],
  messageBlocks: [],
  toolCalls: [],
  terminalStreams: [],
  approvalRequests: [],
  participants: [],
  sessionRelations: []
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SessionCatalogService", () => {
  it("merges runtime and index state into workspace trees with relation nesting and status dots", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });

    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha",
      label: "Alpha"
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-2",
      absolutePath: "I:/workspace-beta",
      label: "Beta"
    });
    await workspaceRegistry.setWorkspaceExpanded("workspace-1", true);
    await workspaceRegistry.setSessionExpanded("session-root", true);
    await workspaceRegistry.setLastActiveSelection({
      workspaceId: "workspace-1",
      sessionId: "session-child"
    });

    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-root",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Index Root",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      providerSessionId: "thread-root",
      summaryText: "summary from index",
      unreadState: "unread_completed"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-archived",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Archived Session",
        createdAt: "2026-04-18T00:00:03Z",
        updatedAt: "2026-04-18T00:00:04Z",
        archivedAt: "2026-04-18T00:00:04Z"
      },
      unreadState: "read"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-2",
      session: {
        sessionId: "session-beta",
        conversationId: "conversation-2",
        engineId: "acp",
        title: "Beta Session",
        createdAt: "2026-04-18T00:00:05Z",
        updatedAt: "2026-04-18T00:00:06Z"
      },
      unreadState: "read"
    });
    await indexStore.upsertRelation({
      workspaceId: "workspace-1",
      parentSessionId: "session-root",
      childSessionId: "session-child",
      relationType: "fork",
      createdAt: "2026-04-18T00:00:07Z"
    });

    const snapshot: DomainSnapshot = {
      ...emptySnapshot(),
      conversations: [
        {
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          participantEngineIds: ["codex"],
          activeSessionId: "session-root",
          sessionIds: ["session-root", "session-child"],
          createdAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:10Z"
        },
        {
          conversationId: "conversation-2",
          workspaceId: "workspace-2",
          participantEngineIds: ["acp"],
          activeSessionId: "session-beta",
          sessionIds: ["session-beta"],
          createdAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:11Z"
        }
      ],
      sessions: [
        {
          sessionId: "session-root",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          title: "Runtime Root",
          createdAt: "2026-04-18T00:00:01Z",
          updatedAt: "2026-04-18T00:00:12Z"
        },
        {
          sessionId: "session-child",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "running",
          title: "Runtime Child",
          createdAt: "2026-04-18T00:00:08Z",
          updatedAt: "2026-04-18T00:00:11Z"
        },
        {
          sessionId: "session-beta",
          conversationId: "conversation-2",
          engineId: "acp",
          status: "completed",
          title: "Runtime Beta",
          createdAt: "2026-04-18T00:00:05Z",
          updatedAt: "2026-04-18T00:00:10Z"
        }
      ],
      sessionRelations: [
        {
          relationId: "relation-1",
          parentSessionId: "session-root",
          childSessionId: "session-child",
          relationType: "fork",
          createdAt: "2026-04-18T00:00:07Z"
        }
      ]
    };
    const runtimeService = {
      getSnapshot: () => snapshot
    } as unknown as WorkbenchRuntimeService;

    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const tree = await service.listWorkspaceTree();
    const alphaWorkspace = tree.find((item) => item.workspaceId === "workspace-1");
    const betaWorkspace = tree.find((item) => item.workspaceId === "workspace-2");

    expect(alphaWorkspace).toMatchObject({
      workspaceId: "workspace-1",
      label: "Alpha",
      isExpanded: true,
      isActive: true
    });
    expect(alphaWorkspace?.sessions.map((item) => item.sessionId)).toEqual([
      "session-root"
    ]);

    const rootNode = alphaWorkspace?.sessions[0];
    expect(rootNode).toMatchObject({
      sessionId: "session-root",
      displaySessionId: "thread-root",
      providerSessionId: "thread-root",
      title: "Runtime Root",
      summaryText: "summary from index",
      statusDot: "unread_completed",
      isExpanded: true,
      isActive: false,
      isArchived: false
    });
    expect(rootNode?.children).toHaveLength(1);
    expect(rootNode?.children[0]).toMatchObject({
      sessionId: "session-child",
      parentSessionId: "session-root",
      statusDot: "running",
      isActive: true
    });
    expect(betaWorkspace).toMatchObject({
      workspaceId: "workspace-2",
      isActive: false
    });
    expect(betaWorkspace?.sessions[0]).toMatchObject({
      sessionId: "session-beta",
      displaySessionId: "session-beta",
      statusDot: "none"
    });
    expect(
      alphaWorkspace?.sessions.some((item) => item.sessionId === "session-archived")
    ).toBe(false);
  });

  it("marks unread sessions as read through the backing index store", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      unreadState: "unread_completed"
    });

    const runtimeService = {
      getSnapshot: () => ({
        ...emptySnapshot(),
        conversations: [
          {
            conversationId: "conversation-1",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "codex",
            status: "idle",
            createdAt: "2026-04-18T00:00:01Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        ]
      })
    } as unknown as WorkbenchRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    await service.markSessionRead("session-1");

    expect(indexStore.getEntry("session-1")?.unreadState).toBe("read");
  });

  it("orders sessions by last completed turn time instead of latest update time", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });

    const runtimeService = {
      getSnapshot: () => ({
        ...emptySnapshot(),
        conversations: [
          {
            conversationId: "conversation-old",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-old",
            sessionIds: ["session-old"],
            createdAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:30:00Z"
          },
          {
            conversationId: "conversation-new",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-new",
            sessionIds: ["session-new"],
            createdAt: "2026-04-18T00:10:00Z",
            updatedAt: "2026-04-18T00:10:01Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-old",
            conversationId: "conversation-old",
            engineId: "codex",
            status: "running",
            title: "Old running session",
            createdAt: "2026-04-18T00:00:01Z",
            updatedAt: "2026-04-18T00:30:00Z"
          },
          {
            sessionId: "session-new",
            conversationId: "conversation-new",
            engineId: "codex",
            status: "idle",
            title: "New completed session",
            createdAt: "2026-04-18T00:10:00Z",
            updatedAt: "2026-04-18T00:10:01Z"
          }
        ],
        turns: [
          {
            turnId: "turn-old-completed",
            sessionId: "session-old",
            status: "completed",
            startedAt: "2026-04-18T00:04:00Z",
            completedAt: "2026-04-18T00:05:00Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          },
          {
            turnId: "turn-old-running",
            sessionId: "session-old",
            status: "streaming",
            startedAt: "2026-04-18T00:20:00Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          },
          {
            turnId: "turn-new-completed",
            sessionId: "session-new",
            status: "completed",
            startedAt: "2026-04-18T00:14:00Z",
            completedAt: "2026-04-18T00:15:00Z",
            messageIds: [],
            toolCallIds: [],
            terminalIds: [],
            approvalRequestIds: []
          }
        ]
      })
    } as unknown as WorkbenchRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const tree = await service.listWorkspaceTree("workspace-1");

    expect(tree[0]?.sessions.map((item) => item.sessionId)).toEqual([
      "session-new",
      "session-old"
    ]);
  });

  it("does not expose an unread dot for the active session", async () => {
    const baseDir = await createTempDir();
    const workspaceRegistry = new WorkspaceRegistryService({
      baseDir
    });
    const indexStore = new SessionIndexStore({
      baseDir
    });
    await workspaceRegistry.registerWorkspace({
      workspaceId: "workspace-1",
      absolutePath: "I:/workspace-alpha"
    });
    await workspaceRegistry.setLastActiveSelection({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    await indexStore.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      unreadState: "unread_completed"
    });

    const runtimeService = {
      getSnapshot: () => ({
        ...emptySnapshot(),
        conversations: [
          {
            conversationId: "conversation-1",
            workspaceId: "workspace-1",
            participantEngineIds: ["codex"],
            activeSessionId: "session-1",
            sessionIds: ["session-1"],
            createdAt: "2026-04-18T00:00:00Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        ],
        sessions: [
          {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "codex",
            status: "idle",
            createdAt: "2026-04-18T00:00:01Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        ]
      })
    } as unknown as WorkbenchRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    const tree = await service.listWorkspaceTree("workspace-1");

    expect(tree[0]?.sessions[0]).toMatchObject({
      sessionId: "session-1",
      isActive: true,
      statusDot: "none"
    });
  });
});
