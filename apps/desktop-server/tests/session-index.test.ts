import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  it("persists a changed repair once and skips an identical repair", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const input = {
      workspaceId: "workspace-1",
      engineId: "codex",
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
    await store.applyWorkspaceRepair(input);
    expect(store.getRevision()).toBe(initialRevision + 1);
    expect(persistenceState.saveCalls).toBe(1);

    const entryReferences = store.listEntries();
    const relationReference = store.listRelations()[0];
    const revision = store.getRevision();
    await store.applyWorkspaceRepair(input);

    expect(store.listEntries()[0]).toBe(entryReferences[0]);
    expect(store.listEntries()[1]).toBe(entryReferences[1]);
    expect(store.listRelations()[0]).toBe(relationReference);
    expect(store.getRevision()).toBe(revision);
    expect(persistenceState.saveCalls).toBe(1);
  });

  it("commits provider updates and stale archival in one repair mutation", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({
      baseDir,
      now: () => "2026-08-08T00:00:00.000Z"
    });
    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-stale",
        conversationId: "conversation-stale",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-stale",
      unreadState: "unread_completed",
      source: "reconciled"
    });
    await store.upsertSession({
      workspaceId: "workspace-2",
      session: {
        sessionId: "session-other-workspace",
        conversationId: "conversation-other",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      },
      providerKind: "codex-thread",
      providerSessionId: "thread-other",
      source: "reconciled"
    });
    const revision = store.getRevision();
    const saveCalls = persistenceState.saveCalls;

    await store.applyWorkspaceRepair({
      workspaceId: "workspace-1",
      engineId: "codex",
      entries: [
        {
          workspaceId: "workspace-1",
          session: {
            sessionId: "session-fresh",
            conversationId: "conversation-fresh",
            engineId: "codex",
            createdAt: "2026-08-08T00:00:01Z",
            updatedAt: "2026-08-08T00:00:01Z"
          },
          providerKind: "codex-thread",
          providerSessionId: "thread-fresh",
          source: "reconciled"
        }
      ]
    });

    expect(store.getRevision()).toBe(revision + 1);
    expect(persistenceState.saveCalls).toBe(saveCalls + 1);
    expect(store.getEntry("session-stale")).toMatchObject({
      archivedAt: "2026-08-08T00:00:00.000Z",
      unreadState: "unread_completed"
    });
    expect(store.getEntry("session-fresh")?.archivedAt).toBeUndefined();
    expect(store.getEntry("session-other-workspace")?.archivedAt).toBeUndefined();
  });

  it("leaves the catalog unchanged when a repair batch is invalid", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-existing",
        conversationId: "conversation-existing",
        engineId: "codex",
        createdAt: "2026-04-18T00:00:01Z",
        updatedAt: "2026-04-18T00:00:01Z"
      }
    });
    const state = store.getState();
    const revision = store.getRevision();
    const saveCalls = persistenceState.saveCalls;

    await expect(
      store.applyWorkspaceRepair({
        workspaceId: "workspace-1",
        engineId: "codex",
        entries: [
          {
            workspaceId: "workspace-1",
            session: {
              sessionId: "session-valid",
              conversationId: "conversation-valid",
              engineId: "codex",
              createdAt: "2026-08-08T00:00:01Z",
              updatedAt: "2026-08-08T00:00:01Z"
            }
          },
          {
            workspaceId: "workspace-1",
            session: {
              sessionId: "session-invalid",
              conversationId: "conversation-invalid",
              engineId: "codex",
              title: "",
              createdAt: "2026-08-08T00:00:02Z",
              updatedAt: "2026-08-08T00:00:02Z"
            }
          }
        ]
      })
    ).rejects.toThrow();

    expect(store.getState()).toEqual(state);
    expect(store.getRevision()).toBe(revision);
    expect(persistenceState.saveCalls).toBe(saveCalls);
  });

  it("repairs an eight-thousand-entry catalog without quadratic blocking", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const entries = Array.from({ length: 8_382 }, (_, index) => ({
      workspaceId: "workspace-1",
      session: {
        sessionId: `session-${index}`,
        conversationId: `conversation-${index}`,
        engineId: "codex",
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: `2026-08-08T00:${String(index % 60).padStart(2, "0")}:00.000Z`
      },
      providerKind: "codex-thread",
      providerSessionId: `thread-${index}`,
      source: "reconciled" as const
    }));
    const startedAt = Date.now();
    let repairFinished = false;

    const repair = store.applyWorkspaceRepair({
      workspaceId: "workspace-1",
      engineId: "codex",
      entries
    }).then(() => {
      repairFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(repairFinished).toBe(false);
    await repair;

    expect(store.listEntries("workspace-1")).toHaveLength(8_382);
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 15_000);

  it("restarts a yielded repair when another catalog mutation commits", async () => {
    const baseDir = await createTempDir();
    const store = new SessionIndexStore({ baseDir });
    const repair = store.applyWorkspaceRepair({
      workspaceId: "workspace-1",
      engineId: "codex",
      entries: Array.from({ length: 1_024 }, (_, index) => ({
        workspaceId: "workspace-1",
        session: {
          sessionId: `session-repair-${index}`,
          conversationId: `conversation-repair-${index}`,
          engineId: "codex",
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z"
        },
        providerKind: "codex-thread",
        providerSessionId: `thread-repair-${index}`,
        source: "reconciled" as const
      }))
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.upsertSession({
      workspaceId: "workspace-1",
      session: {
        sessionId: "session-live",
        conversationId: "conversation-live",
        engineId: "codex",
        createdAt: "2026-08-08T00:00:01.000Z",
        updatedAt: "2026-08-08T00:00:01.000Z"
      },
      source: "registry"
    });
    await repair;

    expect(store.getEntry("session-live")).toBeDefined();
    expect(store.getEntry("session-repair-1023")).toBeDefined();
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

  it("archives subagent descendants recursively without archiving forks", async () => {
    const store = new SessionIndexStore({ baseDir: await createTempDir() });
    const sessionIds = ["root", "child", "grandchild", "fork"];
    await store.applyWorkspaceRepair({
      workspaceId: "workspace-1",
      engineId: "codex",
      entries: sessionIds.map((sessionId) => ({
        workspaceId: "workspace-1",
        session: {
          sessionId,
          conversationId: "conversation-1",
          engineId: "codex",
          createdAt: "2026-08-09T00:00:00Z",
          updatedAt: "2026-08-09T00:00:00Z"
        }
      })),
      relations: [
        ["root", "child", "subagent"],
        ["child", "grandchild", "subagent"],
        ["root", "fork", "fork"]
      ].map(([parentSessionId, childSessionId, relationType]) => ({
        workspaceId: "workspace-1",
        parentSessionId,
        childSessionId,
        relationType: relationType as "subagent" | "fork"
      }))
    });

    const archived = await store.archiveSessions(["root"], "2026-08-09T00:10:00Z");

    expect(archived.map((entry) => entry.sessionId).sort()).toEqual([
      "child",
      "grandchild",
      "root"
    ]);
    expect(store.getEntry("fork")?.archivedAt).toBeUndefined();
  });

  it("rejects invalid persisted data without replacing it", async () => {
    const baseDir = await createTempDir();
    const filePath = join(baseDir, "session-index.json");
    await writeFile(filePath, "{\"broken\": true}", "utf8");

    const store = new SessionIndexStore({
      baseDir
    });
    await expect(store.ready()).rejects.toThrow("Failed to read persistent store");

    expect(await readFile(filePath, "utf8")).toBe("{\"broken\": true}");
  });

  it("restores a truncated session index from the last valid backup", async () => {
    const baseDir = await createTempDir();
    const filePath = join(baseDir, "session-index.json");
    await writeFile(filePath, "{\"version\":1,\"entries\":[", "utf8");
    await writeFile(
      `${filePath}.bak`,
      JSON.stringify({
        version: 1,
        entries: [
          {
            workspaceId: "workspace-1",
            sessionId: "session-restored",
            conversationId: "conversation-restored",
            engineId: "codex",
            title: "Restored",
            createdAt: "2026-08-30T00:00:00Z",
            updatedAt: "2026-08-30T00:00:00Z",
            unreadState: "read",
            source: "registry"
          }
        ],
        relations: []
      }),
      "utf8"
    );

    const store = new SessionIndexStore({ baseDir });
    await store.ready();

    expect(store.getEntry("session-restored")?.title).toBe("Restored");
    expect(
      (JSON.parse(await readFile(filePath, "utf8")) as { entries: unknown[] }).entries
    ).toHaveLength(1);
    expect(persistenceState.saveCalls).toBe(0);
    expect((await readdir(baseDir)).some((name) => name.startsWith("session-index.json.corrupt-")))
      .toBe(true);
  });

  it("repairs unarchived subagent descendants of archived sessions on load", async () => {
    const baseDir = await createTempDir();
    const filePath = join(baseDir, "session-index.json");
    const entry = (sessionId: string, archivedAt?: string) => ({
      workspaceId: "workspace-1",
      sessionId,
      conversationId: "conversation-1",
      engineId: "codex",
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:00Z",
      archivedAt,
      unreadState: "read",
      source: "registry"
    });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          entry("session-root", "2026-08-09T00:10:00Z"),
          entry("session-child"),
          entry("session-grandchild"),
          entry("session-fork")
        ],
        relations: [
          {
            workspaceId: "workspace-1",
            parentSessionId: "session-root",
            childSessionId: "session-child",
            relationType: "subagent",
            createdAt: "2026-08-09T00:01:00Z"
          },
          {
            workspaceId: "workspace-1",
            parentSessionId: "session-child",
            childSessionId: "session-grandchild",
            relationType: "subagent",
            createdAt: "2026-08-09T00:02:00Z"
          },
          {
            workspaceId: "workspace-1",
            parentSessionId: "session-root",
            childSessionId: "session-fork",
            relationType: "fork",
            createdAt: "2026-08-09T00:03:00Z"
          }
        ]
      }),
      "utf8"
    );

    const store = new SessionIndexStore({ baseDir });
    await store.ready();

    expect(store.getEntry("session-child")?.archivedAt).toBe("2026-08-09T00:10:00Z");
    expect(store.getEntry("session-grandchild")?.archivedAt).toBe(
      "2026-08-09T00:10:00Z"
    );
    expect(store.getEntry("session-fork")?.archivedAt).toBeUndefined();
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Array<{ sessionId: string; archivedAt?: string }>;
    };
    expect(
      persisted.entries.find((candidate) => candidate.sessionId === "session-child")
        ?.archivedAt
    ).toBe("2026-08-09T00:10:00Z");
  });
});
