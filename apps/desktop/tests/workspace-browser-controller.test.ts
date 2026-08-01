import { describe, expect, it, vi } from "vitest";
import {
  collectExpandedLoadedSessionIds,
  resolveWorkspaceRefreshTargetIds,
  runSessionExpansionEffects,
  runWithSessionBrowserStaleRetry,
  runWorkspaceExpansionEffects,
  shouldMergeFocusedSessionPath
} from "../src/ui/chat-shell/use-workspace-browser-controller.js";

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

  it("recovers one stale collection load and retries the original operation once", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ code: "CURSOR_STALE" })
      .mockResolvedValueOnce("committed");
    const recover = vi.fn(async () => true);

    await expect(
      runWithSessionBrowserStaleRetry({ load, recover })
    ).resolves.toBe("committed");
    expect(load).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("terminates without an unhandled failure when the retry is stale again", async () => {
    const stale = { code: "CURSOR_STALE" };
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(stale);
    const recover = vi.fn(async () => true);

    await expect(
      runWithSessionBrowserStaleRetry({ load, recover })
    ).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("does not recover invalidated or replaced owners", async () => {
    const invalidated = {
      status: "superseded" as const,
      reason: "invalidated" as const
    };
    const replaced = {
      status: "superseded" as const,
      reason: "replaced" as const
    };
    const recoverInvalidated = vi.fn(async () => true);
    const invalidatedLoad = vi.fn().mockResolvedValue(invalidated);

    await expect(
      runWithSessionBrowserStaleRetry({
        load: invalidatedLoad,
        recover: recoverInvalidated,
        shouldRecoverResult: (result) =>
          result.status === "superseded" &&
          result.reason === "revision_changed"
      })
    ).resolves.toBe(invalidated);
    expect(invalidatedLoad).toHaveBeenCalledTimes(1);
    expect(recoverInvalidated).not.toHaveBeenCalled();

    const recoverReplaced = vi.fn(async () => true);
    await expect(
      runWithSessionBrowserStaleRetry({
        load: async () => replaced,
        recover: recoverReplaced,
        shouldRecoverResult: (result) =>
          result.status === "superseded" &&
          result.reason === "invalidated"
      })
    ).resolves.toBe(replaced);
    expect(recoverReplaced).not.toHaveBeenCalled();
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
    const persistExpansion = vi.fn(async () => undefined);
    const selectWorkspace = vi.fn(async () => undefined);
    const loadRoots = vi.fn(async () => undefined);

    await runWorkspaceExpansionEffects({
      expanded: false,
      persistExpansion,
      selectWorkspace,
      loadRoots
    });

    expect(persistExpansion).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(loadRoots).not.toHaveBeenCalled();
  });

  it("selects and loads only after explicit expansion is persisted", async () => {
    const calls: string[] = [];

    await runWorkspaceExpansionEffects({
      expanded: true,
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
