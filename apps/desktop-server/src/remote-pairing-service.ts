import {
  parseWorkbenchPairingCode,
  type RemoteClientSurface,
  type WorkbenchPairingCode
} from "@another-workbench/shared";

type Clock = () => string;
type IdFactory = () => string;
type CodeFactory = () => string;

export type RemotePairingServiceOptions = {
  hostId: string;
  now?: Clock;
  pairingTtlMs?: number;
  createPairingId?: IdFactory;
  createCode?: CodeFactory;
};

const defaultCreateId = (): string =>
  `pair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const defaultCreateCode = (): string =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

const toExpiresAt = (createdAt: string, ttlMs: number): string =>
  new Date(Date.parse(createdAt) + ttlMs).toISOString();

const isExpired = (pairing: WorkbenchPairingCode, now: string): boolean =>
  Date.parse(pairing.expiresAt) <= Date.parse(now);

export class RemotePairingService {
  private readonly hostId: string;
  private readonly now: Clock;
  private readonly pairingTtlMs: number;
  private readonly createPairingId: IdFactory;
  private readonly createCode: CodeFactory;
  private readonly pairings = new Map<string, WorkbenchPairingCode>();

  public constructor(options: RemotePairingServiceOptions) {
    this.hostId = options.hostId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60 * 1000;
    this.createPairingId = options.createPairingId ?? defaultCreateId;
    this.createCode = options.createCode ?? defaultCreateCode;
  }

  public issue(clientSurface: RemoteClientSurface): WorkbenchPairingCode {
    const createdAt = this.now();
    const pairing = parseWorkbenchPairingCode({
      pairingId: this.createPairingId(),
      code: this.createCode(),
      hostId: this.hostId,
      clientSurface,
      createdAt,
      expiresAt: toExpiresAt(createdAt, this.pairingTtlMs)
    });
    this.pairings.set(pairing.pairingId, pairing);
    return pairing;
  }

  public listActive(): WorkbenchPairingCode[] {
    const now = this.now();
    return Array.from(this.pairings.values()).filter(
      (pairing) =>
        !pairing.revokedAt &&
        !pairing.consumedAt &&
        !isExpired(pairing, now)
    );
  }

  public revoke(pairingId: string): WorkbenchPairingCode | undefined {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) {
      return undefined;
    }
    const updated = parseWorkbenchPairingCode({
      ...pairing,
      revokedAt: this.now()
    });
    this.pairings.set(pairingId, updated);
    return updated;
  }

  public consumeByCode(input: {
    code: string;
    clientSurface: RemoteClientSurface;
  }): WorkbenchPairingCode | undefined {
    const now = this.now();
    for (const pairing of this.pairings.values()) {
      if (
        pairing.code === input.code &&
        pairing.clientSurface === input.clientSurface &&
        !pairing.revokedAt &&
        !pairing.consumedAt &&
        !isExpired(pairing, now)
      ) {
        const consumed = parseWorkbenchPairingCode({
          ...pairing,
          consumedAt: now
        });
        this.pairings.set(pairing.pairingId, consumed);
        return consumed;
      }
    }
    return undefined;
  }
}
