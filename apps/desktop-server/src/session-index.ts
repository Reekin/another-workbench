import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ChatSession, SessionRelationType } from "@another-workbench/shared";
import {
  loadJsonFile,
  PersistentStoreCorruptionError,
  saveJsonFile
} from "./persistence-store.js";

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

export type RepairWorkspaceInput = {
  workspaceId: string;
  engineId: string;
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

const isSameSessionEntry = (
  left: SessionIndexEntry,
  right: SessionIndexEntry
): boolean =>
  left.workspaceId === right.workspaceId &&
  left.sessionId === right.sessionId &&
  left.conversationId === right.conversationId &&
  left.engineId === right.engineId &&
  left.providerKind === right.providerKind &&
  left.providerSessionId === right.providerSessionId &&
  left.title === right.title &&
  left.summaryText === right.summaryText &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt &&
  left.lastCompletedTurnAt === right.lastCompletedTurnAt &&
  left.archivedAt === right.archivedAt &&
  left.lastTurnId === right.lastTurnId &&
  left.unreadState === right.unreadState &&
  left.source === right.source &&
  isDeepStrictEqual(left.metadata, right.metadata);

const isSameSessionRelation = (
  left: SessionRelationIndex,
  right: SessionRelationIndex
): boolean =>
  left.workspaceId === right.workspaceId &&
  left.parentSessionId === right.parentSessionId &&
  left.childSessionId === right.childSessionId &&
  left.relationType === right.relationType &&
  left.sourceTurnId === right.sourceTurnId &&
  left.createdAt === right.createdAt;

const relationKey = (input: {
  parentSessionId: string;
  childSessionId: string;
  relationType: SessionRelationType;
}): string =>
  `${input.parentSessionId}\u0000${input.childSessionId}\u0000${input.relationType}`;

const repairBatchSize = 256;

const yieldRepairBatch = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

type MutationResult<T> = {
  value: T;
  changed: boolean;
};

const archiveSubagentSessions = (
  document: SessionIndexDocument,
  rootSessionIds: readonly string[],
  archivedAt?: string
): MutationResult<SessionIndexDocument> & { archivedEntries: SessionIndexEntry[] } => {
  const entriesBySessionId = new Map(
    document.entries.map((entry) => [entry.sessionId, entry] as const)
  );
  const childrenByParentId = new Map<string, string[]>();
  for (const relation of document.relations) {
    if (relation.relationType !== "subagent") {
      continue;
    }
    const children = childrenByParentId.get(relation.parentSessionId) ?? [];
    children.push(relation.childSessionId);
    childrenByParentId.set(relation.parentSessionId, children);
  }

  const queue = rootSessionIds.map((sessionId) => ({
    sessionId,
    inheritedArchivedAt: undefined as string | undefined
  }));
  const visited = new Set<string>();
  const archivedEntries: SessionIndexEntry[] = [];
  let changed = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.sessionId)) {
      continue;
    }
    const { sessionId, inheritedArchivedAt } = current;
    visited.add(sessionId);
    const entry = entriesBySessionId.get(sessionId);
    const effectiveArchivedAt = archivedAt ?? entry?.archivedAt ?? inheritedArchivedAt;
    if (!entry || !effectiveArchivedAt) {
      continue;
    }
    const archived = archivedAt || !entry.archivedAt
      ? {
          ...entry,
          archivedAt: effectiveArchivedAt,
          updatedAt:
            entry.updatedAt > effectiveArchivedAt ? entry.updatedAt : effectiveArchivedAt
        }
      : entry;
    if (archived !== entry) {
      entriesBySessionId.set(sessionId, archived);
      changed = true;
    }
    archivedEntries.push(archived);
    for (const childSessionId of childrenByParentId.get(sessionId) ?? []) {
      const child = entriesBySessionId.get(childSessionId);
      if (child?.workspaceId === entry.workspaceId) {
        queue.push({ sessionId: childSessionId, inheritedArchivedAt: effectiveArchivedAt });
      }
    }
  }
  return {
    value: changed
      ? {
          ...document,
          entries: sortEntries([...entriesBySessionId.values()])
        }
      : document,
    changed,
    archivedEntries
  };
};

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
    const mutation = this.upsertSessionInMemory(input);
    await this.persistMutation(mutation.changed);
    return mutation.value;
  }

  private upsertSessionInMemory(
    input: UpsertSessionIndexInput
  ): MutationResult<SessionIndexEntry> {
    const existing = this.getEntry(input.session.sessionId);
    const normalized = this.normalizeSessionEntry(input, existing);

    if (existing && isSameSessionEntry(existing, normalized)) {
      return {
        value: existing,
        changed: false
      };
    }

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
    return {
      value: normalized,
      changed: true
    };
  }

  private normalizeSessionEntry(
    input: UpsertSessionIndexInput,
    existing?: SessionIndexEntry
  ): SessionIndexEntry {
    return sessionIndexEntrySchema.parse({
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
  }

  public async applyWorkspaceRepair(
    input: RepairWorkspaceInput
  ): Promise<{
    workspaceId: string;
    sessionCount: number;
    relationCount: number;
  }> {
    await this.ready();
    for (;;) {
      const baseRevision = this.revision;
      const baseDocument = this.document;
      const entriesBySessionId = new Map(
        baseDocument.entries.map((entry) => [entry.sessionId, entry] as const)
      );
      const relationsByKey = new Map(
        baseDocument.relations.map((relation) => [relationKey(relation), relation] as const)
      );
      let changed = false;
      let processed = 0;
      for (const entry of input.entries) {
        const existing = entriesBySessionId.get(entry.session.sessionId);
        const normalized = this.normalizeSessionEntry(entry, existing);
        if (!existing || !isSameSessionEntry(existing, normalized)) {
          entriesBySessionId.set(normalized.sessionId, normalized);
          changed = true;
        }
        processed += 1;
        if (processed % repairBatchSize === 0) {
          await yieldRepairBatch();
        }
      }

      const discoveredProviderSessionIds = new Set(
        input.entries.flatMap((entry) =>
          entry.providerSessionId ? [entry.providerSessionId] : []
        )
      );
      const archivedAt = this.now();
      for (const [sessionId, existing] of entriesBySessionId) {
        if (
          existing.workspaceId === input.workspaceId &&
          existing.engineId === input.engineId &&
          existing.source === "reconciled" &&
          !existing.archivedAt &&
          existing.providerSessionId &&
          !discoveredProviderSessionIds.has(existing.providerSessionId)
        ) {
          entriesBySessionId.set(
            sessionId,
            sessionIndexEntrySchema.parse({
              ...existing,
              archivedAt,
              updatedAt: archivedAt
            })
          );
          changed = true;
        }
        processed += 1;
        if (processed % repairBatchSize === 0) {
          await yieldRepairBatch();
        }
      }

      for (const relation of input.relations ?? []) {
        const key = relationKey(relation);
        const existing = relationsByKey.get(key);
        const normalized = this.normalizeRelation(relation, existing);
        if (!existing || !isSameSessionRelation(existing, normalized)) {
          relationsByKey.set(key, normalized);
          changed = true;
        }
        processed += 1;
        if (processed % repairBatchSize === 0) {
          await yieldRepairBatch();
        }
      }

      if (this.revision !== baseRevision || this.document !== baseDocument) {
        continue;
      }
      if (changed) {
        this.document = {
          ...baseDocument,
          entries: sortEntries([...entriesBySessionId.values()]),
          relations: [...relationsByKey.values()]
        };
      }
      await this.persistMutation(changed);

      return {
        workspaceId: input.workspaceId,
        sessionCount: input.entries.length,
        relationCount: input.relations?.length ?? 0
      };
    }
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
    const result = archiveSubagentSessions(this.document, sessionIds, archivedAt);
    this.document = result.value;
    await this.persist();
    return result.archivedEntries;
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
    const mutation = this.upsertRelationInMemory(input);
    await this.persistMutation(mutation.changed);
    return mutation.value;
  }

  private upsertRelationInMemory(
    input: UpsertSessionRelationInput
  ): MutationResult<SessionRelationIndex> {
    const existingIndex = this.document.relations.findIndex(
      (relation) =>
        relation.parentSessionId === input.parentSessionId &&
        relation.childSessionId === input.childSessionId &&
        relation.relationType === input.relationType
    );
    const existing =
      existingIndex >= 0 ? this.document.relations[existingIndex] : undefined;
    const normalized = this.normalizeRelation(input, existing);
    if (existing && isSameSessionRelation(existing, normalized)) {
      return {
        value: existing,
        changed: false
      };
    }
    this.document = {
      ...this.document,
      relations:
        existingIndex >= 0
          ? this.document.relations.map((relation, index) =>
              index === existingIndex ? normalized : relation
            )
          : [...this.document.relations, normalized]
    };
    return {
      value: normalized,
      changed: true
    };
  }

  private normalizeRelation(
    input: UpsertSessionRelationInput,
    existing?: SessionRelationIndex
  ): SessionRelationIndex {
    return sessionRelationIndexSchema.parse({
      workspaceId: input.workspaceId,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      relationType: input.relationType,
      sourceTurnId: input.sourceTurnId,
      createdAt: input.createdAt ?? existing?.createdAt ?? this.now()
    });
  }

  private async load(): Promise<void> {
    const loaded = await loadJsonFile<unknown>(this.filePath, {
      version: 1,
      entries: [],
      relations: []
    });
    const parsed = sessionIndexDocumentSchema.safeParse(loaded.value);
    if (!parsed.success) {
      throw new PersistentStoreCorruptionError(this.filePath, parsed.error);
    }
    const normalized = archiveSubagentSessions(
      {
        ...parsed.data,
        entries: sortEntries(parsed.data.entries)
      },
      parsed.data.entries
        .filter((entry) => entry.archivedAt)
        .map((entry) => entry.sessionId)
    );
    this.document = normalized.value;
    this.revision += 1;
    if (normalized.changed) {
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

  private async persistMutation(changed: boolean): Promise<void> {
    if (changed) {
      await this.persist();
      return;
    }
    if (this.persistPromise) {
      await this.persistPromise;
    }
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
