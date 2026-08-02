import type {
  SessionBrowserItemRpc,
  SessionBrowserPageRpc,
  SessionBrowserPathRpc
} from "@another-workbench/shared";

export type SessionBrowserReadModelSeed = SessionBrowserItemRpc & {
  workspaceId: string;
  sortAt: string;
};

type CursorPayload = {
  revision: string;
  offset: number;
  parentSessionId?: string;
};

export class SessionBrowserCursorStaleError extends Error {
  public readonly code = "CURSOR_STALE";

  public constructor() {
    super("The session browser cursor belongs to an outdated workspace revision.");
    this.name = "SessionBrowserCursorStaleError";
  }
}

const compareItems = (
  left: SessionBrowserReadModelSeed,
  right: SessionBrowserReadModelSeed
): number => {
  const bySortAt = right.sortAt.localeCompare(left.sortAt);
  return bySortAt !== 0 ? bySortAt : left.sessionId.localeCompare(right.sessionId);
};

const encodeCursor = (payload: CursorPayload): string =>
  encodeURIComponent(JSON.stringify(payload));

const decodeCursor = (cursor: string): CursorPayload => {
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor)) as Partial<CursorPayload>;
    if (
      typeof parsed.revision !== "string" ||
      !Number.isInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      (parsed.parentSessionId !== undefined && typeof parsed.parentSessionId !== "string")
    ) {
      throw new Error("invalid cursor");
    }
    return parsed as CursorPayload;
  } catch {
    throw new SessionBrowserCursorStaleError();
  }
};

const createRevision = (value: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
};

export class SessionBrowserReadModel {
  private readonly bySessionId = new Map<string, SessionBrowserReadModelSeed>();
  private readonly collections = new Map<string, SessionBrowserReadModelSeed[]>();
  private readonly revisions = new Map<string, string>();

  public constructor(seeds: readonly SessionBrowserReadModelSeed[]) {
    for (const seed of seeds) {
      this.bySessionId.set(seed.sessionId, seed);
      const key = this.collectionKey(seed.workspaceId, seed.parentSessionId);
      const collection = this.collections.get(key) ?? [];
      collection.push(seed);
      this.collections.set(key, collection);
    }

    for (const collection of this.collections.values()) {
      collection.sort(compareItems);
    }

    const workspaceIds = new Set(seeds.map((seed) => seed.workspaceId));
    for (const workspaceId of workspaceIds) {
      const workspaceSeeds = seeds
        .filter((seed) => seed.workspaceId === workspaceId)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
      const revision = createRevision(
        JSON.stringify(
          workspaceSeeds.map((seed) => [
            seed.sessionId,
            seed.parentSessionId,
            seed.title,
            seed.engineId,
            seed.statusDot,
            seed.isActive,
            seed.childCount,
            seed.lastCompletedTurnAt,
            seed.sortAt
          ])
        )
      );
      this.revisions.set(workspaceId, revision);
    }
  }

  public listRoots(input: {
    workspaceId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }): SessionBrowserPageRpc {
    return this.listPage({ ...input, parentSessionId: undefined });
  }

  public listChildren(input: {
    workspaceId: string;
    parentSessionId: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }): SessionBrowserPageRpc {
    return this.listPage(input);
  }

  public getPath(sessionId: string): SessionBrowserPathRpc {
    const selected = this.bySessionId.get(sessionId);
    if (!selected) {
      throw new Error(`Unknown browser session: ${sessionId}`);
    }
    const path: SessionBrowserReadModelSeed[] = [];
    const visited = new Set<string>();
    let current: SessionBrowserReadModelSeed | undefined = selected;
    while (current) {
      if (visited.has(current.sessionId)) {
        throw new Error(`Session browser relation cycle detected at ${current.sessionId}.`);
      }
      visited.add(current.sessionId);
      path.push(current);
      current = current.parentSessionId
        ? this.bySessionId.get(current.parentSessionId)
        : undefined;
    }
    return {
      workspaceId: selected.workspaceId,
      revision: this.revisionFor(selected.workspaceId),
      items: path.reverse().map((item) => this.toItem(item))
    };
  }

  private listPage(input: {
    workspaceId: string;
    parentSessionId?: string;
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
  }): SessionBrowserPageRpc {
    const revision = this.revisionFor(input.workspaceId);
    if (input.expectedRevision && input.expectedRevision !== revision) {
      throw new SessionBrowserCursorStaleError();
    }
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    if (
      cursor &&
      (cursor.revision !== revision || cursor.parentSessionId !== input.parentSessionId)
    ) {
      throw new SessionBrowserCursorStaleError();
    }
    const offset = cursor?.offset ?? 0;
    const collection = this.collections.get(
      this.collectionKey(input.workspaceId, input.parentSessionId)
    ) ?? [];
    const items = collection.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < collection.length;
    return {
      workspaceId: input.workspaceId,
      parentSessionId: input.parentSessionId,
      revision,
      items: items.map((item) => this.toItem(item)),
      nextCursor: hasMore
        ? encodeCursor({ revision, offset: nextOffset, parentSessionId: input.parentSessionId })
        : undefined,
      hasMore,
      totalCount: collection.length
    };
  }

  private revisionFor(workspaceId: string): string {
    return this.revisions.get(workspaceId) ?? createRevision(workspaceId);
  }

  private collectionKey(workspaceId: string, parentSessionId?: string): string {
    return `${workspaceId}\u0000${parentSessionId ?? ""}`;
  }

  private toItem(seed: SessionBrowserReadModelSeed): SessionBrowserItemRpc {
    return {
      sessionId: seed.sessionId,
      parentSessionId: seed.parentSessionId,
      engineId: seed.engineId,
      title: seed.title,
      statusDot: seed.statusDot,
      isActive: seed.isActive,
      childCount: seed.childCount,
      lastCompletedTurnAt: seed.lastCompletedTurnAt
    };
  }
}
