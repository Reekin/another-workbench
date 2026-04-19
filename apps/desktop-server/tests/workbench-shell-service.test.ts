import { describe, expect, it, vi } from "vitest";
import { WorkbenchShellService } from "../src/workbench-shell-service.js";

describe("WorkbenchShellService", () => {
  it("delegates workspace directory picking to the host callback when available", async () => {
    const pickWorkspaceDirectory = vi.fn().mockResolvedValue({
      canceled: false,
      rootPath: "I:\\repo"
    });
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      pickWorkspaceDirectory
    });

    await expect(service.pickWorkspaceDirectory()).resolves.toEqual({
      canceled: false,
      rootPath: "I:\\repo"
    });
    expect(pickWorkspaceDirectory).toHaveBeenCalledTimes(1);
  });

  it("removes workspaces from both registry and persisted session index", async () => {
    const removeWorkspace = vi.fn().mockResolvedValue(true);
    const removeIndexedWorkspace = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        getWorkspaceRegistry: () => ({
          removeWorkspace
        }),
        getSessionIndexStore: () => ({
          removeWorkspace: removeIndexedWorkspace
        })
      } as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.removeWorkspace("workspace-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      removed: true
    });
    expect(removeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(removeIndexedWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("marks a session as active and read when opening it from the browser tree", async () => {
    const setLastActiveSelection = vi.fn().mockResolvedValue(undefined);
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const ensureSessionLoaded = vi.fn().mockResolvedValue(true);
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [
          {
            sessionId: "session-1"
          }
        ],
        getWorkspaceRegistry: () => ({
          setLastActiveSelection
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-1",
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });

    await expect(service.openSession("session-1")).resolves.toEqual({
      sessionId: "session-1"
    });
    expect(ensureSessionLoaded).toHaveBeenCalledWith("session-1");
    expect(setLastActiveSelection).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-1"
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-1");
  });

  it("creates browser sessions through the runtime service and returns the concrete session id", async () => {
    const createSession = vi.fn().mockResolvedValue({
      sessionId: "session-new",
      conversationId: "conversation-new"
    });
    const markSessionRead = vi.fn().mockResolvedValue(undefined);
    const service = new WorkbenchShellService({
      runtimeService: {
        createSession
      } as never,
      sessionCatalog: {
        markSessionRead
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(
      service.createBrowserSession({
        workspaceId: "workspace-1",
        agentId: "codex"
      })
    ).resolves.toEqual({
      sessionId: "session-new",
      conversationId: "conversation-new"
    });
    expect(createSession).toHaveBeenCalledWith({
      type: "createSession",
      workspaceId: "workspace-1",
      agentId: "codex",
      conversationId: undefined,
      metadata: undefined
    });
    expect(markSessionRead).toHaveBeenCalledWith("session-new");
  });

  it("rejects opening a stale session entry that has no loadable provider identity", async () => {
    const ensureSessionLoaded = vi.fn().mockResolvedValue(false);
    const service = new WorkbenchShellService({
      runtimeService: {
        listSessions: () => [],
        getWorkspaceRegistry: () => ({
          setLastActiveSelection: vi.fn()
        }),
        getSessionIndexStore: () => ({
          getEntry: () => ({
            sessionId: "session-legacy",
            workspaceId: "workspace-1"
          })
        })
      } as never,
      sessionCatalog: {
        markSessionRead: vi.fn()
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        ensureSessionLoaded
      } as never
    });

    await expect(service.openSession("session-legacy")).rejects.toThrow(
      "This session does not expose a loadable provider session id."
    );
  });

  it("passes workspace filters through to the session catalog", async () => {
    const listWorkspaceTree = vi
      .fn()
      .mockResolvedValue([{ workspaceId: "workspace-1", sessions: [] }]);
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {
        listWorkspaceTree
      } as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never
    });

    await expect(service.listSessionTree("workspace-1")).resolves.toEqual({
      workspaces: [{ workspaceId: "workspace-1", sessions: [] }]
    });
    expect(listWorkspaceTree).toHaveBeenCalledWith("workspace-1");
  });

  it("forwards explicit reconcile requests to the session reconciliation service", async () => {
    const reconcileWorkspace = vi.fn().mockResolvedValue({
      workspaces: 1,
      sessions: 3,
      relations: 1
    });
    const service = new WorkbenchShellService({
      runtimeService: {} as never,
      sessionCatalog: {} as never,
      sessionActions: {} as never,
      chatTreeProvider: {} as never,
      sessionReconciliation: {
        reconcileWorkspace
      } as never
    });

    await expect(service.reconcileSessionBrowser("workspace-1")).resolves.toEqual({
      workspaces: 1,
      sessions: 3,
      relations: 1
    });
    expect(reconcileWorkspace).toHaveBeenCalledWith("workspace-1");
  });
});
