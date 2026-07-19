import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ChatSession, SessionRelationType } from "@another-workbench/shared";
import { loadJsonFile, saveJsonFile } from "./persistence-store.js";

const unreadStateSchema = z.enum(["read", "unread_completed"]);

const sessionIndexEntrySchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  conversationId: z.string().min(1),
  engineId: z.string().min(1),
  providerKind: z.string().min(1).optional(),
  providerSessionId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  summaryText: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastCompletedTurnAt: z.string().min(1).optional(),
  archivedAt: z.string().min(1).optional(),
  lastTurnId: z.string().min(1).optional(),
  unreadState: unreadStateSchema.default("read"),
  source: z.enum(["registry", "discovery", "reconciled"]).default("registry"),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const sessionRelationIndexSchema = z.object({
  workspaceId: z.string().min(1),
  parentSessionId: z.string().min(1),
  childSessionId: z.string().min(1),
  relationType: z.enum(["fork", "subagent", "handoff", "manual"]),
  sourceTurnId: z.string().min(1).optional(),
  createdAt: z.string().min(1)
});

const sessionIndexDocumentSchema = z.object({
  version: z.literal(1),
  entries: z.array(sessionIndexEntrySchema).default([]),
  relations: z.array(sessionRelationIndexSchema).default([])
});

export type SessionIndexEntry = z.infer<typeof sessionIndexEntrySchema>;
export type SessionRelationIndex = z.infer<typeof sessionRelationIndexSchema>;
export type SessionIndexDocument = z.infer<typeof sessionIndexDocumentSchema>;
export type SessionUnreadState = z.infer<typeof unreadStateSchema>;

type Clock = () => string;

export type SessionIndexStoreOptions = {
  baseDir?: string;
  now?: Clock;
};

export type UpsertSessionIndexInput = {
  workspaceId: string;
  session: Pick<
    ChatSession,
    | "sessionId"
    | "conversationId"
    | "engineId"
    | "title"
    | "createdAt"
    | "updatedAt"
    | "archivedAt"
    | "lastTurnId"
    | "metadata"
  >;
  providerKind?: string;
  providerSessionId?: string;
  summaryText?: string;
  lastCompletedTurnAt?: string;
  unreadState?: SessionUnreadState;
  source?: SessionIndexEntry["source"];
};

export type UpsertSessionRelationInput = {
  workspaceId: string;
  parentSessionId: string;
  childSessionId: string;
  relationType: SessionRelationType;
  sourceTurnId?: string;
  createdAt?: string;
};

export type ReconcileWorkspaceInput = {
  workspaceId: string;
  entries: UpsertSessionIndexInput[];
  relations?: UpsertSessionRelationInput[];
};

const defaultBaseDir = (): string => join(homedir(), ".another-workbench");

const sortEntries = (entries: SessionIndexEntry[]): SessionIndexEntry[] =>
  [...entries].sort((left, right) => {
    const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return left.sessionId.localeCompare(right.sessionId);
  });

export class SessionIndexStore {
  private readonly filePath: string;
  private readonly now: Clock;
  private document: SessionIndexDocument = {
    version: 1,
    entries: [],
    relations: []
  };
  private loadPromise: Promise<void> | undefined;
  private persistPromise: Promise<void> | undefined;
  private persistRequested = false;
  private revision = 0;

  public constructor(options: SessionIndexStoreOptions = {}) {
    const baseDir = options.baseDir ?? defaultBaseDir();
    this.filePath = join(baseDir, "session-index.json");
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async ready(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  public getState(): SessionIndexDocument {
    return {
      ...this.document,
      entries: [...this.document.entries],
      relations: [...this.document.relations]
    };
  }

  public getRevision(): number {
    return this.revision;
  }

  public listEntries(workspaceId?: string): SessionIndexEntry[] {
    const entries = workspaceId
      ? this.document.entries.filter((entry) => entry.workspaceId === workspaceId)
      : this.document.entries;
    return sortEntries(entries);
  }

  public listRelations(workspaceId?: string): SessionRelationIndex[] {
    const relations = workspaceId
      ? this.document.relations.filter((relation) => relation.workspaceId === workspaceId)
      : this.document.relations;
    return [...relations];
  }

  public getEntry(sessionId: string): SessionIndexEntry | undefined {
    return this.document.entries.find((entry) => entry.sessionId === sessionId);
  }

  public listEntriesByProviderSessionId(
    providerSessionId: string,
    workspaceId?: string
  ): SessionIndexEntry[] {
    return sortEntries(
      this.document.entries.filter(
        (entry) =>
          entry.providerSessionId === providerSessionId &&
          (!workspaceId || entry.workspaceId === workspaceId)
      )
    );
  }

  public async upsertSession(input: UpsertSessionIndexInput): Promise<SessionIndexEntry> {
    await this.ready();
    const normalized = this.upsertSessionInMemory(input);
    await this.persist();
    return normalized;
  }

  private upsertSessionInMemory(input: UpsertSessionIndexInput): SessionIndexEntry {
    const existing = this.getEntry(input.session.sessionId);
    const normalized = sessionIndexEntrySchema.parse({
      workspaceId: input.workspaceId,
      sessionId: input.session.sessionId,
      conversationId: input.session.conversationId,
      engineId: input.session.engineId,
      providerKind: input.providerKind ?? existing?.providerKind,
      providerSessionId: input.providerSessionId ?? existing?.providerSessionId,
      title: input.session.title,
      summaryText:
        input.summaryText ?? existing?.summaryText,
      createdAt: input.session.createdAt,
      updatedAt: input.session.updatedAt,
      lastCompletedTurnAt:
        input.lastCompletedTurnAt ?? existing?.lastCompletedTurnAt,
      archivedAt: input.session.archivedAt,
      lastTurnId: input.session.lastTurnId,
      unreadState: input.unreadState ?? existing?.unreadState ?? "read",
      source: input.source ?? existing?.source ?? "registry",
      metadata: input.session.metadata
    });

    this.document = {
      ...this.document,
      entries: sortEntries(
        existing
          ? this.document.entries.map((entry) =>
              entry.sessionId === normalized.sessionId ? normalized : entry
            )
          : [...this.document.entries, normalized]
      )
    };
    return normalized;
  }

  public async reconcileWorkspace(
    input: ReconcileWorkspaceInput
  ): Promise<{
    workspaceId: string;
    sessionCount: number;
    relationCount: number;
  }> {
    await this.ready();

    for (const entry of input.entries) {
      this.upsertSessionInMemory(entry);
    }
    for (const relation of input.relations ?? []) {
      this.upsertRelationInMemory(relation);
    }
    await this.persist();

    return {
      workspaceId: input.workspaceId,
      sessionCount: input.entries.length,
      relationCount: input.relations?.length ?? 0
    };
  }

  public async archiveSession(
    sessionId: string,
    archivedAt = this.now()
  ): Promise<SessionIndexEntry | undefined> {
    await this.ready();
    const existing = this.getEntry(sessionId);
    if (!existing) {
      return undefined;
    }
    const archived = sessionIndexEntrySchema.parse({
      ...existing,
      archivedAt,
      updatedAt: archivedAt
    });
    this.document = {
      ...this.document,
      entries: sortEntries(
        this.document.entries.map((entry) =>
          entry.sessionId === sessionId ? archived : entry
        )
      )
    };
    await this.persist();
    return archived;
  }

  public async archiveSessions(
    sessionIds: readonly string[],
    archivedAt = this.now()
  ): Promise<SessionIndexEntry[]> {
    await this.ready();
    if (sessionIds.length === 0) {
      return [];
    }
    const targetIds = new Set(sessionIds);
    const archivedEntries: SessionIndexEntry[] = [];
    this.document = {
      ...this.document,
      entries: sortEntries(
        this.document.entries.map((entry) => {
          if (!targetIds.has(entry.sessionId)) {
            return entry;
          }
          const archived = sessionIndexEntrySchema.parse({
            ...entry,
            archivedAt,
            updatedAt: archivedAt
          });
          archivedEntries.push(archived);
          return archived;
        })
      )
    };
    await this.persist();
    return archivedEntries;
  }

  public async removeWorkspace(workspaceId: string): Promise<void> {
    await this.ready();
    this.document = {
      ...this.document,
      entries: this.document.entries.filter((entry) => entry.workspaceId !== workspaceId),
      relations: this.document.relations.filter(
        (relation) => relation.workspaceId !== workspaceId
      )
    };
    await this.persist();
  }

  public async markSessionRead(sessionId: string): Promise<SessionIndexEntry | undefined> {
    await this.ready();
    const existing = this.getEntry(sessionId);
    if (!existing) {
      return undefined;
    }
    if (existing.unreadState === "read") {
      return existing;
    }
    const updated = sessionIndexEntrySchema.parse({
      ...existing,
      unreadState: "read"
    });
    this.document = {
      ...this.document,
      entries: this.document.entries.map((entry) =>
        entry.sessionId === sessionId ? updated : entry
      )
    };
    await this.persist();
    return updated;
  }

  public async markSessionUnreadCompleted(
    sessionId: string
  ): Promise<SessionIndexEntry | undefined> {
    await this.ready();
    const existing = this.getEntry(sessionId);
    if (!existing) {
      return undefined;
    }
    if (existing.unreadState === "unread_completed") {
      return existing;
    }
    const updated = sessionIndexEntrySchema.parse({
      ...existing,
      unreadState: "unread_completed"
    });
    this.document = {
      ...this.document,
      entries: this.document.entries.map((entry) =>
        entry.sessionId === sessionId ? updated : entry
      )
    };
    await this.persist();
    return updated;
  }

  public async upsertRelation(
    input: UpsertSessionRelationInput
  ): Promise<SessionRelationIndex> {
    await this.ready();
    const normalized = this.upsertRelationInMemory(input);
    await this.persist();
    return normalized;
  }

  private upsertRelationInMemory(
    input: UpsertSessionRelationInput
  ): SessionRelationIndex {
    const normalized = sessionRelationIndexSchema.parse({
      workspaceId: input.workspaceId,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      relationType: input.relationType,
      sourceTurnId: input.sourceTurnId,
      createdAt: input.createdAt ?? this.now()
    });
    const existingIndex = this.document.relations.findIndex(
      (relation) =>
        relation.parentSessionId === normalized.parentSessionId &&
        relation.childSessionId === normalized.childSessionId &&
        relation.relationType === normalized.relationType
    );
    this.document = {
      ...this.document,
      relations:
        existingIndex >= 0
          ? this.document.relations.map((relation, index) =>
              index === existingIndex ? normalized : relation
            )
          : [...this.document.relations, normalized]
    };
    return normalized;
  }

  private async load(): Promise<void> {
    const loaded = await loadJsonFile<unknown>(this.filePath, {
      version: 1,
      entries: [],
      relations: []
    });
    const parsed = sessionIndexDocumentSchema.safeParse(loaded.value);
    this.document = parsed.success
      ? {
          ...parsed.data,
          entries: sortEntries(parsed.data.entries)
        }
      : {
          version: 1,
          entries: [],
          relations: []
        };
    this.revision += 1;
    if (loaded.corrupted || !parsed.success) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    this.revision += 1;
    this.persistRequested = true;
    if (!this.persistPromise) {
      this.persistPromise = this.flushPersistRequests().finally(() => {
        this.persistPromise = undefined;
      });
    }
    await this.persistPromise;
  }

  private async flushPersistRequests(): Promise<void> {
    while (this.persistRequested) {
      this.persistRequested = false;
      const snapshot: SessionIndexDocument = {
        ...this.document,
        entries: [...this.document.entries],
        relations: [...this.document.relations]
      };
      await saveJsonFile(this.filePath, snapshot);
    }
  }
}
