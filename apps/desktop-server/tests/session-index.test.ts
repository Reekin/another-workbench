import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndexStore } from "../src/session-index.js";

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-session-index-"));
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

describe("SessionIndexStore", () => {
  it("persists session entries, relations, and unread state across reloads", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({
      baseDir
    });

    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Main thread",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z",
        metadata: {
          source: "gui"
        }
      },
      summaryText: "Initial summary"
    });

    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-2",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:02Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      unreadState: "unread_completed"
    });

    await store.upsertRelation({
      workspaceId: "workspace-1",
      parentSessionId: "session-1",
      childSessionId: "session-2",
      relationType: "subagent",
      sourceTurnId: "turn-9",
      createdAt: "2026-04-18T00:00:03Z"
    });

    const reloaded = new SessionIndexStore({
      baseDir
    });
    await reloaded.ready();

    expect(reloaded.listEntries("workspace-1")).toEqual([
      expect.objectContaining({
        sessionId: "session-2",
        unreadState: "unread_completed"
      }),
      expect.objectContaining({
        sessionId: "session-1",
        summaryText: "Initial summary"
      })
    ]);
    expect(reloaded.listRelations("workspace-1")).toEqual([
      expect.objectContaining({
        parentSessionId: "session-1",
        childSessionId: "session-2",
        relationType: "subagent",
        sourceTurnId: "turn-9"
      })
    ]);
  });

  it("updates archive and read transitions without losing prior summary data", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({
      baseDir
    });

    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "pi-acp",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      summaryText: "Needs review"
    });
    await store.markSessionUnreadCompleted("session-1");
    await store.markSessionRead("session-1");
    await store.archiveSession("session-1", "2026-04-18T00:00:02Z");

    expect(store.getEntry("session-1")).toMatchObject({
      summaryText: "Needs review",
      unreadState: "read",
      archivedAt: "2026-04-18T00:00:02Z"
    });
  });

  it("finds and archives all aliases that share the same provider session id", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({
      baseDir
    });

    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-local",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      providerSessionId: "thread-1"
    });
    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "codex-thread:thread-1",
        conversationId: "conversation-legacy",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:02Z",
        updatedAt: "2026-04-18T00:00:02Z"
      },
      providerSessionId: "thread-1",
      source: "reconciled"
    });

    expect(
      store.listEntriesByProviderSessionId("thread-1", "workspace-1").map((entry) => entry.sessionId)
    ).toEqual(["codex-thread:thread-1", "session-local"]);

    await store.archiveSessions(
      store.listEntriesByProviderSessionId("thread-1", "workspace-1").map((entry) => entry.sessionId),
      "2026-04-18T00:00:03Z"
    );

    expect(store.getEntry("session-local")?.archivedAt).toBe("2026-04-18T00:00:03Z");
    expect(store.getEntry("codex-thread:thread-1")?.archivedAt).toBe("2026-04-18T00:00:03Z");
  });

  it("repairs invalid persisted data by resetting to an empty document", async () => {
    const baseDir = await createTempDir();
    const filePath = join(baseDir, "session-index.json");
    await writeFile(filePath, "{\"broken\": true}", "utf8");

    const store = new SessionIndexStore({
      baseDir
    });
    await store.ready();

    expect(store.listEntries()).toEqual([]);
    const repaired = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      entries: unknown[];
      relations: unknown[];
    };
    expect(repaired.version).toBe(1);
    expect(repaired.entries).toEqual([]);
    expect(repaired.relations).toEqual([]);
  });
});
