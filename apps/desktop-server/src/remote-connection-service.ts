import {
  parseWorkbenchConnectionSnapshot,
  type WorkbenchConnectionSnapshot,
  type WorkbenchConnectionState
} from "@another-workbench/shared";

type Clock = () => string;

export type RemoteConnectionServiceOptions = {
  now?: Clock;
  hostId: string;
  relayId?: string;
};

export type UpdateRemoteConnectionInput = {
  state: WorkbenchConnectionState;
  routeId?: string;
  authenticated?: boolean;
  authorizedClientId?: string;
  lastCursor?: string;
  resumeToken?: string;
  reconnectAfterMs?: number;
  stale?: boolean;
  reason?: string;
};

export class RemoteConnectionService {
  private readonly now: Clock;
  private snapshot: WorkbenchConnectionSnapshot;

  public constructor(options: RemoteConnectionServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.snapshot = parseWorkbenchConnectionSnapshot({
      state: "idle",
      hostId: options.hostId,
      relayId: options.relayId,
      authenticated: false,
      stale: false,
      updatedAt: this.now()
    });
  }

  public getSnapshot(): WorkbenchConnectionSnapshot {
    return this.snapshot;
  }

  public update(input: UpdateRemoteConnectionInput): WorkbenchConnectionSnapshot {
    this.snapshot = parseWorkbenchConnectionSnapshot({
      ...this.snapshot,
      ...input,
      updatedAt: this.now()
    });
    return this.snapshot;
  }

  public markUnauthorized(reason = "unauthorized"): WorkbenchConnectionSnapshot {
    return this.update({
      state: "unauthorized",
      authenticated: false,
      authorizedClientId: undefined,
      reason
    });
  }

  public close(reason = "closed"): WorkbenchConnectionSnapshot {
    return this.update({
      state: "closed",
      authenticated: false,
      authorizedClientId: undefined,
      stale: true,
      reason
    });
  }
}
