import { hostname } from "node:os";
import {
  parseWorkbenchBootstrap,
  type RemoteClientSurface,
  type WorkbenchBootstrap,
  type WorkbenchHostCapabilities,
  type WorkbenchHostDescriptor,
  type WorkbenchRelayDescriptor
} from "@another-workbench/shared";
import type { WorkbenchShellService } from "./workbench-shell-service.js";
import type { RemoteConnectionService } from "./remote-connection-service.js";

type Clock = () => string;

const SUPPORTED_CLIENT_SURFACES: RemoteClientSurface[] = [
  "desktop-full",
  "mobile-companion"
];

export type RemoteBootstrapServiceOptions = {
  shellService: WorkbenchShellService;
  connectionService: RemoteConnectionService;
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
  clientSurfaces: [...SUPPORTED_CLIENT_SURFACES],
  engineIds: shellService.listEngines().map((engine) => engine.engineId),
  supportsPairing: true,
  supportsResume: true,
  supportsResourceGateway: false
});

export class RemoteBootstrapService {
  private readonly shellService: WorkbenchShellService;
  private readonly connectionService: RemoteConnectionService;
  private readonly relay: WorkbenchRelayDescriptor;
  private readonly hostDescriptor: WorkbenchHostDescriptor;
  private readonly now: Clock;

  public constructor(options: RemoteBootstrapServiceOptions) {
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

  public buildBootstrap(
    clientSurface: RemoteClientSurface,
    authenticated = false
  ): WorkbenchBootstrap {
    const capabilities = createCapabilities(this.shellService);
    return parseWorkbenchBootstrap({
      serverInstanceId: this.hostDescriptor.serverInstanceId,
      relay: this.relay,
      host: {
        ...this.hostDescriptor,
        lastSeenAt: this.now()
      },
      capabilities,
      connection: this.connectionService.getSnapshot(),
      clientSurface,
      supportedClientSurfaces: [...capabilities.clientSurfaces],
      authenticated,
      version: {
        protocolVersion: "2026-04-remote-v1",
        appVersion: this.hostDescriptor.appVersion
      }
    });
  }
}
