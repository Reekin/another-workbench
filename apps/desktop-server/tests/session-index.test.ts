import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndexStore } from "../src/session-index.js";

const persistenceState = vi.hoisted(() => ({
  saveCalls: 0,
  beforeSave: undefined as undefined | (() => Promise<void>)
}));

vi.mock("../src/persistence-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/persistence-store.js")>();
  return {
    ...actual,
    saveJsonFile: vi.fn(async (filePath: string, value: unknown) => {
      persistenceState.saveCalls += 1;
      await persistenceState.beforeSave?.();
      await actual.saveJsonFile(filePath, value);
    })
  };
});

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "awb-session-index-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  persistenceState.saveCalls = 0;
  persistenceState.beforeSave = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("SessionIndexStore", () => {
  it("does not persist or advance revision for an identical session upsert", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const input = {
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        title: "Main thread",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z",
        metadata: {
          source: "gui",
          nested: {
            priority: 1
          }
        }
      },
      summaryText: "Initial summary"
    } as const;

    await store.upsertSession(input);
    const original = store.getEntry("session-1");
    const revision = store.getRevision();
    const saveCalls = persistenceState.saveCalls;

    const result = await store.upsertSession({
      ...input,
      session: {
        ...input.session,
        metadata: {
          source: "gui",
          nested: {
            priority: 1
          }
        }
      }
    });

    expect(result).toBe(original);
    expect(store.getEntry("session-1")).toBe(original);
    expect(store.getRevision()).toBe(revision);
    expect(persistenceState.saveCalls).toBe(saveCalls);
  });

  it("persists exactly once when a session field changes", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const input = {
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      }
    } as const;

    await store.upsertSession(input);
    const revision = store.getRevision();
    const saveCalls = persistenceState.saveCalls;

    await store.upsertSession({
      ...input,
      session: {
        ...input.session,
        updatedAt: "2026-04-18T00:00:02Z"
      }
    });

    expect(store.getRevision()).toBe(revision + 1);
    expect(persistenceState.saveCalls).toBe(saveCalls + 1);
  });

  it("preserves relation createdAt and skips identical relation persistence", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({
      baseDir,
      now: () => "2026-04-18T00:00:09Z"
    });
    const input = {
      workspaceId: "workspace-1",
      parentSessionId: "session-1",
      childSessionId: "session-2",
      relationType: "subagent" as const,
      sourceTurnId: "turn-1",
      createdAt: "2026-04-18T00:00:03Z"
    };

    await store.upsertRelation(input);
    const original = store.listRelations()[0];
    const revision = store.getRevision();
    const saveCalls = persistenceState.saveCalls;

    const result = await store.upsertRelation({
      ...input,
      createdAt: undefined
    });

    expect(result).toBe(original);
    expect(result.createdAt).toBe("2026-04-18T00:00:03Z");
    expect(store.getRevision()).toBe(revision);
    expect(persistenceState.saveCalls).toBe(saveCalls);
  });

  it("persists a changed reconcile once and skips an identical reconcile", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const input = {
      workspaceId: "workspace-1",
      entries: [
        {
          workspaceId: "workspace-1",
          session: {
            sessionId: "session-1",
            conversationId: "conversation-1",
            engineId: "codex",
            createdAt: "2026-04-18T00:00:01Z",
            updatedAt: "2026-04-18T00:00:01Z"
          }
        },
        {
          workspaceId: "workspace-1",
          session: {
            sessionId: "session-2",
            conversationId: "conversation-2",
            engineId: "codex",
            createdAt: "2026-04-18T00:00:02Z",
            updatedAt: "2026-04-18T00:00:02Z"
          }
        }
      ],
      relations: [
        {
          workspaceId: "workspace-1",
          parentSessionId: "session-1",
          childSessionId: "session-2",
          relationType: "subagent" as const,
          createdAt: "2026-04-18T00:00:03Z"
        }
      ]
    };

    await store.ready();
    const initialRevision = store.getRevision();
    await store.reconcileWorkspace(input);
    expect(store.getRevision()).toBe(initialRevision + 1);
    expect(persistenceState.saveCalls).toBe(1);

    const entryReferences = store.listEntries();
    const relationReference = store.listRelations()[0];
    const revision = store.getRevision();
    await store.reconcileWorkspace(input);

    expect(store.listEntries()[0]).toBe(entryReferences[0]);
    expect(store.listEntries()[1]).toBe(entryReferences[1]);
    expect(store.listRelations()[0]).toBe(relationReference);
    expect(store.getRevision()).toBe(revision);
    expect(persistenceState.saveCalls).toBe(1);
  });

  it("coalesces concurrent real changes without scheduling an extra no-op write", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    await store.ready();
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveReleased = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let signalFirstSave: (() => void) | undefined;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSave = resolve;
    });
    persistenceState.beforeSave = async () => {
      if (persistenceState.saveCalls === 1) {
        signalFirstSave?.();
        await firstSaveReleased;
      }
    };
    const sessionA = {
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-a",
        conversationId: "conversation-a",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      }
    } as const;
    const sessionB = {
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-b",
        conversationId: "conversation-b",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:02Z",
        updatedAt: "2026-04-18T00:00:02Z"
      }
    } as const;

    const firstWrite = store.upsertSession(sessionA);
    await firstSaveStarted;
    const secondWrite = store.upsertSession(sessionB);
    const noOpWrite = store.upsertSession(sessionB);
    releaseFirstSave?.();
    await Promise.all([firstWrite, secondWrite, noOpWrite]);

    expect(persistenceState.saveCalls).toBe(2);
    expect(store.getRevision()).toBe(3);
    const reloaded = new SessionIndexStore({ baseDir });
    await reloaded.ready();
    expect(reloaded.listEntries().map((entry) => entry.sessionId).sort()).toEqual([
      "session-a",
      "session-b"
    ]);
  });

  it("skips persistence for repeated unread and read states", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      }
    });

    await store.markSessionUnreadCompleted("session-1");
    const unreadRevision = store.getRevision();
    const unreadSaveCalls = persistenceState.saveCalls;
    await store.markSessionUnreadCompleted("session-1");
    expect(store.getRevision()).toBe(unreadRevision);
    expect(persistenceState.saveCalls).toBe(unreadSaveCalls);

    await store.markSessionRead("session-1");
    const readRevision = store.getRevision();
    const readSaveCalls = persistenceState.saveCalls;
    await store.markSessionRead("session-1");
    expect(store.getRevision()).toBe(readRevision);
    expect(persistenceState.saveCalls).toBe(readSaveCalls);
  });

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
