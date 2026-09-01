import { randomUUID } from "node:crypto";
import {
  parseMobileSessionToken,
  type MobilePairingCode,
  type MobileSessionToken
} from "@another-workbench/shared";

type Clock = () => string;
type IdFactory = () => string;

export type MobileAuthSessionServiceOptions = {
  hostId: string;
  now?: Clock;
  sessionTtlMs?: number;
  createToken?: IdFactory;
  createClientId?: IdFactory;
};

const defaultCreateToken = (): string =>
  `tok-${randomUUID()}-${randomUUID()}`;

const defaultCreateClientId = (): string =>
  `client-${randomUUID()}`;

const toExpiresAt = (issuedAt: string, ttlMs: number): string =>
  new Date(Date.parse(issuedAt) + ttlMs).toISOString();

const isExpired = (record: MobileSessionToken, now: string): boolean =>
  Date.parse(record.expiresAt) <= Date.parse(now);

export class MobileAuthSessionService {
  private readonly hostId: string;
  private readonly now: Clock;
  private readonly sessionTtlMs: number;
  private readonly createToken: IdFactory;
  private readonly createClientId: IdFactory;
  private readonly sessionsByToken = new Map<string, MobileSessionToken>();
  private readonly sessionsByResumeToken = new Map<
    string,
    MobileSessionToken
  >();

  public constructor(options: MobileAuthSessionServiceOptions) {
    this.hostId = options.hostId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.createToken = options.createToken ?? defaultCreateToken;
    this.createClientId = options.createClientId ?? defaultCreateClientId;
  }

  public issueFromPairing(pairing: MobilePairingCode): MobileSessionToken {
    if (pairing.hostId !== this.hostId) {
      throw new Error("Pairing code belongs to a different host.");
    }
    const issuedAt = this.now();
    const session = parseMobileSessionToken({
      sessionToken: this.createToken(),
      resumeToken: this.createToken(),
      clientId: this.createClientId(),
      hostId: this.hostId,
      pairingId: pairing.pairingId,
      issuedAt,
      expiresAt: toExpiresAt(issuedAt, this.sessionTtlMs)
    });
    this.sessionsByToken.set(session.sessionToken, session);
    this.sessionsByResumeToken.set(session.resumeToken, session);
    return session;
  }

  public validateSessionToken(
    token: string
  ): MobileSessionToken | undefined {
    return this.validateRecord(this.sessionsByToken.get(token));
  }

  public validateResumeToken(
    token: string
  ): MobileSessionToken | undefined {
    return this.validateRecord(this.sessionsByResumeToken.get(token));
  }

  public revokeSession(sessionToken: string): MobileSessionToken | undefined {
    const session = this.sessionsByToken.get(sessionToken);
    if (!session) {
      return undefined;
    }
    const revoked = parseMobileSessionToken({
      ...session,
      revokedAt: this.now()
    });
    this.sessionsByToken.set(revoked.sessionToken, revoked);
    this.sessionsByResumeToken.set(revoked.resumeToken, revoked);
    return revoked;
  }

  private validateRecord(
    record: MobileSessionToken | undefined
  ): MobileSessionToken | undefined {
    if (!record) {
      return undefined;
    }
    if (record.revokedAt || isExpired(record, this.now())) {
      return undefined;
    }
    return record;
  }
}
