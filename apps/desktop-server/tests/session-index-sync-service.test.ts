import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndexStore } from "../src/session-index.js";
import {
  SessionIndexSyncService,
  type SessionIndexSyncRecord
} from "../src/session-index-sync-service.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-session-index-sync-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SessionIndexSyncService", () => {
  it("syncs create, provider session backfill, and archive state for a session entry", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const records = new Map<string, SessionIndexSyncRecord>();
    const service = new SessionIndexSyncService({
      sessionIndexStore: store,
      resolveSessionRecord: (sessionId) => records.get(sessionId)
    });

    records.set("session-1", {
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01.000Z",
        updatedAt: "2026-04-18T00:00:01.000Z"
      }
    });
    await service.syncSession("session-1");

    expect(store.getEntry("session-1")).toMatchObject({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      conversationId: "conversation-1",
      engineId: "codex",
      providerSessionId: undefined,
      archivedAt: undefined
    });

    records.set("session-1", {
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01.000Z",
        updatedAt: "2026-04-18T00:00:02.000Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-123",
      lastCompletedTurnAt: "2026-04-18T00:00:01.500Z"
    });
    await service.syncSession("session-1");

    expect(store.getEntry("session-1")).toMatchObject({
      providerKind: "codex-thread",
      providerSessionId: "thread-123",
      lastCompletedTurnAt: "2026-04-18T00:00:01.500Z",
      updatedAt: "2026-04-18T00:00:02.000Z"
    });

    records.set("session-1", {
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01.000Z",
        updatedAt: "2026-04-18T00:00:03.000Z",
        archivedAt: "2026-04-18T00:00:03.000Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-123"
    });
    await service.syncSession("session-1");

    expect(store.getEntry("session-1")).toMatchObject({
      archivedAt: "2026-04-18T00:00:03.000Z",
      providerSessionId: "thread-123"
    });
  });

  it("syncs fork relations into the session index store", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const service = new SessionIndexSyncService({
      sessionIndexStore: store,
      resolveSessionRecord: () => undefined
    });

    await service.syncRelation({
      workspaceId: "workspace-1",
      parentSessionId: "session-1",
      childSessionId: "session-2",
      relationType: "fork",
      sourceTurnId: "turn-9",
      createdAt: "2026-04-18T00:00:04.000Z"
    });

    expect(store.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "session-1",
        childSessionId: "session-2",
        relationType: "fork",
        sourceTurnId: "turn-9"
      })
    ]);
  });

  it("marks an indexed session unread after completion", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const records = new Map<string, SessionIndexSyncRecord>();
    const service = new SessionIndexSyncService({
      sessionIndexStore: store,
      resolveSessionRecord: (sessionId) => records.get(sessionId)
    });

    records.set("session-1", {
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01.000Z",
        updatedAt: "2026-04-18T00:00:01.000Z"
      }
    });
    await service.syncSession("session-1");
    await service.markSessionUnreadCompleted("session-1");

    expect(store.getEntry("session-1")).toMatchObject({
      unreadState: "unread_completed"
    });
  });
});
