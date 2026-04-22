import type {
  RelayHostConnectInput,
  RelayHostRecord,
  RelayHostRegistrationInput,
  RelayHostSummary,
  RelayRegistryDocument
} from "./contracts.js";

type Clock = () => string;
type IdFactory = () => string;

export type RelayHostRegistryStore = {
  load(): Promise<RelayRegistryDocument | undefined>;
  save(document: RelayRegistryDocument): Promise<void>;
};

export type RelayHostRegistryOptions = {
  store?: RelayHostRegistryStore;
  now?: Clock;
  createHostId?: IdFactory;
  createConnectionId?: IdFactory;
};

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const cloneHostSummary = (host: RelayHostRecord): RelayHostSummary => ({
  hostId: host.hostId,
  label: host.label,
  capabilities: [...host.capabilities],
  status: host.status,
  updatedAt: host.updatedAt,
  lastConnectedAt: host.lastConnectedAt
});

const cloneHostRecord = (host: RelayHostRecord): RelayHostRecord => ({
  ...host,
  capabilities: [...host.capabilities],
  metadata: { ...host.metadata },
  activeConnection: host.activeConnection
    ? { ...host.activeConnection }
    : undefined
});

const cloneDocument = (document: RelayRegistryDocument): RelayRegistryDocument => ({
  version: document.version,
  hosts: document.hosts.map(cloneHostRecord)
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const dedupeStrings = (input: readonly string[]): string[] =>
  [...new Set(input.map((item) => item.trim()).filter(Boolean))];

const normalizeDocument = (
  value: RelayRegistryDocument | undefined
): RelayRegistryDocument => {
  if (!value || value.version !== 1 || !Array.isArray(value.hosts)) {
    return {
      version: 1,
      hosts: []
    };
  }

  const hosts = value.hosts.flatMap((host): RelayHostRecord[] => {
    if (!isRecord(host)) {
      return [];
    }
    if (
      typeof host.hostId !== "string" ||
      typeof host.label !== "string" ||
      typeof host.status !== "string" ||
      typeof host.createdAt !== "string" ||
      typeof host.updatedAt !== "string"
    ) {
      return [];
    }

    const activeConnection = isRecord(host.activeConnection)
      && typeof host.activeConnection.connectionId === "string"
      && typeof host.activeConnection.connectedAt === "string"
      ? {
          connectionId: host.activeConnection.connectionId,
          clientId:
            typeof host.activeConnection.clientId === "string"
              ? host.activeConnection.clientId
              : undefined,
          sessionId:
            typeof host.activeConnection.sessionId === "string"
              ? host.activeConnection.sessionId
              : undefined,
          connectedAt: host.activeConnection.connectedAt
        }
      : undefined;

    return [
      {
        hostId: host.hostId,
        label: host.label,
        capabilities: isStringArray(host.capabilities) ? [...host.capabilities] : [],
        metadata: isRecord(host.metadata) ? { ...host.metadata } : {},
        status: host.status === "connected" ? "connected" : "registered",
        createdAt: host.createdAt,
        updatedAt: host.updatedAt,
        lastConnectedAt:
          typeof host.lastConnectedAt === "string" ? host.lastConnectedAt : undefined,
        activeConnection
      }
    ];
  });

  return {
    version: 1,
    hosts
  };
};

export class InMemoryRelayHostRegistryStore implements RelayHostRegistryStore {
  private document: RelayRegistryDocument | undefined;

  public async load(): Promise<RelayRegistryDocument | undefined> {
    return this.document ? cloneDocument(this.document) : undefined;
  }

  public async save(document: RelayRegistryDocument): Promise<void> {
    this.document = cloneDocument(document);
  }
}

export class RelayHostRegistry {
  private readonly store: RelayHostRegistryStore;
  private readonly now: Clock;
  private readonly createHostId: IdFactory;
  private readonly createConnectionId: IdFactory;
  private document: RelayRegistryDocument = {
    version: 1,
    hosts: []
  };
  private readyPromise: Promise<void> | undefined;

  public constructor(options: RelayHostRegistryOptions = {}) {
    this.store = options.store ?? new InMemoryRelayHostRegistryStore();
    this.now = options.now ?? (() => new Date().toISOString());
    this.createHostId = options.createHostId ?? (() => createOpaqueId("host"));
    this.createConnectionId =
      options.createConnectionId ?? (() => createOpaqueId("connection"));
  }

  public async ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.load();
    }
    await this.readyPromise;
  }

  public listHosts(): RelayHostRecord[] {
    return this.document.hosts.map(cloneHostRecord);
  }

  public listHostSummaries(): RelayHostSummary[] {
    return this.document.hosts.map(cloneHostSummary);
  }

  public getHost(hostId: string): RelayHostRecord | undefined {
    const host = this.document.hosts.find((item) => item.hostId === hostId);
    return host ? cloneHostRecord(host) : undefined;
  }

  public snapshot(): RelayRegistryDocument {
    return cloneDocument(this.document);
  }

  public async registerHost(
    input: RelayHostRegistrationInput
  ): Promise<RelayHostRecord> {
    await this.ready();

    const hostId = input.hostId?.trim() || this.createHostId();
    const timestamp = this.now();
    const existing = this.document.hosts.find((host) => host.hostId === hostId);

    if (existing) {
      const updated: RelayHostRecord = {
        ...existing,
        label: input.label?.trim() || existing.label,
        capabilities: dedupeStrings(input.capabilities ?? existing.capabilities),
        metadata: input.metadata ? { ...input.metadata } : { ...existing.metadata },
        updatedAt: timestamp
      };
      this.document = {
        ...this.document,
        hosts: this.document.hosts.map((host) =>
          host.hostId === hostId ? updated : host
        )
      };
      await this.persist();
      return cloneHostRecord(updated);
    }

    const created: RelayHostRecord = {
      hostId,
      label: input.label?.trim() || hostId,
      capabilities: dedupeStrings(input.capabilities ?? []),
      metadata: input.metadata ? { ...input.metadata } : {},
      status: "registered",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    this.document = {
      ...this.document,
      hosts: [...this.document.hosts, created]
    };
    await this.persist();
    return cloneHostRecord(created);
  }

  public async connectHost(
    hostId: string,
    input: RelayHostConnectInput = {}
  ): Promise<RelayHostRecord | undefined> {
    await this.ready();
    const timestamp = this.now();
    const existing = this.document.hosts.find((host) => host.hostId === hostId);
    if (!existing) {
      return undefined;
    }

    const connected: RelayHostRecord = {
      ...existing,
      status: "connected",
      updatedAt: timestamp,
      lastConnectedAt: timestamp,
      activeConnection: {
        connectionId: this.createConnectionId(),
        clientId: input.clientId?.trim() || undefined,
        sessionId: input.sessionId?.trim() || undefined,
        connectedAt: timestamp
      }
    };

    this.document = {
      ...this.document,
      hosts: this.document.hosts.map((host) =>
        host.hostId === hostId ? connected : host
      )
    };
    await this.persist();
    return cloneHostRecord(connected);
  }

  public async disconnectHost(hostId: string): Promise<RelayHostRecord | undefined> {
    await this.ready();
    const timestamp = this.now();
    const existing = this.document.hosts.find((host) => host.hostId === hostId);
    if (!existing) {
      return undefined;
    }

    const disconnected: RelayHostRecord = {
      ...existing,
      status: "registered",
      updatedAt: timestamp,
      activeConnection: undefined
    };

    this.document = {
      ...this.document,
      hosts: this.document.hosts.map((host) =>
        host.hostId === hostId ? disconnected : host
      )
    };
    await this.persist();
    return cloneHostRecord(disconnected);
  }

  private async load(): Promise<void> {
    this.document = normalizeDocument(await this.store.load());
  }

  private async persist(): Promise<void> {
    await this.store.save(this.document);
  }
}
