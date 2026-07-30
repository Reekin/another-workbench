import { describe, expect, it, vi } from "vitest";
import type { SessionBrowserPageRpc } from "@another-workbench/shared";
import {
  isSessionBrowserCursorStaleError,
  SessionBrowserQueryCoordinator
} from "../src/ui/chat-shell/session-browser-query-coordinator.js";

const page = (revision: string): SessionBrowserPageRpc => ({
  workspaceId: "workspace-1",
  revision,
  items: [],
  hasMore: false,
  totalCount: 0
});

describe("SessionBrowserQueryCoordinator", () => {
  it("recognizes cursor invalidation without coupling to a transport error class", () => {
    expect(isSessionBrowserCursorStaleError({ code: "CURSOR_STALE" })).toBe(true);
    expect(isSessionBrowserCursorStaleError(new Error("CURSOR_STALE"))).toBe(false);
  });

  it("shares same-key requests and clamps the page limit", async () => {
    let resolveRequest!: (value: SessionBrowserPageRpc) => void;
    const listRoots = vi.fn(() => new Promise<SessionBrowserPageRpc>((resolve) => {
      resolveRequest = resolve;
    }));
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn(),
      getPath: vi.fn()
    });
    const query = { kind: "roots" as const, workspaceId: "workspace-1", limit: 1000 };
    const first = coordinator.load(query);
    const second = coordinator.load(query);
    expect(second).toBe(first);
    expect(listRoots).toHaveBeenCalledTimes(1);
    expect(listRoots).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cursor: undefined,
      expectedRevision: undefined,
      limit: 100
    });
    resolveRequest(page("revision-1"));
    await expect(first.result).resolves.toMatchObject({
      status: "committed",
      generation: first.generation,
      page: page("revision-1")
    });
  });

  it("terminates an invalidated request as superseded without creating a hidden owner", async () => {
    const resolvers: Array<(value: SessionBrowserPageRpc) => void> = [];
    const listRoots = vi.fn(() => new Promise<SessionBrowserPageRpc>((resolve) => resolvers.push(resolve)));
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn(),
      getPath: vi.fn()
    });
    const query = { kind: "roots" as const, workspaceId: "workspace-1" };
    const first = coordinator.load(query);
    for (let index = 0; index < 100; index += 1) {
      coordinator.invalidateCollection({ workspaceId: "workspace-1" });
    }
    resolvers[0]?.(page("revision-1"));
    await expect(first.result).resolves.toMatchObject({
      status: "superseded",
      reason: "invalidated",
      generation: first.generation
    });
    expect(listRoots).toHaveBeenCalledTimes(1);

    const refresh = coordinator.load(query);
    expect(refresh.generation).toBeGreaterThan(first.generation);
    expect(listRoots).toHaveBeenCalledTimes(2);
    resolvers[1]?.(page("revision-2"));
    await expect(refresh.result).resolves.toMatchObject({ status: "committed" });
  });

  it("invalidates a cached result before its owner can commit", async () => {
    const listRoots = vi.fn().mockResolvedValue(page("revision-1"));
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn(),
      getPath: vi.fn()
    });
    const query = { kind: "roots" as const, workspaceId: "workspace-1" };

    await coordinator.load(query).result;
    const cached = coordinator.load(query);
    const [owner] = coordinator.invalidateCollection({
      workspaceId: "workspace-1"
    });

    expect(owner).toEqual({
      scope: cached.scope,
      generation: cached.generation
    });
    await expect(cached.result).resolves.toMatchObject({
      status: "superseded",
      reason: "invalidated",
      generation: cached.generation
    });
  });

  it("keeps generation ownership independent between child collections", async () => {
    const resolvers = new Map<string, (value: SessionBrowserPageRpc) => void>();
    const listChildren = vi.fn((input: { parentSessionId: string }) =>
      new Promise<SessionBrowserPageRpc>((resolve) => {
        resolvers.set(input.parentSessionId, resolve);
      })
    );
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots: vi.fn(),
      listChildren,
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

    coordinator.cancelCollection({
      workspaceId: "workspace-1",
      parentSessionId: "parent-1"
    });
    resolvers.get("parent-1")?.({
      ...page("revision-1"),
      parentSessionId: "parent-1"
    });
    resolvers.get("parent-2")?.({
      ...page("revision-1"),
      parentSessionId: "parent-2"
    });

    await expect(first.result).resolves.toMatchObject({ status: "cancelled" });
    await expect(second.result).resolves.toMatchObject({ status: "committed" });
  });

  it("does not let a superseded response overwrite a newer query in the same scope", async () => {
    const resolvers: Array<(value: SessionBrowserPageRpc) => void> = [];
    const listRoots = vi.fn(() =>
      new Promise<SessionBrowserPageRpc>((resolve) => resolvers.push(resolve))
    );
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren: vi.fn(),
      getPath: vi.fn()
    });
    const firstQuery = { kind: "roots" as const, workspaceId: "workspace-1" };
    const secondQuery = {
      kind: "roots" as const,
      workspaceId: "workspace-1",
      limit: 30
    };
    const first = coordinator.load(firstQuery);
    const second = coordinator.load(secondQuery);
    resolvers[1]?.(page("revision-2"));
    await expect(second.result).resolves.toMatchObject({ status: "committed" });
    resolvers[0]?.(page("revision-1"));
    await expect(first.result).resolves.toMatchObject({
      status: "superseded",
      reason: "replaced"
    });
    expect(coordinator.getCached(secondQuery)?.revision).toBe("revision-2");
    expect(coordinator.getCached(firstQuery)).toBeUndefined();
  });

  it("marks an old child page recoverable when another request accepts a newer revision", async () => {
    let resolveChild!: (value: SessionBrowserPageRpc) => void;
    const listRoots = vi
      .fn()
      .mockResolvedValueOnce(page("revision-1"))
      .mockResolvedValueOnce(page("revision-2"));
    const listChildren = vi.fn(
      () =>
        new Promise<SessionBrowserPageRpc>((resolve) => {
          resolveChild = resolve;
        })
    );
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots,
      listChildren,
      getPath: vi.fn()
    });

    await coordinator.load({
      kind: "roots",
      workspaceId: "workspace-1"
    }).result;
    const child = coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "parent-1"
    });
    await coordinator.load({
      kind: "roots",
      workspaceId: "workspace-1",
      limit: 30
    }).result;
    resolveChild({
      ...page("revision-1"),
      parentSessionId: "parent-1"
    });

    await expect(child.result).resolves.toMatchObject({
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
    const listChildren = vi.fn(async () => ({
      ...page("revision-1"),
      parentSessionId: "session-root"
    }));
    const coordinator = new SessionBrowserQueryCoordinator({
      listRoots: vi.fn(async () => page("revision-1")),
      listChildren,
      getPath: vi.fn()
    });
    await coordinator.load({ kind: "roots", workspaceId: "workspace-1" }).result;
    await coordinator.load({
      kind: "children",
      workspaceId: "workspace-1",
      parentSessionId: "session-root"
    }).result;
    expect(listChildren).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      parentSessionId: "session-root",
      cursor: undefined,
      expectedRevision: "revision-1",
      limit: 20
    });
  });
});
