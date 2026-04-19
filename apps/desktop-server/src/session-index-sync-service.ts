import type {
  SessionIndexStore,
  UpsertSessionRelationInput
} from "./session-index.js";
import type { SessionIndexSyncRecord } from "./runtime-types.js";

export type SessionIndexSyncServiceOptions = {
  sessionIndexStore?: SessionIndexStore;
  resolveSessionRecord: (sessionId: string) => SessionIndexSyncRecord | undefined;
};

export class SessionIndexSyncService {
  private readonly sessionIndexStore?: SessionIndexStore;
  private readonly resolveSessionRecord: (
    sessionId: string
  ) => SessionIndexSyncRecord | undefined;

  public constructor(options: SessionIndexSyncServiceOptions) {
    this.sessionIndexStore = options.sessionIndexStore;
    this.resolveSessionRecord = options.resolveSessionRecord;
  }

  public async syncSession(sessionId: string): Promise<void> {
    if (!this.sessionIndexStore) {
      return;
    }
    const record = this.resolveSessionRecord(sessionId);
    if (!record?.workspaceId) {
      return;
    }

    await this.sessionIndexStore.upsertSession({
      workspaceId: record.workspaceId,
      session: record.session,
      providerKind: record.providerKind,
      providerSessionId: record.providerSessionId
    });
  }

  public async syncRelation(input: UpsertSessionRelationInput): Promise<void> {
    if (!this.sessionIndexStore) {
      return;
    }
    await this.sessionIndexStore.upsertRelation(input);
  }

  public async markSessionUnreadCompleted(sessionId: string): Promise<void> {
    if (!this.sessionIndexStore) {
      return;
    }
    await this.sessionIndexStore.markSessionUnreadCompleted(sessionId);
  }
}
