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
    expect(listRoots).toHaveBeenCalledTimes(1);
    expect(listRoots).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      cursor: undefined,
      expectedRevision: undefined,
      limit: 100
    });
    resolveRequest(page("revision-1"));
    await expect(first).resolves.toEqual(await second);
  });

  it("coalesces repeated invalidation during a request into one trailing refresh", async () => {
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
    await first;
    await vi.waitFor(() => expect(listRoots).toHaveBeenCalledTimes(2));
    resolvers[1]?.(page("revision-2"));
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
