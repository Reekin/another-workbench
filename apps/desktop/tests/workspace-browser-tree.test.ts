import { describe, expect, it } from "vitest";
import type {
  SessionBrowserItemRpc,
  SessionBrowserNodeRpc,
  WorkspaceBrowserNodeRpc
} from "@another-workbench/shared";
import {
  applyChildrenPage,
  applyRootPage,
  collectAttentionSessions,
  mergeSessionPath,
  mergeWorkspaceBrowserState,
  projectSessionBrowserPresentation,
  resetRootPagination,
  setRootLoading,
  setSessionChildrenLoading,
  upsertWorkspaceBrowserRecord
} from "../src/ui/chat-shell/workspace-browser-tree.js";

const workspaceState = {
  workspaces: [{
    workspaceId: "workspace-1",
    absolutePath: "I:\\repo",
    label: "Repo",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  }],
  lastActiveWorkspaceId: "workspace-1"
};

const attentionSession = (
  input: Pick<SessionBrowserNodeRpc, "sessionId" | "title"> &
    Partial<SessionBrowserNodeRpc>
): SessionBrowserNodeRpc => ({
  displaySessionId: input.sessionId,
  workspaceId: "workspace-1",
  engineId: "codex",
  statusDot: "none",
  isExpanded: false,
  isActive: false,
  isArchived: false,
  children: [],
  updatedAt: "2026-08-20T00:00:00.000Z",
  ...input
});

describe("workspace browser tree", () => {
  it("projects one selected session and treats its completed result as read", () => {
    expect(
      projectSessionBrowserPresentation(
        { sessionId: "session-old", statusDot: "none" },
        "session-new"
      )
    ).toMatchObject({
      isSelected: false
    });
    expect(
      projectSessionBrowserPresentation(
        { sessionId: "session-new", statusDot: "unread_completed" },
        "session-new"
      )
    ).toEqual({
      isSelected: true,
      statusDot: "none",
      showInAttention: false
    });
  });

  it("keeps running and pinned attention visible for the selected session", () => {
    expect(
      projectSessionBrowserPresentation(
        { sessionId: "session-running", statusDot: "running" },
        "session-running"
      ).showInAttention
    ).toBe(true);
    expect(
      projectSessionBrowserPresentation(
        {
          sessionId: "session-pinned",
          statusDot: "unread_completed",
          isPinned: true
        },
        "session-pinned"
      )
    ).toEqual({
      isSelected: true,
      statusDot: "none",
      showInAttention: true
    });
  });

  it("collects running, unread, and pinned sessions into a global attention order", () => {
    const workspaces: WorkspaceBrowserNodeRpc[] = [
      {
        workspaceId: "workspace-1",
        label: "Repo",
        rootPath: "I:\\repo",
        isExpanded: true,
        isActive: true,
        sessions: [
          attentionSession({
            sessionId: "session-pinned",
            title: "Pinned",
            isPinned: true
          }),
          attentionSession({
            sessionId: "session-unread",
            title: "Unread",
            statusDot: "unread_completed",
            updatedAt: "2026-08-21T00:00:00.000Z"
          }),
          attentionSession({
            sessionId: "session-running",
            title: "Running",
            statusDot: "running",
            isPinned: true,
            isActive: true,
            updatedAt: "2026-08-19T00:00:00.000Z"
          }),
          attentionSession({
            sessionId: "session-ordinary",
            title: "Ordinary",
            updatedAt: "2026-08-22T00:00:00.000Z"
          })
        ]
      }
    ];

    expect(collectAttentionSessions(workspaces).map((session) => session.sessionId))
      .toEqual(["session-running", "session-unread", "session-pinned"]);
  });

  it("excludes child status sessions unless the child is explicitly pinned", () => {
    const unreadChild = attentionSession({
      sessionId: "session-child-unread",
      parentSessionId: "session-root",
      title: "Unread child",
      statusDot: "unread_completed"
    });
    const pinnedChild = attentionSession({
      sessionId: "session-child-pinned",
      parentSessionId: "session-root",
      title: "Pinned child",
      isPinned: true
    });
    const workspaces: WorkspaceBrowserNodeRpc[] = [{
      workspaceId: "workspace-1",
      label: "Repo",
      rootPath: "I:\\repo",
      isExpanded: true,
      isActive: true,
      sessions: [
        attentionSession({
          sessionId: "session-root",
          title: "Root",
          children: [unreadChild, pinnedChild]
        })
      ]
    }];

    expect(collectAttentionSessions(workspaces).map((session) => session.sessionId))
      .toEqual(["session-child-pinned"]);
  });

  it("restores persisted workspace expansion independently from active workspace", () => {
    const workspaces = mergeWorkspaceBrowserState([], {
      workspaces: [
        workspaceState.workspaces[0]!,
        {
          workspaceId: "workspace-2",
          absolutePath: "I:\\repo-2",
          label: "Repo 2",
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z"
        }
      ],
      lastActiveWorkspaceId: "workspace-2",
      expandedWorkspaceIds: ["workspace-1"]
    });

    expect(workspaces.map((workspace) => [workspace.workspaceId, workspace.isExpanded]))
      .toEqual([
        ["workspace-1", true],
        ["workspace-2", false]
      ]);
  });

  it("uses the active workspace only when no expansion preference exists", () => {
    const workspaces = mergeWorkspaceBrowserState([], {
      ...workspaceState,
      expandedWorkspaceIds: []
    });

    expect(workspaces[0]?.isExpanded).toBe(true);
  });

  it("preserves each existing workspace expansion during registry refresh", () => {
    const previous = mergeWorkspaceBrowserState([], {
      ...workspaceState,
      expandedWorkspaceIds: ["workspace-1"]
    });
    const refreshed = mergeWorkspaceBrowserState(previous, {
      ...workspaceState,
      expandedWorkspaceIds: []
    });

    expect(refreshed[0]?.isExpanded).toBe(true);
  });

  it("keeps root cursor page metadata without materializing the whole tree", () => {
    const workspace = mergeWorkspaceBrowserState([], workspaceState)[0]!;
    const next = applyRootPage(workspace, {
      workspaceId: "workspace-1",
      revision: "revision-1",
      items: [{
        sessionId: "root-1",
        engineId: "codex",
        title: "Root",
        statusDot: "none",
        isActive: false,
        childCount: 2
      }],
      nextCursor: "cursor-2",
      hasMore: true,
      totalCount: 21
    }, 0, [undefined]);

    expect(next.sessions).toHaveLength(1);
    expect(next.rootNextCursor).toBe("cursor-2");
    expect(next.rootTotalCount).toBe(21);
    expect(next.sessions[0]?.children).toEqual([]);
  });

  it("projects persisted session expansion on the first root page", () => {
    const workspace = mergeWorkspaceBrowserState([], workspaceState)[0]!;
    const persistedExpandedItem = {
      sessionId: "root-expanded",
      engineId: "codex",
      title: "Expanded root",
      statusDot: "none",
      isActive: false,
      isExpanded: true,
      childCount: 1
    } satisfies SessionBrowserItemRpc & { isExpanded: boolean };
    const next = applyRootPage(workspace, {
      workspaceId: "workspace-1",
      revision: "revision-1",
      items: [persistedExpandedItem],
      hasMore: false,
      totalCount: 1
    }, 0, [undefined]);

    expect(next.sessions[0]?.isExpanded).toBe(true);
    expect(next.sessions[0]?.hasLoadedChildren).toBe(false);
  });

  it("loads children incrementally and anchors an active path outside the root page", () => {
    const workspace = applyRootPage(
      mergeWorkspaceBrowserState([], workspaceState)[0]!,
      {
        workspaceId: "workspace-1",
        revision: "revision-1",
        items: [],
        hasMore: false,
        totalCount: 20
      },
      1,
      [undefined, "cursor-2"]
    );
    const anchored = mergeSessionPath(workspace, {
      workspaceId: "workspace-1",
      revision: "revision-1",
      items: [{
        sessionId: "root-active",
        engineId: "codex",
        title: "Active root",
        statusDot: "none",
        isActive: false,
        childCount: 1
      }, {
        sessionId: "child-active",
        parentSessionId: "root-active",
        engineId: "codex",
        title: "Active child",
        statusDot: "running",
        isActive: true,
        childCount: 0
      }]
    });
    const loaded = applyChildrenPage(anchored, "root-active", {
      workspaceId: "workspace-1",
      parentSessionId: "root-active",
      revision: "revision-1",
      items: [{
        sessionId: "child-active",
        parentSessionId: "root-active",
        engineId: "codex",
        title: "Active child",
        statusDot: "running",
        isActive: true,
        childCount: 0
      }],
      hasMore: false,
      totalCount: 1
    }, false);

    expect(loaded.sessions[0]?.isExpanded).toBe(true);
    expect(loaded.sessions[0]?.children[0]?.sessionId).toBe("child-active");
  });

  it("resets revision-bound pagination while preserving visible sessions", () => {
    const paged = applyRootPage(
      mergeWorkspaceBrowserState([], workspaceState)[0]!,
      {
        workspaceId: "workspace-1",
        revision: "revision-1",
        items: [{
          sessionId: "root-1",
          engineId: "codex",
          title: "Root",
          statusDot: "none",
          isActive: false,
          childCount: 0
        }],
        nextCursor: "cursor-3",
        hasMore: true,
        totalCount: 41
      },
      1,
      [undefined, "cursor-2"]
    );

    const reset = resetRootPagination(paged);

    expect(reset.sessions).toEqual(paged.sessions);
    expect(reset.rootCursorHistory).toEqual([undefined]);
    expect(reset.rootPageIndex).toBe(0);
    expect(reset.rootRevision).toBeUndefined();
    expect(reset.rootNextCursor).toBeUndefined();
    expect(reset.isDirty).toBe(true);
  });

  it("projects root loading without request ownership state", () => {
    const workspace = mergeWorkspaceBrowserState([], workspaceState)[0]!;
    const loading = setRootLoading(workspace, true);
    const settled = setRootLoading(loading, false);

    expect(loading.isLoadingRoots).toBe(true);
    expect(settled.isLoadingRoots).toBe(false);
  });

  it("projects child loading without request ownership state", () => {
    const workspace = applyRootPage(
      mergeWorkspaceBrowserState([], workspaceState)[0]!,
      {
        workspaceId: "workspace-1",
        revision: "revision-1",
        items: [{
          sessionId: "root-1",
          engineId: "codex",
          title: "Root",
          statusDot: "none",
          isActive: false,
          childCount: 1
        }],
        hasMore: false,
        totalCount: 1
      },
      0,
      [undefined]
    );
    const loading = setSessionChildrenLoading(workspace, "root-1", true);
    const settled = setSessionChildrenLoading(loading, "root-1", false);

    expect(loading.sessions[0]?.isLoadingChildren).toBe(true);
    expect(settled.sessions[0]?.isLoadingChildren).toBe(false);
  });

  it("commits an added workspace record without waiting for session discovery", () => {
    const current = mergeWorkspaceBrowserState([], workspaceState);
    const added = upsertWorkspaceBrowserRecord(current, {
      workspaceId: "workspace-2",
      absolutePath: "I:\\repo-new",
      label: "Repo New",
      createdAt: "2026-07-20T00:01:00.000Z",
      updatedAt: "2026-07-20T00:01:00.000Z"
    });

    expect(added.map((workspace) => workspace.workspaceId)).toEqual([
      "workspace-1",
      "workspace-2"
    ]);
    expect(added[1]).toMatchObject({
      label: "Repo New",
      rootPath: "I:\\repo-new",
      sessions: [],
      isExpanded: false,
      isDirty: true
    });
  });

  it("updates a duplicate workspace record without losing loaded UI state", () => {
    const current = applyRootPage(
      mergeWorkspaceBrowserState([], workspaceState)[0]!,
      {
        workspaceId: "workspace-1",
        revision: "revision-1",
        items: [],
        hasMore: false,
        totalCount: 0
      },
      0,
      [undefined]
    );
    const updated = upsertWorkspaceBrowserRecord([current], {
      ...workspaceState.workspaces[0]!,
      label: "Renamed Repo",
      updatedAt: "2026-07-20T00:02:00.000Z"
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.label).toBe("Renamed Repo");
    expect(updated[0]?.rootRevision).toBe("revision-1");
    expect(updated[0]?.isActive).toBe(true);
  });
});
