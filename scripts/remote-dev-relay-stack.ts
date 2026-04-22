import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostRelayClient } from "../apps/desktop-server/src/host-relay-client.js";
import { RemoteAuthSessionService } from "../apps/desktop-server/src/remote-auth-session-service.js";
import { RemoteBootstrapService } from "../apps/desktop-server/src/remote-bootstrap-service.js";
import { RemoteConnectionService } from "../apps/desktop-server/src/remote-connection-service.js";
import { RemotePairingService } from "../apps/desktop-server/src/remote-pairing-service.js";
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
  const persistenceBaseDir = mkdtempSync(join(tmpdir(), "awb-relay-dev-"));
  const shell = createWorkbenchRuntimeService({
    persistenceBaseDir
  });
  const connection = new RemoteConnectionService({
    hostId,
    relayId
  });
  const pairing = new RemotePairingService({
    hostId,
    createPairingId: () => "relay-dev-pair",
    createCode: () => "RDEV01"
  });
  const authSessions = new RemoteAuthSessionService({
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
    bootstrapService: new RemoteBootstrapService({
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
    const issuedPairing = pairing.issue("desktop-full");
    const session = authSessions.issueFromPairing(issuedPairing);

    const remoteHeaders = JSON.stringify({
      authorization: `Bearer ${session.sessionToken}`,
      "x-workbench-host-id": hostId
    });
    const desktopUrl = `http://127.0.0.1:4173/?workbenchMode=remote&workbenchRemoteUrl=${encodeURIComponent(relayBaseUrl)}&workbenchRemoteHeaders=${encodeURIComponent(remoteHeaders)}`;

    console.log(
      JSON.stringify(
        {
          ok: true,
          relayBaseUrl,
          relayWsBaseUrl,
          hostId,
          tunnel,
          sessionToken: session.sessionToken,
          resumeToken: session.resumeToken,
          pairingCode: issuedPairing.code,
          desktopUrl
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
