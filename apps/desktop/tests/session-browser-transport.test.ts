import { describe, expect, it, vi } from "vitest";
import type {
  WorkbenchClientApi,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import { createDesktopTransport } from "../src/transport/desktop-transport.js";

type PreloadMock = {
  api: WorkbenchClientApi;
  request: ReturnType<typeof vi.fn>;
};

const createPreloadMock = (
  onRequest: (request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>
): PreloadMock => {
  const request = vi.fn(onRequest);
  return {
    api: {
      request,
      subscribe: vi.fn(async () => ({
        subscriptionId: "sub-1",
        unsubscribe: async () => {}
      }))
    } satisfies WorkbenchClientApi,
    request
  };
};

describe("session browser transport contracts", () => {
  it("wires workspace + session tree operations through typed rpc methods", async () => {
    const preload = createPreloadMock(async (request) => {
      switch (request.method) {
        case "workspace.pickDirectory":
          return {
            id: request.id,
            method: "workspace.pickDirectory",
            ok: true,
            result: {
              canceled: false,
              rootPath: "I:\\repo-a"
            }
          } as const;
        case "workspace.select":
          return {
            id: request.id,
            method: "workspace.select",
            ok: true,
            result: {
              workspaceId: request.params.workspaceId,
              activeSessionId: "session-root"
            }
          } as const;
        case "workspace.toggleExpanded":
          return {
            id: request.id,
            method: "workspace.toggleExpanded",
            ok: true,
            result: {
              workspaceId: request.params.workspaceId,
              expanded: true
            }
          } as const;
        case "workspace.remove":
          return {
            id: request.id,
            method: "workspace.remove",
            ok: true,
            result: {
              workspaceId: request.params.workspaceId,
              removed: true
            }
          } as const;
        case "sessionBrowser.listTree":
          expect(request.params.workspaceId).toBe("workspace-1");
          return {
            id: request.id,
            method: "sessionBrowser.listTree",
            ok: true,
            result: {
              workspaces: [
                {
                  workspaceId: "workspace-1",
                  label: "Workspace 1",
                  rootPath: "I:\\repo-a",
                  isExpanded: true,
                  isActive: true,
                  sessions: [
                    {
                      sessionId: "session-root",
                      displaySessionId: "thread-root",
                      providerSessionId: "thread-root",
                      workspaceId: "workspace-1",
                      agentId: "agent-codex",
                      title: "Root Session",
                      statusDot: "running",
                      isExpanded: true,
                      isActive: true,
                      isArchived: false,
                      updatedAt: "2026-04-18T00:00:00.000Z",
                      children: [
                        {
                          sessionId: "session-child",
                          displaySessionId: "thread-child",
                          providerSessionId: "thread-child",
                          workspaceId: "workspace-1",
                          agentId: "agent-codex",
                          title: "Child Session",
                          statusDot: "unread_completed",
                          isExpanded: false,
                          isActive: false,
                          isArchived: false,
                          parentSessionId: "session-root",
                          updatedAt: "2026-04-18T00:01:00.000Z",
                          children: []
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          } as const;
        case "sessionBrowser.reconcile":
          expect(request.params.workspaceId).toBe("workspace-1");
          return {
            id: request.id,
            method: "sessionBrowser.reconcile",
            ok: true,
            result: {
              workspaces: 1,
              sessions: 2,
              relations: 1
            }
          } as const;
        case "sessionBrowser.open":
          return {
            id: request.id,
            method: "sessionBrowser.open",
            ok: true,
            result: {
              page: {
                sessionId: request.params.sessionId,
                snapshot: {
                  conversations: [],
                  sessions: [],
                  turns: [],
                  messageBlocks: [],
                  toolCalls: [],
                  terminalStreams: [],
                  approvalRequests: [],
                  participants: [],
                  sessionRelations: []
                },
                windowStartTurnId: "turn-2",
                windowEndTurnId: "turn-3",
                hasOlder: true,
                hasNewer: false
              }
            }
          } as const;
        case "sessionBrowser.loadOlder":
          return {
            id: request.id,
            method: "sessionBrowser.loadOlder",
            ok: true,
            result: {
              page: {
                sessionId: request.params.sessionId,
                snapshot: {
                  conversations: [],
                  sessions: [],
                  turns: [],
                  messageBlocks: [],
                  toolCalls: [],
                  terminalStreams: [],
                  approvalRequests: [],
                  participants: [],
                  sessionRelations: []
                },
                windowStartTurnId: "turn-1",
                windowEndTurnId: "turn-2",
                hasOlder: false,
                hasNewer: true
              }
            }
          } as const;
        case "sessionBrowser.toggleExpanded":
          return {
            id: request.id,
            method: "sessionBrowser.toggleExpanded",
            ok: true,
            result: {
              sessionId: request.params.sessionId,
              expanded: false
            }
          } as const;
        case "sessionBrowser.create":
          return {
            id: request.id,
            method: "sessionBrowser.create",
            ok: true,
            result: {
              sessionId: "session-new",
              conversationId: "conversation-new"
            }
          } as const;
        default:
          throw new Error(`Unexpected method: ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api);

    const pickedWorkspace = await transport.workspace.pickDirectory();
    const workspaceSelection = await transport.workspace.select("workspace-1");
    const workspaceToggle = await transport.workspace.toggleExpanded("workspace-1");
    const workspaceRemoval = await transport.workspace.remove({
      workspaceId: "workspace-1"
    });
    const tree = await transport.sessionBrowser.listTree("workspace-1");
    const reconcile = await transport.sessionBrowser.reconcile("workspace-1");
    const openResult = await transport.sessionBrowser.open("session-child");
    const olderPage = await transport.sessionBrowser.loadOlder({
      sessionId: "session-child",
      beforeTurnId: "turn-2",
      limit: 8
    });
    const sessionToggle = await transport.sessionBrowser.toggleExpanded("session-root");
    const createResult = await transport.sessionBrowser.create({
      workspaceId: "workspace-1",
      agentId: "agent-codex"
    });

    expect(pickedWorkspace).toEqual({
      canceled: false,
      rootPath: "I:\\repo-a"
    });
    expect(workspaceSelection).toEqual({
      workspaceId: "workspace-1",
      activeSessionId: "session-root"
    });
    expect(workspaceToggle).toEqual({
      workspaceId: "workspace-1",
      expanded: true
    });
    expect(workspaceRemoval).toEqual({
      workspaceId: "workspace-1",
      removed: true
    });
    expect(tree.workspaces[0]?.sessions[0]?.children[0]?.sessionId).toBe("session-child");
    expect(reconcile).toEqual({
      workspaces: 1,
      sessions: 2,
      relations: 1
    });
    expect(openResult).toEqual({
      page: expect.objectContaining({
        sessionId: "session-child",
        windowStartTurnId: "turn-2",
        windowEndTurnId: "turn-3",
        hasOlder: true,
        hasNewer: false
      })
    });
    expect(olderPage).toEqual({
      page: expect.objectContaining({
        sessionId: "session-child",
        windowStartTurnId: "turn-1",
        windowEndTurnId: "turn-2",
        hasOlder: false,
        hasNewer: true
      })
    });
    expect(sessionToggle).toEqual({
      sessionId: "session-root",
      expanded: false
    });
    expect(createResult).toEqual({
      sessionId: "session-new",
      conversationId: "conversation-new"
    });

    const methods = preload.request.mock.calls.map(
      ([request]) => (request as WorkbenchRpcRequest).method
    );
    expect(methods).toEqual([
      "workspace.pickDirectory",
      "workspace.select",
      "workspace.toggleExpanded",
      "workspace.remove",
      "sessionBrowser.listTree",
      "sessionBrowser.reconcile",
      "sessionBrowser.open",
      "sessionBrowser.loadOlder",
      "sessionBrowser.toggleExpanded",
      "sessionBrowser.create"
    ]);
  });

  it("routes right-click action discovery and execution via sessionBrowser actions APIs", async () => {
    const preload = createPreloadMock(async (request) => {
      if (request.method === "sessionBrowser.getActions") {
        return {
          id: request.id,
          method: "sessionBrowser.getActions",
          ok: true,
          result: {
            actions: [
              {
                action: "archive",
                label: "Archive"
              },
              {
                action: "copy_session_id",
                label: "Copy session ID"
              },
              {
                action: "open_rollout",
                label: "Open rollout"
              },
              {
                action: "reload",
                label: "Reload",
                disabled: true,
                reason: "Session is already running"
              }
            ]
          }
        } as const;
      }
      if (request.method === "sessionBrowser.runAction") {
        switch (request.params.action) {
          case "archive":
            return {
              id: request.id,
              method: "sessionBrowser.runAction",
              ok: true,
              result: {
                action: "archive",
                archived: true
              }
            } as const;
          case "copy_session_id":
            return {
              id: request.id,
              method: "sessionBrowser.runAction",
              ok: true,
              result: {
                action: "copy_session_id",
                copiedText: request.params.sessionId
              }
            } as const;
          case "open_rollout":
            return {
              id: request.id,
              method: "sessionBrowser.runAction",
              ok: true,
              result: {
                action: "open_rollout",
                rolloutPath: "I:\\logs\\session-1.md",
                rolloutDisplayPath: "I:\\logs\\session-1.md",
                rolloutFileUrl: "file:///I:/logs/session-1.md"
              }
            } as const;
          case "reload":
            return {
              id: request.id,
              method: "sessionBrowser.runAction",
              ok: true,
              result: {
                action: "reload",
                resumed: true
              }
            } as const;
          default:
            throw new Error(`Unexpected action: ${request.params.action satisfies never}`);
        }
      }
      throw new Error(`Unexpected method: ${request.method}`);
    });
    const transport = createDesktopTransport(preload.api);

    const actions = await transport.sessionBrowser.getActions("session-1");
    const archive = await transport.sessionBrowser.runAction({
      sessionId: "session-1",
      action: "archive"
    });
    const copySessionId = await transport.sessionBrowser.runAction({
      sessionId: "session-1",
      action: "copy_session_id"
    });
    const openRollout = await transport.sessionBrowser.runAction({
      sessionId: "session-1",
      action: "open_rollout"
    });
    const reload = await transport.sessionBrowser.runAction({
      sessionId: "session-1",
      action: "reload"
    });

    expect(actions.actions.map((action) => action.action)).toEqual([
      "archive",
      "copy_session_id",
      "open_rollout",
      "reload"
    ]);
    expect(actions.actions.at(-1)).toMatchObject({
      action: "reload",
      disabled: true,
      reason: "Session is already running"
    });

    expect(archive).toEqual({
      action: "archive",
      archived: true
    });
    expect(copySessionId).toEqual({
      action: "copy_session_id",
      copiedText: "session-1"
    });
    expect(openRollout).toEqual({
      action: "open_rollout",
      rolloutPath: "I:\\logs\\session-1.md",
      rolloutDisplayPath: "I:\\logs\\session-1.md",
      rolloutFileUrl: "file:///I:/logs/session-1.md"
    });
    expect(reload).toEqual({
      action: "reload",
      resumed: true
    });

    const runActionRequests = preload.request.mock.calls
      .map(([request]) => request as WorkbenchRpcRequest)
      .filter((request) => request.method === "sessionBrowser.runAction");
    expect(runActionRequests.map((request) => request.params.action)).toEqual([
      "archive",
      "copy_session_id",
      "open_rollout",
      "reload"
    ]);
  });

  it("reads worktree, checkpoint, diagnostics, and background-run summaries through typed rpc methods", async () => {
    const preload = createPreloadMock(async (request) => {
      switch (request.method) {
        case "worktree.get":
          return {
            id: request.id,
            method: "worktree.get",
            ok: true,
            result: {
              worktree: {
                sessionId: request.params.sessionId,
                agentId: "codex",
                supported: true,
                workspaceRoot: "I:\\repo-a",
                gitBranch: "main",
                gitSha: "abc123",
                fetchedAt: "2026-04-20T00:00:00.000Z"
              }
            }
          } as const;
        case "checkpoint.get":
          return {
            id: request.id,
            method: "checkpoint.get",
            ok: true,
            result: {
              checkpoint: {
                sessionId: request.params.sessionId,
                agentId: "codex",
                supported: true,
                supportsRestore: true,
                currentCheckpointId: "node-1",
                checkpoints: [
                  {
                    checkpointId: "node-1",
                    label: "Checkpoint 1",
                    order: 0,
                    isCurrent: true
                  }
                ],
                fetchedAt: "2026-04-20T00:00:00.000Z"
              }
            }
          } as const;
        case "diagnostics.get":
          return {
            id: request.id,
            method: "diagnostics.get",
            ok: true,
            result: {
              diagnostics: {
                sessionId: request.params.sessionId,
                agentId: "codex",
                supported: true,
                authenticated: true,
                authMethod: "chatgpt",
                summaryText: "auth=chatgpt",
                fetchedAt: "2026-04-20T00:00:00.000Z"
              }
            }
          } as const;
        case "backgroundRun.get":
          return {
            id: request.id,
            method: "backgroundRun.get",
            ok: true,
            result: {
              backgroundRun: {
                sessionId: request.params.sessionId,
                agentId: "codex",
                supported: false,
                status: "unsupported",
                fetchedAt: "2026-04-20T00:00:00.000Z"
              }
            }
          } as const;
        default:
          throw new Error(`Unexpected method: ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api);

    const worktree = await transport.worktree.get("session-1");
    const checkpoint = await transport.checkpoint.get("session-1");
    const diagnostics = await transport.diagnostics.get("session-1");
    const backgroundRun = await transport.backgroundRun.get("session-1");

    expect(worktree).toMatchObject({
      workspaceRoot: "I:\\repo-a",
      gitBranch: "main"
    });
    expect(checkpoint.currentCheckpointId).toBe("node-1");
    expect(diagnostics.authenticated).toBe(true);
    expect(backgroundRun.status).toBe("unsupported");
  });
});
