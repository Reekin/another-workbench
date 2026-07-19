import { describe, expect, it } from "vitest";
import {
  SessionBrowserCursorStaleError,
  SessionBrowserReadModel,
  type SessionBrowserReadModelSeed
} from "../src/session-browser-read-model.js";

const seed = (input: Partial<SessionBrowserReadModelSeed> & Pick<SessionBrowserReadModelSeed, "sessionId" | "sortAt">): SessionBrowserReadModelSeed => ({
  workspaceId: "workspace-1",
  engineId: "codex",
  title: input.sessionId,
  statusDot: "none",
  isActive: false,
  childCount: 0,
  ...input
});

describe("SessionBrowserReadModel", () => {
  it("returns bounded stable pages and lazy children", () => {
    const model = new SessionBrowserReadModel([
      seed({ sessionId: "root-1", sortAt: "2026-07-19T03:00:00Z", childCount: 1 }),
      seed({ sessionId: "root-2", sortAt: "2026-07-19T02:00:00Z" }),
      seed({ sessionId: "root-3", sortAt: "2026-07-19T01:00:00Z" }),
      seed({ sessionId: "child-1", parentSessionId: "root-1", sortAt: "2026-07-19T04:00:00Z" })
    ]);

    const first = model.listRoots({ workspaceId: "workspace-1", limit: 2 });
    expect(first.items.map((item) => item.sessionId)).toEqual(["root-1", "root-2"]);
    expect(first).toMatchObject({ hasMore: true, totalCount: 3 });
    const second = model.listRoots({
      workspaceId: "workspace-1",
      limit: 2,
      cursor: first.nextCursor
    });
    expect(second.items.map((item) => item.sessionId)).toEqual(["root-3"]);
    expect(model.listChildren({ workspaceId: "workspace-1", parentSessionId: "root-1" }).items)
      .toHaveLength(1);
  });

  it("rejects cursors from another revision and returns selected ancestry", () => {
    const original = new SessionBrowserReadModel([
      seed({ sessionId: "older-root", sortAt: "2026-07-18T01:00:00Z" }),
      seed({ sessionId: "root", sortAt: "2026-07-19T01:00:00Z", childCount: 1 }),
      seed({ sessionId: "child", parentSessionId: "root", sortAt: "2026-07-19T02:00:00Z" })
    ]);
    const cursor = original.listRoots({ workspaceId: "workspace-1", limit: 1 }).nextCursor;
    const changed = new SessionBrowserReadModel([
      seed({ sessionId: "new-root", sortAt: "2026-07-19T03:00:00Z" }),
      seed({ sessionId: "root", sortAt: "2026-07-19T01:00:00Z", childCount: 1 }),
      seed({ sessionId: "child", parentSessionId: "root", sortAt: "2026-07-19T02:00:00Z" })
    ]);
    expect(() => changed.listRoots({ workspaceId: "workspace-1", cursor })).toThrow(SessionBrowserCursorStaleError);
    expect(() => changed.listRoots({
      workspaceId: "workspace-1",
      expectedRevision: original.listRoots({ workspaceId: "workspace-1" }).revision
    })).toThrow(SessionBrowserCursorStaleError);
    expect(changed.getPath("child").items.map((item) => item.sessionId)).toEqual(["root", "child"]);
  });
});
