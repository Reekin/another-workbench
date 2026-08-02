import { describe, expect, it, vi } from "vitest";
import type { SessionBrowserPageRpc } from "@another-workbench/shared";
import { SessionBrowserQueryCoordinator } from "../src/ui/chat-shell/session-browser-query-coordinator.js";

const page = (
  revision: string,
  parentSessionId?: string
): SessionBrowserPageRpc => ({
  workspaceId: "workspace-1",
  parentSessionId,
  revision,
  items: [],
  hasMore: false,
  totalCount: 0
});

describe("SessionBrowserQueryCoordinator", () => {
  it("shares identical active loads and projects loading by collection", async () => {
    let resolveRequest!: (value: SessionBrowserPageRpc) => void;
    const listRoots = vi.fn(
      () =>
        new Promise<SessionBrowserPageRpc>((resolve) => {
          resolveRequest = resolve;
        })
    );
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn(),
      getPath: vi.fn()
    });
    const query = { kind: "roots" as const, workspaceId: "workspace-1", limit: 1000 };
    const first = coordinator.load(query);
    const second = coordinator.load(query);

    expect(second).toBe(first);
    expect(coordinator.isLoading({ kind: "roots", workspaceId: "workspace-1" })).toBe(true);
    await vi.waitFor(() => expect(listRoots).toHaveBeenCalledTimes(1));
    expect(listRoots).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cursor: undefined,
      expectedRevision: undefined,
      limit: 100
    });

    resolveRequest(page("revision-1"));
    await expect(first).resolves.toEqual({
      status: "committed",
      page: page("revision-1")
    });
    expect(coordinator.isLoading({ kind: "roots", workspaceId: "workspace-1" })).toBe(false);
  });

  it("invalidates an active load without creating replacement state", async () => {
    let resolveRequest!: (value: SessionBrowserPageRpc) => void;
    const listRoots = vi.fn(
      () =>
        new Promise<SessionBrowserPageRpc>((resolve) => {
          resolveRequest = resolve;
        })
    );
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn(),
      getPath: vi.fn()
    });
    const result = coordinator.load({ kind: "roots", workspaceId: "workspace-1" });
    await vi.waitFor(() => expect(listRoots).toHaveBeenCalledTimes(1));

    expect(
      coordinator.invalidateCollection({ workspaceId: "workspace-1" })
    ).toEqual([{ kind: "roots", workspaceId: "workspace-1" }]);
    expect(coordinator.isLoading({ kind: "roots", workspaceId: "workspace-1" })).toBe(false);
    resolveRequest(page("revision-1"));

    await expect(result).resolves.toEqual({
      status: "superseded",
      reason: "invalidated"
    });
  });

  it("keeps cancellation independent between child collections", async () => {
    const resolvers = new Map<string, (value: SessionBrowserPageRpc) => void>();
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots: vi.fn(),
      listChildren: vi.fn(
        (input: { parentSessionId: string }) =>
          new Promise<SessionBrowserPageRpc>((resolve) => {
            resolvers.set(input.parentSessionId, resolve);
          })
      ),
      getPath: vi.fn()
    });
    const first = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "parent-1"
    });
    const second = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "parent-2"
    });
    await vi.waitFor(() => expect(resolvers.size).toBe(2));

    expect(
      coordinator.cancelCollection({
        workspaceId: "workspace-1",
        parentSessionId: "parent-1"
      })
    ).toEqual([
      {
        kind: "children",
        workspaceId: "workspace-1",
        parentSessionId: "parent-1"
      }
    ]);
    resolvers.get("parent-1")?.(page("revision-1", "parent-1"));
    resolvers.get("parent-2")?.(page("revision-1", "parent-2"));

    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(second).resolves.toMatchObject({ status: "committed" });
  });

  it("cancels every active workspace collection before late responses arrive", async () => {
    let resolveRoots!: (value: SessionBrowserPageRpc) => void;
    let resolveChildren!: (value: SessionBrowserPageRpc) => void;
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots: vi.fn(
        () =>
          new Promise<SessionBrowserPageRpc>((resolve) => {
            resolveRoots = resolve;
          })
      ),
      listChildren: vi.fn(
        () =>
          new Promise<SessionBrowserPageRpc>((resolve) => {
            resolveChildren = resolve;
          })
      ),
      getPath: vi.fn()
    });
    const roots = coordinator.load({ kind: "roots", workspaceId: "workspace-1" });
    const children = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "parent-1"
    });
    await vi.waitFor(() => expect(resolveChildren).toBeTypeOf("function"));

    expect(coordinator.cancelWorkspace("workspace-1")).toEqual([
      { kind: "roots", workspaceId: "workspace-1" },
      {
        kind: "children",
        workspaceId: "workspace-1",
        parentSessionId: "parent-1"
      }
    ]);
    expect(coordinator.isLoading({ kind: "roots", workspaceId: "workspace-1" })).toBe(false);
    expect(
      coordinator.isLoading({
        kind: "children",
        workspaceId: "workspace-1",
        parentSessionId: "parent-1"
      })
    ).toBe(false);

    resolveRoots(page("revision-late"));
    resolveChildren(page("revision-late", "parent-1"));
    await expect(roots).resolves.toEqual({ status: "cancelled" });
    await expect(children).resolves.toEqual({ status: "cancelled" });
  });

  it("does not commit an older response after a replacement load", async () => {
    const resolvers: Array<(value: SessionBrowserPageRpc) => void> = [];
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots: vi.fn(
        () =>
          new Promise<SessionBrowserPageRpc>((resolve) => {
            resolvers.push(resolve);
          })
      ),
      listChildren: vi.fn(),
      getPath: vi.fn()
    });
    const first = coordinator.load({ kind: "roots", workspaceId: "workspace-1" });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const second = coordinator.load({
      kind: "roots",
      workspaceId: "workspace-1",
      limit: 30
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1]?.(page("revision-2"));
    await expect(second).resolves.toMatchObject({ status: "committed" });
    resolvers[0]?.(page("revision-1"));
    await expect(first).resolves.toEqual({
      status: "superseded",
      reason: "replaced"
    });
  });

  it("recovers a stale root cursor with the workspace first page", async () => {
    const listRoots = vi
      .fn()
      .mockRejectedValueOnce({ code: "CURSOR_STALE" })
      .mockResolvedValueOnce(page("revision-2"));
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn(),
      getPath: vi.fn()
    });

    await expect(
      coordinator.load({
        kind: "roots",
        workspaceId: "workspace-1",
        cursor: "stale-cursor",
        limit: 10
      })
    ).resolves.toEqual({
      status: "committed",
      page: page("revision-2"),
      recoveredRootPage: page("revision-2")
    });
    expect(listRoots).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      cursor: undefined,
      expectedRevision: undefined,
      limit: 10
    });
  });

  it("recovers a changed child revision through roots then retries first-page children", async () => {
    const listRoots = vi
      .fn()
      .mockResolvedValueOnce(page("revision-1"))
      .mockResolvedValueOnce(page("revision-2"));
    const listChildren = vi
      .fn()
      .mockResolvedValueOnce(page("revision-0", "parent-1"))
      .mockResolvedValueOnce(page("revision-2", "parent-1"));
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren,
      getPath: vi.fn()
    });
    await coordinator.load({ kind: "roots", workspaceId: "workspace-1" });

    await expect(
      coordinator.load({
        kind: "children",
        workspaceId: "workspace-1",
        parentSessionId: "parent-1",
        cursor: "child-page-2"
      })
    ).resolves.toEqual({
      status: "committed",
      page: page("revision-2", "parent-1"),
      recoveredRootPage: page("revision-2")
    });
    expect(listChildren).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      parentSessionId: "parent-1",
      cursor: undefined,
      expectedRevision: "revision-2",
      limit: 20
    });
    expect(listRoots).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      cursor: undefined,
      expectedRevision: undefined,
      limit: 10
    });
  });

  it("fences late old-revision roots and retries late children after recovery", async () => {
    let resolveOldRoots!: (value: SessionBrowserPageRpc) => void;
    let resolveRecovery!: (value: SessionBrowserPageRpc) => void;
    let resolveLateChild!: (value: SessionBrowserPageRpc) => void;
    let firstPageCalls = 0;
    const childCalls = new Map<string, number>();
    const listRoots = vi.fn((input: { cursor?: string }) => {
      if (input.cursor) {
        return new Promise<SessionBrowserPageRpc>((resolve) => {
          resolveOldRoots = resolve;
        });
      }
      firstPageCalls += 1;
      if (firstPageCalls === 1) {
        return Promise.resolve(page("revision-1"));
      }
      return new Promise<SessionBrowserPageRpc>((resolve) => {
        resolveRecovery = resolve;
      });
    });
    const listChildren = vi.fn((input: { parentSessionId: string }) => {
      const count = (childCalls.get(input.parentSessionId) ?? 0) + 1;
      childCalls.set(input.parentSessionId, count);
      if (input.parentSessionId === "recovering" && count === 1) {
        return Promise.reject({ code: "CURSOR_STALE" });
      }
      if (input.parentSessionId === "late" && count === 1) {
        return new Promise<SessionBrowserPageRpc>((resolve) => {
          resolveLateChild = resolve;
        });
      }
      return Promise.resolve(page("revision-2", input.parentSessionId));
    });
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren,
      getPath: vi.fn()
    });
    await coordinator.load({ kind: "roots", workspaceId: "workspace-1" });

    const oldRoots = coordinator.load({
      kind: "roots",
      workspaceId: "workspace-1",
      cursor: "old-root-page"
    });
    const lateChild = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "late"
    });
    const recoveringChild = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "recovering"
    });
    await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));

    resolveRecovery(page("revision-2"));
    await expect(recoveringChild).resolves.toMatchObject({
      status: "committed",
      page: page("revision-2", "recovering")
    });
    resolveOldRoots(page("revision-1"));
    resolveLateChild(page("revision-1", "late"));

    await expect(oldRoots).resolves.toEqual({
      status: "superseded",
      reason: "revision_changed"
    });
    await expect(lateChild).resolves.toMatchObject({
      status: "committed",
      page: page("revision-2", "late")
    });
    expect(childCalls.get("late")).toBe(2);
  });

  it("lets a surviving root claim recovery after the recovering child is cancelled", async () => {
    let resolveOldRoots!: (value: SessionBrowserPageRpc) => void;
    let resolveRecovery!: (value: SessionBrowserPageRpc) => void;
    let firstPageCalls = 0;
    const listRoots = vi.fn((input: { cursor?: string }) => {
      if (input.cursor) {
        return new Promise<SessionBrowserPageRpc>((resolve) => {
          resolveOldRoots = resolve;
        });
      }
      firstPageCalls += 1;
      if (firstPageCalls === 1) {
        return Promise.resolve(page("revision-1"));
      }
      return new Promise<SessionBrowserPageRpc>((resolve) => {
        resolveRecovery = resolve;
      });
    });
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn().mockRejectedValue({ code: "CURSOR_STALE" }),
      getPath: vi.fn()
    });
    await coordinator.load({ kind: "roots", workspaceId: "workspace-1" });
    const oldRoots = coordinator.load({
      kind: "roots",
      workspaceId: "workspace-1",
      cursor: "old-root-page"
    });
    const recoveringChild = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "recovering"
    });
    await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));

    coordinator.cancelCollection({
      workspaceId: "workspace-1",
      parentSessionId: "recovering"
    });
    resolveRecovery(page("revision-2"));
    await expect(recoveringChild).resolves.toEqual({ status: "cancelled" });
    resolveOldRoots(page("revision-1"));

    await expect(oldRoots).resolves.toEqual({
      status: "committed",
      page: page("revision-2"),
      recoveredRootPage: page("revision-2")
    });
  });

  it("lets a surviving root claim recovery when its old request fails", async () => {
    let rejectOldRoots!: (error: unknown) => void;
    let resolveRecovery!: (value: SessionBrowserPageRpc) => void;
    let firstPageCalls = 0;
    const listRoots = vi.fn((input: { cursor?: string }) => {
      if (input.cursor) {
        return new Promise<SessionBrowserPageRpc>((_resolve, reject) => {
          rejectOldRoots = reject;
        });
      }
      firstPageCalls += 1;
      if (firstPageCalls === 1) {
        return Promise.resolve(page("revision-1"));
      }
      return new Promise<SessionBrowserPageRpc>((resolve) => {
        resolveRecovery = resolve;
      });
    });
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn().mockRejectedValue({ code: "CURSOR_STALE" }),
      getPath: vi.fn()
    });
    await coordinator.load({ kind: "roots", workspaceId: "workspace-1" });
    const oldRoots = coordinator.load({
      kind: "roots",
      workspaceId: "workspace-1",
      cursor: "old-root-page"
    });
    const recoveringChild = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "recovering"
    });
    await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));

    coordinator.cancelCollection({
      workspaceId: "workspace-1",
      parentSessionId: "recovering"
    });
    resolveRecovery(page("revision-2"));
    await expect(recoveringChild).resolves.toEqual({ status: "cancelled" });
    rejectOldRoots(new Error("network unavailable"));

    await expect(oldRoots).resolves.toEqual({
      status: "committed",
      page: page("revision-2"),
      recoveredRootPage: page("revision-2")
    });
  });

  it("single-flights revision recovery for concurrent stale child collections", async () => {
    let resolveRecovery!: (value: SessionBrowserPageRpc) => void;
    let childRevision = "revision-2";
    const callsByParent = new Map<string, number>();
    const listRoots = vi
      .fn()
      .mockResolvedValueOnce(page("revision-1"))
      .mockImplementationOnce(
        () =>
          new Promise<SessionBrowserPageRpc>((resolve) => {
            resolveRecovery = resolve;
          })
      )
      .mockResolvedValueOnce(page("revision-3"));
    const listChildren = vi.fn(async (input: { parentSessionId: string }) => {
      const count = (callsByParent.get(input.parentSessionId) ?? 0) + 1;
      callsByParent.set(input.parentSessionId, count);
      if (count === 1) {
        throw { code: "CURSOR_STALE" };
      }
      return page(childRevision, input.parentSessionId);
    });
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren,
      getPath: vi.fn()
    });
    await coordinator.load({ kind: "roots", workspaceId: "workspace-1" });

    const first = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "parent-1"
    });
    const second = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "parent-2"
    });
    await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));
    expect(listRoots).toHaveBeenCalledTimes(2);

    resolveRecovery(page("revision-2"));
    const concurrentResults = await Promise.all([first, second]);
    expect(concurrentResults).toMatchObject([
      { status: "committed", page: page("revision-2", "parent-1") },
      { status: "committed", page: page("revision-2", "parent-2") }
    ]);
    expect(
      concurrentResults.filter(
        (result) => result.status === "committed" && result.recoveredRootPage
      )
    ).toHaveLength(1);
    expect(listRoots).toHaveBeenCalledTimes(2);

    childRevision = "revision-3";
    await expect(
      coordinator.load({
        kind: "children",
        workspaceId: "workspace-1",
        parentSessionId: "parent-3"
      })
    ).resolves.toEqual({
      status: "committed",
      page: page("revision-3", "parent-3"),
      recoveredRootPage: page("revision-3")
    });
    expect(listRoots).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["cancel", { status: "cancelled" }],
    ["invalidate", { status: "superseded", reason: "invalidated" }]
  ] as const)("does not commit after %s during revision recovery", async (action, expected) => {
    let resolveRecovery!: (value: SessionBrowserPageRpc) => void;
    const listRoots = vi
      .fn()
      .mockResolvedValueOnce(page("revision-1"))
      .mockImplementationOnce(
        () =>
          new Promise<SessionBrowserPageRpc>((resolve) => {
            resolveRecovery = resolve;
          })
      );
    const listChildren = vi.fn().mockRejectedValueOnce({ code: "CURSOR_STALE" });
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren,
      getPath: vi.fn()
    });
    await coordinator.load({ kind: "roots", workspaceId: "workspace-1" });
    const result = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "parent-1"
    });
    await vi.waitFor(() => expect(resolveRecovery).toBeTypeOf("function"));

    const affected =
      action === "cancel"
        ? coordinator.cancelCollection({
            workspaceId: "workspace-1",
            parentSessionId: "parent-1"
          })
        : coordinator.invalidateCollection({
            workspaceId: "workspace-1",
            parentSessionId: "parent-1"
          });
    expect(affected).toHaveLength(1);
    resolveRecovery(page("revision-late"));

    await expect(result).resolves.toEqual(expected);
    expect(listChildren).toHaveBeenCalledTimes(1);
  });

  it("stops after one stale recovery attempt", async () => {
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots: vi.fn().mockResolvedValue(page("revision-2")),
      listChildren: vi.fn().mockRejectedValue({ code: "CURSOR_STALE" }),
      getPath: vi.fn()
    });

    await expect(
      coordinator.load({
        kind: "children",
        workspaceId: "workspace-1",
        parentSessionId: "parent-1"
      })
    ).resolves.toEqual({
      status: "superseded",
      reason: "revision_changed"
    });
  });

  it("single-flights selected path requests", async () => {
    const getPath = vi.fn(async () => ({
      workspaceId: "workspace-1",
      revision: "revision-1",
      items: []
    }));
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots: vi.fn(),
      listChildren: vi.fn(),
      getPath
    });

    await Promise.all([coordinator.getPath("session-1"), coordinator.getPath("session-1")]);
    expect(getPath).toHaveBeenCalledTimes(1);
  });

  it("binds child queries to the accepted workspace revision", async () => {
    const listChildren = vi.fn(async () => page("revision-1", "session-root"));
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots: vi.fn(async () => page("revision-1")),
      listChildren,
      getPath: vi.fn()
    });
    await coordinator.load({ kind: "roots", workspaceId: "workspace-1" });
    await coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "session-root"
    });

    expect(listChildren).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      parentSessionId: "session-root",
      cursor: undefined,
      expectedRevision: "revision-1",
      limit: 20
    });
  });
});
