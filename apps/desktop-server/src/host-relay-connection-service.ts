import {
  parseHostRelayConnectionSnapshot,
  type HostRelayConnectionSnapshot,
  type HostRelayConnectionState
} from "@another-workbench/shared";

type Clock = () => string;

export type HostRelayConnectionServiceOptions = {
  now?: Clock;
  hostId: string;
  relayId?: string;
};

export type UpdateHostRelayConnectionInput = {
  state: HostRelayConnectionState;
  routeId?: string;
  reconnectAfterMs?: number;
  stale?: boolean;
  reason?: string;
};

export class HostRelayConnectionService {
  private readonly now: Clock;
  private snapshot: HostRelayConnectionSnapshot;

  public constructor(options: HostRelayConnectionServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.snapshot = parseHostRelayConnectionSnapshot({
      state: "idle",
      hostId: options.hostId,
      relayId: options.relayId,
      stale: false,
      updatedAt: this.now()
    });
  }

  public getSnapshot(): HostRelayConnectionSnapshot {
    return this.snapshot;
  }

  public update(input: UpdateHostRelayConnectionInput): HostRelayConnectionSnapshot {
    this.snapshot = parseHostRelayConnectionSnapshot({
      ...this.snapshot,
      ...input,
      updatedAt: this.now()
    });
    return this.snapshot;
  }

  public markUnauthorized(reason = "unauthorized"): HostRelayConnectionSnapshot {
    return this.update({
      state: "unauthorized",
      reason
    });
  }

  public close(reason = "closed"): HostRelayConnectionSnapshot {
    return this.update({
      state: "closed",
      stale: true,
      reason
    });
  }
}
