import { describe, expect, it, vi } from "vitest";
import type { SessionBrowserPageRpc } from "@another-workbench/shared";
import {
  collectExpandedLoadedSessionIds,
  projectSessionBrowserLoading,
  resolveWorkspaceRefreshTargetIds,
  runSessionExpansionEffects,
  runWorkspaceExpansionEffects,
  shouldMergeFocusedSessionPath
} from "../src/ui/chat-shell/use-workspace-browser-controller.js";
import { SessionBrowserQueryCoordinator } from "../src/ui/chat-shell/session-browser-query-coordinator.js";
import { mergeWorkspaceBrowserState } from "../src/ui/chat-shell/workspace-browser-tree.js";

describe("workspace browser controller operations", () => {
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
