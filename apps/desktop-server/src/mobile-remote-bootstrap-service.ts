import { hostname } from "node:os";
import {
  parseMobileRemoteBootstrap,
  type MobileRemoteBootstrap,
  type WorkbenchHostCapabilities,
  type WorkbenchHostDescriptor,
  type WorkbenchRelayDescriptor
} from "@another-workbench/shared";
import type { WorkbenchShellService } from "./workbench-shell-service.js";
import type { HostRelayConnectionService } from "./host-relay-connection-service.js";

type Clock = () => string;

export type MobileRemoteBootstrapServiceOptions = {
  shellService: WorkbenchShellService;
  connectionService: HostRelayConnectionService;
  relay: WorkbenchRelayDescriptor;
  host: {
    hostId: string;
    label: string;
    appVersion: string;
    serverInstanceId: string;
    platform?: string;
    deviceName?: string;
  };
  now?: Clock;
};

const createCapabilities = (
  shellService: WorkbenchShellService
): WorkbenchHostCapabilities => ({
  engineIds: shellService.listEngines().map((engine) => engine.engineId),
  supportsPairing: true,
  supportsResume: true,
  supportsResourceGateway: false
});

export class MobileRemoteBootstrapService {
  private readonly shellService: WorkbenchShellService;
  private readonly connectionService: HostRelayConnectionService;
  private readonly relay: WorkbenchRelayDescriptor;
  private readonly hostDescriptor: WorkbenchHostDescriptor;
  private readonly now: Clock;

  public constructor(options: MobileRemoteBootstrapServiceOptions) {
    this.shellService = options.shellService;
    this.connectionService = options.connectionService;
    this.relay = options.relay;
    this.now = options.now ?? (() => new Date().toISOString());
    this.hostDescriptor = {
      hostId: options.host.hostId,
      label: options.host.label,
      deviceName: options.host.deviceName ?? hostname(),
      platform: options.host.platform ?? process.platform,
      appVersion: options.host.appVersion,
      serverInstanceId: options.host.serverInstanceId,
      online: true,
      lastSeenAt: this.now()
    };
  }

  public buildBootstrap(): MobileRemoteBootstrap {
    const capabilities = createCapabilities(this.shellService);
    return parseMobileRemoteBootstrap({
      serverInstanceId: this.hostDescriptor.serverInstanceId,
      relay: this.relay,
      host: {
        ...this.hostDescriptor,
        lastSeenAt: this.now()
      },
      capabilities,
      connection: this.connectionService.getSnapshot(),
      version: {
        protocolVersion: "2026-09-mobile-v1",
        appVersion: this.hostDescriptor.appVersion
      }
    });
  }
}
