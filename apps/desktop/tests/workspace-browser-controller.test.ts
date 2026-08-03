import { describe, expect, it, vi } from "vitest";
import type {
  SessionBrowserItemRpc,
  SessionBrowserPageRpc
} from "@another-workbench/shared";
import type { SessionBrowserViewNode } from "../src/ui/chat-shell/workspace-browser-tree.js";
import {
  collectExpandedLoadedSessionIds,
  loadCachedThenReconcileWorkspaces,
  loadPersistedExpandedChildren,
  projectSessionBrowserLoading,
  resolveStartupWorkspaceIds,
  resolveWorkspaceRefreshTargetIds,
  runSessionExpansionEffects,
  runWorkspaceExpansionEffects,
  shouldMergeFocusedSessionPath,
  toggleSessionTreeNode
} from "../src/ui/chat-shell/use-workspace-browser-controller.js";
import { SessionBrowserQueryCoordinator } from "../src/ui/chat-shell/session-browser-query-coordinator.js";
import {
  applyRootPage,
  mergeWorkspaceBrowserState
} from "../src/ui/chat-shell/workspace-browser-tree.js";

describe("workspace browser controller operations", () => {
  it("uses persisted expanded workspaces as the startup discovery scope", () => {
    expect(
      resolveStartupWorkspaceIds({
        expandedWorkspaceIds: ["workspace-a", "workspace-b"],
        lastActiveWorkspaceId: "workspace-c"
      })
    ).toEqual(["workspace-a", "workspace-b"]);
    expect(
      resolveStartupWorkspaceIds({
        expandedWorkspaceIds: [],
        lastActiveWorkspaceId: "workspace-c"
      })
    ).toEqual(["workspace-c"]);
  });

  it("loads cached roots before starting provider reconciliation", async () => {
    const calls: string[] = [];
    await loadCachedThenReconcileWorkspaces({
      workspaceIds: ["workspace-a"],
      loadCached: async (workspaceId) => {
        calls.push(`cache:${workspaceId}`);
      },
      reconcile: async (workspaceIds) => {
        calls.push(`reconcile:${workspaceIds.join(",")}`);
      },
      reload: async (workspaceId) => {
        calls.push(`reload:${workspaceId}`);
      },
      onReconcileError: vi.fn()
    });
    await vi.waitFor(() =>
      expect(calls).toEqual([
        "cache:workspace-a",
        "reconcile:workspace-a",
        "reload:workspace-a"
      ])
    );
  });

  it("starts cached loads independently and reconciles startup workspaces once", async () => {
    let releaseWorkspaceA!: () => void;
    const workspaceACache = new Promise<void>((resolve) => {
      releaseWorkspaceA = resolve;
    });
    const calls: string[] = [];

    const startup = loadCachedThenReconcileWorkspaces({
      workspaceIds: ["workspace-a", "workspace-b"],
      loadCached: async (workspaceId) => {
        calls.push(`cache:${workspaceId}`);
        if (workspaceId === "workspace-a") {
          await workspaceACache;
        }
      },
      reconcile: async (workspaceIds) => {
        calls.push(`reconcile:${workspaceIds.join(",")}`);
      },
      reload: async (workspaceId) => {
        calls.push(`reload:${workspaceId}`);
      },
      onReconcileError: vi.fn()
    });

    await vi.waitFor(() =>
      expect(calls).toEqual([
        "cache:workspace-a",
        "cache:workspace-b",
        "reconcile:workspace-a,workspace-b",
        "reload:workspace-a",
        "reload:workspace-b"
      ])
    );
    releaseWorkspaceA();
    await startup;
  });

  it("keeps cached sessions when provider reconciliation fails", async () => {
    const visibleSessions = ["cached-session"];
    const error = new Error("provider unavailable");
    const onReconcileError = vi.fn();

    await loadCachedThenReconcileWorkspaces({
      workspaceIds: ["workspace-a"],
      loadCached: async () => undefined,
      reconcile: async () => {
        throw error;
      },
      reload: async () => {
        visibleSessions.splice(0);
      },
      onReconcileError
    });
    await vi.waitFor(() => expect(onReconcileError).toHaveBeenCalledWith(error));

    expect(visibleSessions).toEqual(["cached-session"]);
  });

  it("loads persisted expanded children and toggles from the visible state", async () => {
    const persistedExpandedItem = {
      sessionId: "root-expanded",
      engineId: "codex",
      title: "Expanded root",
      statusDot: "none",
      isActive: false,
      isExpanded: true,
      childCount: 1
    } satisfies SessionBrowserItemRpc & { isExpanded: boolean };
    const workspace = applyRootPage(
      mergeWorkspaceBrowserState([], {
        workspaces: [{
          workspaceId: "workspace-1",
          absolutePath: "I:\\repo",
          label: "Repo",
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z"
        }],
        lastActiveWorkspaceId: "workspace-1"
      })[0]!,
      {
        workspaceId: "workspace-1",
        revision: "revision-1",
        items: [persistedExpandedItem],
        hasMore: false,
        totalCount: 1
      },
      0,
      [undefined]
    );
    const loadChildren = vi.fn(async () => undefined);

    await loadPersistedExpandedChildren({
      sessions: workspace.sessions,
      loadChildren
    });
    expect(loadChildren).toHaveBeenCalledWith("root-expanded");

    const collapsed = toggleSessionTreeNode(workspace, "root-expanded");
    expect(collapsed.expanded).toBe(false);
    expect(collapsed.shouldLoad).toBe(false);
    expect(collapsed.workspace.sessions[0]?.isExpanded).toBe(false);

    const expanded = toggleSessionTreeNode(
      collapsed.workspace,
      "root-expanded"
    );
    expect(expanded.expanded).toBe(true);
    expect(expanded.shouldLoad).toBe(true);
    expect(expanded.workspace.sessions[0]?.isExpanded).toBe(true);
  });

  it("continues loading persisted expanded descendants", async () => {
    const makeNode = (sessionId: string, childCount: number): SessionBrowserViewNode => ({
      sessionId,
      workspaceId: "workspace-1",
      engineId: "codex",
      title: sessionId,
      statusDot: "none",
      isActive: false,
      isExpanded: true,
      childCount,
      isLoadingChildren: false,
      hasLoadedChildren: false,
      children: [],
      childrenHasMore: childCount > 0
    });
    const root = makeNode("root", 1);
    const child = makeNode("child", 1);
    const grandchild = makeNode("grandchild", 0);
    const childrenBySession = new Map([
      ["root", [child]],
      ["child", [grandchild]]
    ]);
    const loaded: string[] = [];
    const loadChildren = async (sessionId: string): Promise<void> => {
      loaded.push(sessionId);
      await loadPersistedExpandedChildren({
        sessions: childrenBySession.get(sessionId) ?? [],
        loadChildren
      });
    };

    await loadPersistedExpandedChildren({ sessions: [root], loadChildren });

    expect(loaded).toEqual(["root", "child"]);
  });

  it("refreshes every expanded workspace after live status changes", () => {
    const workspaces = [
      { workspaceId: "workspace-a", isExpanded: true },
      { workspaceId: "workspace-b", isExpanded: true },
      { workspaceId: "workspace-c", isExpanded: false }
    ];

    expect(
      resolveWorkspaceRefreshTargetIds({
        mode: "visible",
        lastActiveWorkspaceId: "workspace-c",
        workspaces
      })
    ).toEqual(["workspace-a", "workspace-b"]);
    expect(
      resolveWorkspaceRefreshTargetIds({
        mode: "all",
        lastActiveWorkspaceId: "workspace-c",
        workspaces
      })
    ).toEqual(["workspace-a", "workspace-b", "workspace-c"]);
  });

  it("collects every visible loaded child collection for status refresh", () => {
    expect(
      collectExpandedLoadedSessionIds([
        {
          sessionId: "root",
          engineId: "codex",
          title: "Root",
          statusDot: "running",
          isActive: false,
          childCount: 1,
          isExpanded: true,
          isLoadingChildren: false,
          hasLoadedChildren: true,
          children: [
            {
              sessionId: "child",
              engineId: "codex",
              title: "Child",
              statusDot: "running",
              isActive: false,
              childCount: 1,
              isExpanded: true,
              isLoadingChildren: false,
              hasLoadedChildren: true,
              children: [],
              childrenHasMore: false
            }
          ],
          childrenHasMore: false
        },
        {
          sessionId: "collapsed-root",
          engineId: "codex",
          title: "Collapsed root",
          statusDot: "idle",
          isActive: false,
          childCount: 1,
          isExpanded: false,
          isLoadingChildren: false,
          hasLoadedChildren: true,
          children: [
            {
              sessionId: "hidden-expanded-child",
              engineId: "codex",
              title: "Hidden expanded child",
              statusDot: "running",
              isActive: false,
              childCount: 1,
              isExpanded: true,
              isLoadingChildren: false,
              hasLoadedChildren: true,
              children: [],
              childrenHasMore: false
            }
          ],
          childrenHasMore: false
        }
      ])
    ).toEqual(["root", "child"]);
  });

  it("does not project settled loading from a replaced coordinator", async () => {
    const resolvers: Array<(page: SessionBrowserPageRpc) => void> = [];
    const createCoordinator = () =>
      new SessionBrowserQueryCoordinator({
        listRoots: vi.fn(
          () =>
            new Promise<SessionBrowserPageRpc>((resolve) => {
              resolvers.push(resolve);
            })
        ),
        listChildren: vi.fn(),
        getPath: vi.fn()
      });
    const previous = createCoordinator();
    const current = createCoordinator();
    const scope = { kind: "roots" as const, workspaceId: "workspace-1" };
    let workspace = mergeWorkspaceBrowserState([], {
      workspaces: [{
        workspaceId: "workspace-1",
        absolutePath: "I:\\repo",
        label: "Repo",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z"
      }],
      lastActiveWorkspaceId: "workspace-1"
    })[0]!;
    const previousResult = previous.load(scope);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    workspace = projectSessionBrowserLoading(
      workspace,
      previous,
      previous,
      scope
    );
    expect(workspace.isLoadingRoots).toBe(true);

    const currentResult = current.load(scope);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    workspace = projectSessionBrowserLoading(workspace, current, current, scope);
    expect(workspace.isLoadingRoots).toBe(true);

    resolvers[0]?.({
      workspaceId: "workspace-1",
      revision: "revision-old",
      items: [],
      hasMore: false,
      totalCount: 0
    });
    await previousResult;
    const afterPrevious = projectSessionBrowserLoading(
      workspace,
      current,
      previous,
      scope
    );
    expect(afterPrevious).toBe(workspace);
    expect(afterPrevious.isLoadingRoots).toBe(true);

    resolvers[1]?.({
      workspaceId: "workspace-1",
      revision: "revision-new",
      items: [],
      hasMore: false,
      totalCount: 0
    });
    await currentResult;
    workspace = projectSessionBrowserLoading(workspace, current, current, scope);
    expect(workspace.isLoadingRoots).toBe(false);
  });

  it("starts child loading without waiting for expansion persistence", async () => {
    let resolvePersistence!: () => void;
    const persistExpansion = vi.fn(
      () => new Promise<void>((resolve) => {
        resolvePersistence = resolve;
      })
    );
    const loadChildren = vi.fn(async () => undefined);

    await runSessionExpansionEffects({
      persistExpansion,
      loadChildren,
      onPersistenceError: vi.fn()
    });

    expect(persistExpansion).toHaveBeenCalledTimes(1);
    expect(loadChildren).toHaveBeenCalledTimes(1);
    resolvePersistence();
  });

  it("reports persistence failure independently from successful child loading", async () => {
    const error = new Error("write failed");
    const onPersistenceError = vi.fn();

    await runSessionExpansionEffects({
      persistExpansion: async () => {
        throw error;
      },
      loadChildren: async () => undefined,
      onPersistenceError
    });
    await vi.waitFor(() => expect(onPersistenceError).toHaveBeenCalledWith(error));
  });

  it("still loads children when persistence throws synchronously", async () => {
    const error = new Error("transport unavailable");
    const onPersistenceError = vi.fn();
    const loadChildren = vi.fn(async () => undefined);

    await runSessionExpansionEffects({
      persistExpansion: () => {
        throw error;
      },
      loadChildren,
      onPersistenceError
    });

    expect(onPersistenceError).toHaveBeenCalledWith(error);
    expect(loadChildren).toHaveBeenCalledTimes(1);
  });

  it("does not merge a stale focused session path from another workspace", () => {
    expect(
      shouldMergeFocusedSessionPath({
        loadedWorkspaceId: "workspace-a",
        pathWorkspaceId: "workspace-b"
      })
    ).toBe(false);
    expect(
      shouldMergeFocusedSessionPath({
        loadedWorkspaceId: "workspace-a",
        pathWorkspaceId: "workspace-a"
      })
    ).toBe(true);
  });

  it("persists collapse without selecting the collapsed workspace", async () => {
    const calls: string[] = [];
    const cancelLoads = vi.fn(() => calls.push("cancel"));
    const persistExpansion = vi.fn(async () => undefined);
    const selectWorkspace = vi.fn(async () => undefined);
    const loadRoots = vi.fn(async () => undefined);

    await runWorkspaceExpansionEffects({
      expanded: false,
      cancelLoads,
      persistExpansion: async () => {
        calls.push("persist");
        await persistExpansion();
      },
      selectWorkspace,
      loadRoots
    });

    expect(calls).toEqual(["cancel", "persist"]);
    expect(cancelLoads).toHaveBeenCalledTimes(1);
    expect(persistExpansion).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(loadRoots).not.toHaveBeenCalled();
  });

  it("selects and loads only after explicit expansion is persisted", async () => {
    const calls: string[] = [];

    await runWorkspaceExpansionEffects({
      expanded: true,
      cancelLoads: vi.fn(() => calls.push("cancel")),
      persistExpansion: async () => {
        calls.push("persist");
      },
      selectWorkspace: async () => {
        calls.push("select");
      },
      loadRoots: async () => {
        calls.push("load");
      }
    });

    expect(calls).toEqual(["persist", "select", "load"]);
  });
});
