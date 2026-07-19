import { describe, expect, it, vi } from "vitest";
import { createRemoteRpcHandler } from "../src/remote-protocol.js";
import { SessionBrowserCursorStaleError } from "../src/session-browser-read-model.js";
import type { WorkbenchShellService } from "../src/workbench-shell-service.js";

const createShell = (overrides: Record<string, unknown> = {}): WorkbenchShellService => ({
  listWorkspaces: vi.fn(),
  listSessionRoots: vi.fn(async () => ({
    workspaceId: "workspace-1",
    revision: "revision-1",
    items: [],
    hasMore: false,
    totalCount: 0
  })),
  listSessionChildren: vi.fn(async () => ({
    workspaceId: "workspace-1",
    parentSessionId: "session-root",
    revision: "revision-1",
    items: [],
    hasMore: false,
    totalCount: 0
  })),
  getSessionBrowserPath: vi.fn(async () => ({
    workspaceId: "workspace-1",
    revision: "revision-1",
    items: []
  })),
  ...overrides
} as unknown as WorkbenchShellService);

describe("session browser remote protocol", () => {
  it("routes bounded roots, children, and selected path requests", async () => {
    const shell = createShell();
    const handler = createRemoteRpcHandler(shell);

    const roots = await handler.handleRequest({
      id: "req-roots",
      method: "sessionBrowser.listRoots",
      params: { workspaceId: "workspace-1", limit: 20 }
    });
    const children = await handler.handleRequest({
      id: "req-children",
      method: "sessionBrowser.listChildren",
      params: {
        workspaceId: "workspace-1",
        parentSessionId: "session-root",
        expectedRevision: "revision-1",
        limit: 20
      }
    });
    const path = await handler.handleRequest({
      id: "req-path",
      method: "sessionBrowser.getPath",
      params: { sessionId: "session-child" }
    });

    expect(roots).toMatchObject({ ok: true, method: "sessionBrowser.listRoots" });
    expect(children).toMatchObject({ ok: true, method: "sessionBrowser.listChildren" });
    expect(path).toMatchObject({ ok: true, method: "sessionBrowser.getPath" });
  });

  it("maps revision mismatch to CURSOR_STALE", async () => {
    const shell = createShell({
      listSessionRoots: vi.fn(async () => {
        throw new SessionBrowserCursorStaleError();
      })
    });
    const response = await createRemoteRpcHandler(shell).handleRequest({
      id: "req-stale",
      method: "sessionBrowser.listRoots",
      params: {
        workspaceId: "workspace-1",
        expectedRevision: "old-revision",
        limit: 20
      }
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "CURSOR_STALE" }
    });
  });
});
