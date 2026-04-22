import {
  parseWorkbenchSessionTokenPayload,
  type RemoteClientSurface,
  type WorkbenchPairingCode,
  type WorkbenchSessionTokenPayload
} from "@another-workbench/shared";

type Clock = () => string;
type IdFactory = () => string;

export type RemoteAuthSessionServiceOptions = {
  hostId: string;
  now?: Clock;
  sessionTtlMs?: number;
  createToken?: IdFactory;
  createClientId?: IdFactory;
};

const defaultCreateToken = (): string =>
  `tok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const defaultCreateClientId = (): string =>
  `client-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const toExpiresAt = (issuedAt: string, ttlMs: number): string =>
  new Date(Date.parse(issuedAt) + ttlMs).toISOString();

const isExpired = (record: WorkbenchSessionTokenPayload, now: string): boolean =>
  Date.parse(record.expiresAt) <= Date.parse(now);

const matchesSurface = (
  expected: RemoteClientSurface | undefined,
  actual: RemoteClientSurface
): boolean => !expected || expected === actual;

export class RemoteAuthSessionService {
  private readonly hostId: string;
  private readonly now: Clock;
  private readonly sessionTtlMs: number;
  private readonly createToken: IdFactory;
  private readonly createClientId: IdFactory;
  private readonly sessionsByToken = new Map<string, WorkbenchSessionTokenPayload>();
  private readonly sessionsByResumeToken = new Map<
    string,
    WorkbenchSessionTokenPayload
  >();
  private readonly sessionsByResourceToken = new Map<
    string,
    WorkbenchSessionTokenPayload
  >();

  public constructor(options: RemoteAuthSessionServiceOptions) {
    this.hostId = options.hostId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.createToken = options.createToken ?? defaultCreateToken;
    this.createClientId = options.createClientId ?? defaultCreateClientId;
  }

  public issueFromPairing(pairing: WorkbenchPairingCode): WorkbenchSessionTokenPayload {
    const issuedAt = this.now();
    const session = parseWorkbenchSessionTokenPayload({
      sessionToken: this.createToken(),
      resumeToken: this.createToken(),
      resourceToken: this.createToken(),
      clientId: this.createClientId(),
      hostId: this.hostId,
      pairingId: pairing.pairingId,
      clientSurface: pairing.clientSurface,
      issuedAt,
      expiresAt: toExpiresAt(issuedAt, this.sessionTtlMs)
    });
    this.sessionsByToken.set(session.sessionToken, session);
    this.sessionsByResumeToken.set(session.resumeToken, session);
    this.sessionsByResourceToken.set(session.resourceToken, session);
    return session;
  }

  public validateSessionToken(
    token: string,
    expectedSurface?: RemoteClientSurface
  ): WorkbenchSessionTokenPayload | undefined {
    return this.validateRecord(
      this.sessionsByToken.get(token),
      expectedSurface
    );
  }

  public validateResumeToken(
    token: string,
    expectedSurface?: RemoteClientSurface
  ): WorkbenchSessionTokenPayload | undefined {
    return this.validateRecord(
      this.sessionsByResumeToken.get(token),
      expectedSurface
    );
  }

  public validateResourceToken(
    token: string,
    expectedSurface?: RemoteClientSurface
  ): WorkbenchSessionTokenPayload | undefined {
    return this.validateRecord(
      this.sessionsByResourceToken.get(token),
      expectedSurface
    );
  }

  public revokeSession(sessionToken: string): WorkbenchSessionTokenPayload | undefined {
    const session = this.sessionsByToken.get(sessionToken);
    if (!session) {
      return undefined;
    }
    const revoked = parseWorkbenchSessionTokenPayload({
      ...session,
      revokedAt: this.now()
    });
    this.sessionsByToken.set(revoked.sessionToken, revoked);
    this.sessionsByResumeToken.set(revoked.resumeToken, revoked);
    this.sessionsByResourceToken.set(revoked.resourceToken, revoked);
    return revoked;
  }

  private validateRecord(
    record: WorkbenchSessionTokenPayload | undefined,
    expectedSurface?: RemoteClientSurface
  ): WorkbenchSessionTokenPayload | undefined {
    if (!record) {
      return undefined;
    }
    if (record.revokedAt || isExpired(record, this.now())) {
      return undefined;
    }
    if (!matchesSurface(expectedSurface, record.clientSurface)) {
      return undefined;
    }
    return record;
  }
}
