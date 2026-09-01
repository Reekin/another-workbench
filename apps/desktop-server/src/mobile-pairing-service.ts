import { randomUUID } from "node:crypto";
import {
  parseMobilePairingCode,
  type MobilePairingCode
} from "@another-workbench/shared";

type Clock = () => string;
type IdFactory = () => string;
type CodeFactory = () => string;

export type MobilePairingServiceOptions = {
  hostId: string;
  now?: Clock;
  pairingTtlMs?: number;
  createPairingId?: IdFactory;
  createCode?: CodeFactory;
};

const defaultCreateId = (): string =>
  `pair-${randomUUID()}`;

const defaultCreateCode = (): string =>
  randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();

const toExpiresAt = (createdAt: string, ttlMs: number): string =>
  new Date(Date.parse(createdAt) + ttlMs).toISOString();

const isExpired = (pairing: MobilePairingCode, now: string): boolean =>
  Date.parse(pairing.expiresAt) <= Date.parse(now);

export class MobilePairingService {
  private readonly hostId: string;
  private readonly now: Clock;
  private readonly pairingTtlMs: number;
  private readonly createPairingId: IdFactory;
  private readonly createCode: CodeFactory;
  private readonly pairings = new Map<string, MobilePairingCode>();

  public constructor(options: MobilePairingServiceOptions) {
    this.hostId = options.hostId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60 * 1000;
    this.createPairingId = options.createPairingId ?? defaultCreateId;
    this.createCode = options.createCode ?? defaultCreateCode;
  }

  public issue(): MobilePairingCode {
    const createdAt = this.now();
    const pairing = parseMobilePairingCode({
      pairingId: this.createPairingId(),
      code: this.createCode(),
      hostId: this.hostId,
      createdAt,
      expiresAt: toExpiresAt(createdAt, this.pairingTtlMs)
    });
    this.pairings.set(pairing.pairingId, pairing);
    return pairing;
  }

  public listActive(): MobilePairingCode[] {
    const now = this.now();
    return Array.from(this.pairings.values()).filter(
      (pairing) =>
        !pairing.revokedAt &&
        !pairing.consumedAt &&
        !isExpired(pairing, now)
    );
  }

  public revoke(pairingId: string): MobilePairingCode | undefined {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) {
      return undefined;
    }
    const updated = parseMobilePairingCode({
      ...pairing,
      revokedAt: this.now()
    });
    this.pairings.set(pairingId, updated);
    return updated;
  }

  public consumeByCode(code: string): MobilePairingCode | undefined {
    const now = this.now();
    for (const pairing of this.pairings.values()) {
      if (
        pairing.code === code &&
        !pairing.revokedAt &&
        !pairing.consumedAt &&
        !isExpired(pairing, now)
      ) {
        const consumed = parseMobilePairingCode({
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
