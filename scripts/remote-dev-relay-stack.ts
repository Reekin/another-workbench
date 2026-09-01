import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostRelayClient } from "../apps/desktop-server/src/host-relay-client.js";
import { HostRelayConnectionService } from "../apps/desktop-server/src/host-relay-connection-service.js";
import { MobileAuthSessionService } from "../apps/desktop-server/src/mobile-auth-session-service.js";
import { MobilePairingService } from "../apps/desktop-server/src/mobile-pairing-service.js";
import { MobileRemoteBootstrapService } from "../apps/desktop-server/src/mobile-remote-bootstrap-service.js";
import { createWorkbenchRuntimeService } from "../apps/desktop-server/src/prod-service.js";
import { WorkbenchRemoteServer } from "../apps/desktop-server/src/remote-server.js";
import { RelayServer } from "../apps/relay-server/src/index.js";

const waitForSignal = async (): Promise<NodeJS.Signals> =>
  new Promise((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });

const run = async (): Promise<void> => {
  const hostId = "relay-dev-host";
  const relayId = "relay-dev";
  const hostAuthToken = "relay-dev-host-auth";
  const persistenceBaseDir = mkdtempSync(join(tmpdir(), "awb-relay-dev-"));
  const shell = createWorkbenchRuntimeService({
    persistenceBaseDir
  });
  const connection = new HostRelayConnectionService({
    hostId,
    relayId
  });
  const pairing = new MobilePairingService({
    hostId,
    createPairingId: () => "relay-dev-pair",
    createCode: () => "RDEV01"
  });
  const authSessions = new MobileAuthSessionService({
    hostId,
    createToken: (() => {
      let index = 0;
      return () => `relay-dev-token-${++index}`;
    })(),
    createClientId: () => "relay-dev-client"
  });
  const hostServer = new WorkbenchRemoteServer({
    service: shell,
    host: "127.0.0.1",
    port: 0,
    bootstrapService: new MobileRemoteBootstrapService({
      shellService: shell,
      connectionService: connection,
      relay: {
        relayId,
        label: "Relay Dev",
        httpBaseUrl: "https://relay.example.test",
        wsBaseUrl: "wss://relay.example.test"
      },
      host: {
        hostId,
        label: "Relay Dev Host",
        appVersion: "0.1.0",
        serverInstanceId: "relay-dev-srv"
      }
    }),
    pairingService: pairing,
    authSessions
  });
  const relay = new RelayServer({
    hostTokens: {
      [hostId]: hostAuthToken
    },
    host: "127.0.0.1",
    port: 0
  });

  let hostClient: HostRelayClient | undefined;

  try {
    await hostServer.listen();
    const hostAddress = hostServer.getHttpServer().address() as AddressInfo;

    const relayListening = await relay.listen();
    const relayBaseUrl = `http://${relayListening.host}:${relayListening.port}`;
    const relayWsBaseUrl = relayBaseUrl.replace("http://", "ws://");

    hostClient = new HostRelayClient({
      relay: {
        relayId,
        label: "Relay Dev",
        httpBaseUrl: relayBaseUrl,
        wsBaseUrl: relayWsBaseUrl
      },
      connectionService: connection,
      authToken: hostAuthToken,
      getHostDescriptor: () => ({
        hostId,
        label: "Relay Dev Host",
        deviceName: "relay-dev-box",
        platform: process.platform,
        appVersion: "0.1.0",
        serverInstanceId: "relay-dev-srv",
        online: true,
        lastSeenAt: "2026-04-21T11:00:00.000Z"
      }),
      localHttpBaseUrl: `http://127.0.0.1:${hostAddress.port}`,
      localEventsUrl: `ws://127.0.0.1:${hostAddress.port}/events`
    });

    const tunnel = await hostClient.connect();
    const issuedPairing = pairing.issue();

    console.log(
      JSON.stringify(
        {
          ok: true,
          relayBaseUrl,
          relayWsBaseUrl,
          hostId,
          tunnel,
          pairingCode: issuedPairing.code
        },
        null,
        2
      )
    );

    await waitForSignal();
  } finally {
    hostClient?.close();
    await shell.dispose().catch(() => undefined);
    await hostServer.close().catch(() => undefined);
    await relay.close().catch(() => undefined);
  }
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
