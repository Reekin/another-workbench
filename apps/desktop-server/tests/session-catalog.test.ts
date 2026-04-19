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
        agentId: "codex",
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
        agentId: "codex",
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
        agentId: "acp",
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
          participantAgentIds: ["codex"],
          activeSessionId: "session-root",
          sessionIds: ["session-root", "session-child"],
          createdAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:10Z"
        },
        {
          conversationId: "conversation-2",
          workspaceId: "workspace-2",
          participantAgentIds: ["acp"],
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
          agentId: "codex",
          status: "idle",
          title: "Runtime Root",
          createdAt: "2026-04-18T00:00:01Z",
          updatedAt: "2026-04-18T00:00:12Z"
        },
        {
          sessionId: "session-child",
          conversationId: "conversation-1",
          agentId: "codex",
          status: "running",
          title: "Runtime Child",
          createdAt: "2026-04-18T00:00:08Z",
          updatedAt: "2026-04-18T00:00:11Z"
        },
        {
          sessionId: "session-beta",
          conversationId: "conversation-2",
          agentId: "acp",
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
        agentId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      unreadState: "unread_completed"
    });

    const runtimeService = {
      getSnapshot: () => emptySnapshot()
    } as unknown as WorkbenchRuntimeService;
    const service = new SessionCatalogService({
      runtimeService,
      workspaceRegistry,
      sessionIndexStore: indexStore
    });

    await service.markSessionRead("session-1");

    expect(indexStore.getEntry("session-1")?.unreadState).toBe("read");
  });
});
