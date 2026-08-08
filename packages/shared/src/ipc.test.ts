import { describe, expect, it } from "vitest";
import type { SessionBrowserNodeRpc, WorkspaceBrowserNodeRpc } from "./ipc.js";
import { parseWorkbenchRpcRequest, safeParseWorkbenchRpcResponse } from "./ipc.js";

describe("IPC schemas", () => {
  it("parses recursive session browser nodes with typed child defaults", () => {
    const child: SessionBrowserNodeRpc = {
      sessionId: "session-child",
      displaySessionId: "thread-child",
      providerSessionId: "thread-child",
      providerHandle: {
        providerKind: "codex-thread",
        providerSessionId: "thread-child"
      },
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      engineId: "codex",
      title: "Child",
      statusDot: "none",
      isExpanded: false,
      isActive: false,
      isArchived: false,
      parentSessionId: "session-root",
      children: [],
      updatedAt: "2026-06-24T00:00:00.000Z"
    };
    const workspace: WorkspaceBrowserNodeRpc = {
      workspaceId: "workspace-1",
      label: "Repo",
      rootPath: "I:\\repo",
      isExpanded: true,
      isActive: true,
      sessions: [
        {
          sessionId: "session-root",
          displaySessionId: "thread-root",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          engineId: "codex",
          title: "Root",
          statusDot: "running",
          isExpanded: true,
          isActive: true,
          isArchived: false,
          children: [child],
          updatedAt: "2026-06-24T00:00:00.000Z"
        }
      ]
    };

    const parsed = safeParseWorkbenchRpcResponse({
      id: "req-tree",
      method: "sessionBrowser.listTree",
      ok: true,
      result: {
        workspaces: [
          {
            ...workspace,
            sessions: [
              {
                ...workspace.sessions[0],
                children: [
                  {
                    ...child,
                    children: undefined
                  }
                ]
              }
            ]
          }
        ]
      }
    });

    expect(parsed.success).toBe(true);
    if (
      !parsed.success ||
      !parsed.data.ok ||
      parsed.data.method !== "sessionBrowser.listTree"
    ) {
      return;
    }
    expect(parsed.data.result.workspaces[0]?.sessions[0]?.children[0]).toMatchObject({
      sessionId: "session-child",
      children: []
    });
  });

  it("parses bounded session browser pages without transcript metadata", () => {
    const request = parseWorkbenchRpcRequest({
      id: "req-roots",
      method: "sessionBrowser.listRoots",
      params: { workspaceId: "workspace-1" }
    });
    expect(request.params).toMatchObject({ limit: 20 });

    const parsed = safeParseWorkbenchRpcResponse({
      id: "req-roots",
      method: "sessionBrowser.listRoots",
      ok: true,
      result: {
        workspaceId: "workspace-1",
        revision: "revision-1",
        items: [{
          sessionId: "session-1",
          engineId: "codex",
          title: "Session",
          statusDot: "none",
          isActive: true,
          isExpanded: false,
          childCount: 2
        }],
        hasMore: false,
        totalCount: 1
      }
    });
    expect(parsed.success).toBe(true);
  });

  it("parses persisted workspace expansion state", () => {
    const parsed = safeParseWorkbenchRpcResponse({
      id: "req-workspaces",
      method: "workspace.list",
      ok: true,
      result: {
        workspaces: [],
        lastActiveWorkspaceId: "workspace-1",
        expandedWorkspaceIds: ["workspace-1", "workspace-2"]
      }
    });

    expect(parsed.success).toBe(true);
  });

  it("requires an explicit non-empty workspace batch for repair", () => {
    expect(
      parseWorkbenchRpcRequest({
        id: "req-repair",
        method: "sessionBrowser.repair",
        params: { workspaceIds: ["workspace-1", "workspace-2"] }
      }).params
    ).toEqual({ workspaceIds: ["workspace-1", "workspace-2"] });

    expect(() =>
      parseWorkbenchRpcRequest({
        id: "req-repair-missing",
        method: "sessionBrowser.repair",
        params: {}
      })
    ).toThrow();
    expect(() =>
      parseWorkbenchRpcRequest({
        id: "req-repair-empty",
        method: "sessionBrowser.repair",
        params: { workspaceIds: [] }
      })
    ).toThrow();
    expect(() =>
      parseWorkbenchRpcRequest({
        id: "req-repair-legacy",
        method: "sessionBrowser.repair",
        params: { workspaceId: "workspace-1" }
      })
    ).toThrow();
    expect(() =>
      parseWorkbenchRpcRequest({
        id: "req-reconcile-removed",
        method: "sessionBrowser.reconcile",
        params: { workspaceIds: ["workspace-1"] }
      })
    ).toThrow();
  });
});
