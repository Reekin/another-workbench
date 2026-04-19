import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { loadJsonFile, saveJsonFile } from "./persistence-store.js";

const workspaceRecordSchema = z.object({
  workspaceId: z.string().min(1),
  absolutePath: z.string().min(1),
  label: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

const workspaceRegistryDocumentSchema = z.object({
  version: z.literal(1),
  workspaces: z.array(workspaceRecordSchema).default([]),
  expandedWorkspaceIds: z.array(z.string().min(1)).default([]),
  expandedSessionIds: z.array(z.string().min(1)).default([]),
  lastActiveWorkspaceId: z.string().min(1).optional(),
  lastActiveSessionId: z.string().min(1).optional()
});

export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export type WorkspaceRegistryDocument = z.infer<
  typeof workspaceRegistryDocumentSchema
>;

type Clock = () => string;
type IdFactory = () => string;

export type WorkspaceRegistryServiceOptions = {
  baseDir?: string;
  now?: Clock;
  createWorkspaceId?: IdFactory;
};

export type WorkspaceRegistrationInput = {
  absolutePath: string;
  label?: string;
  workspaceId?: string;
};

const createOpaqueWorkspaceId = (): string =>
  `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const defaultBaseDir = (): string => join(homedir(), ".another-workbench");

const dedupeIds = (items: readonly string[]): string[] => [...new Set(items)];

export class WorkspaceRegistryService {
  private readonly filePath: string;
  private readonly now: Clock;
  private readonly createWorkspaceId: IdFactory;
  private document: WorkspaceRegistryDocument = {
    version: 1,
    workspaces: [],
    expandedWorkspaceIds: [],
    expandedSessionIds: []
  };
  private loadPromise: Promise<void> | undefined;

  public constructor(options: WorkspaceRegistryServiceOptions = {}) {
    const baseDir = options.baseDir ?? defaultBaseDir();
    this.filePath = join(baseDir, "workspace-registry.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.createWorkspaceId = options.createWorkspaceId ?? createOpaqueWorkspaceId;
  }

  public async ready(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  public listWorkspaces(): WorkspaceRecord[] {
    return [...this.document.workspaces];
  }

  public getWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    return this.document.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
  }

  public getState(): WorkspaceRegistryDocument {
    return {
      ...this.document,
      workspaces: [...this.document.workspaces],
      expandedWorkspaceIds: [...this.document.expandedWorkspaceIds],
      expandedSessionIds: [...this.document.expandedSessionIds]
    };
  }

  public async registerWorkspace(
    input: WorkspaceRegistrationInput
  ): Promise<WorkspaceRecord> {
    await this.ready();
    const normalizedPath = resolve(input.absolutePath);
    const existing = this.document.workspaces.find(
      (workspace) => workspace.absolutePath === normalizedPath
    );
    const timestamp = this.now();
    if (existing) {
      const updated = workspaceRecordSchema.parse({
        ...existing,
        label: input.label?.trim() || existing.label,
        updatedAt: timestamp
      });
      this.document = {
        ...this.document,
        workspaces: this.document.workspaces.map((workspace) =>
          workspace.workspaceId === updated.workspaceId ? updated : workspace
        )
      };
      await this.persist();
      return updated;
    }

    const created = workspaceRecordSchema.parse({
      workspaceId: input.workspaceId ?? this.createWorkspaceId(),
      absolutePath: normalizedPath,
      label:
        input.label?.trim() ||
        normalizedPath.split(/[/\\]/).filter(Boolean).at(-1) ||
        normalizedPath,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    this.document = {
      ...this.document,
      workspaces: [...this.document.workspaces, created]
    };
    await this.persist();
    return created;
  }

  public async reorderWorkspaces(workspaceIds: readonly string[]): Promise<void> {
    await this.ready();
    const knownIds = new Set(this.document.workspaces.map((workspace) => workspace.workspaceId));
    const prioritized = workspaceIds.filter((workspaceId) => knownIds.has(workspaceId));
    const orderedIds = dedupeIds([
      ...prioritized,
      ...this.document.workspaces.map((workspace) => workspace.workspaceId)
    ]);
    const byId = new Map(
      this.document.workspaces.map((workspace) => [workspace.workspaceId, workspace] as const)
    );
    this.document = {
      ...this.document,
      workspaces: orderedIds
        .map((workspaceId) => byId.get(workspaceId))
        .filter((workspace): workspace is WorkspaceRecord => Boolean(workspace))
    };
    await this.persist();
  }

  public async removeWorkspace(workspaceId: string): Promise<boolean> {
    await this.ready();
    const existed = this.document.workspaces.some(
      (workspace) => workspace.workspaceId === workspaceId
    );
    if (!existed) {
      return false;
    }

    this.document = {
      ...this.document,
      workspaces: this.document.workspaces.filter(
        (workspace) => workspace.workspaceId !== workspaceId
      ),
      expandedWorkspaceIds: this.document.expandedWorkspaceIds.filter(
        (value) => value !== workspaceId
      ),
      lastActiveWorkspaceId:
        this.document.lastActiveWorkspaceId === workspaceId
          ? undefined
          : this.document.lastActiveWorkspaceId,
      lastActiveSessionId:
        this.document.lastActiveWorkspaceId === workspaceId
          ? undefined
          : this.document.lastActiveSessionId
    };
    await this.persist();
    return true;
  }

  public async setWorkspaceExpanded(
    workspaceId: string,
    expanded: boolean
  ): Promise<void> {
    await this.ready();
    this.document = {
      ...this.document,
      expandedWorkspaceIds: expanded
        ? dedupeIds([...this.document.expandedWorkspaceIds, workspaceId])
        : this.document.expandedWorkspaceIds.filter((value) => value !== workspaceId)
    };
    await this.persist();
  }

  public async setSessionExpanded(
    sessionId: string,
    expanded: boolean
  ): Promise<void> {
    await this.ready();
    this.document = {
      ...this.document,
      expandedSessionIds: expanded
        ? dedupeIds([...this.document.expandedSessionIds, sessionId])
        : this.document.expandedSessionIds.filter((value) => value !== sessionId)
    };
    await this.persist();
  }

  public async setLastActiveSelection(input: {
    workspaceId?: string;
    sessionId?: string;
  }): Promise<void> {
    await this.ready();
    this.document = {
      ...this.document,
      lastActiveWorkspaceId: input.workspaceId,
      lastActiveSessionId: input.sessionId
    };
    await this.persist();
  }

  private async load(): Promise<void> {
    const loaded = await loadJsonFile<unknown>(this.filePath, {
      version: 1,
      workspaces: [],
      expandedWorkspaceIds: [],
      expandedSessionIds: []
    });
    const parsed = workspaceRegistryDocumentSchema.safeParse(loaded.value);
    this.document = parsed.success
      ? parsed.data
      : {
          version: 1,
          workspaces: [],
          expandedWorkspaceIds: [],
          expandedSessionIds: []
        };
    if (loaded.corrupted || !parsed.success) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await saveJsonFile(this.filePath, this.document);
  }
}
