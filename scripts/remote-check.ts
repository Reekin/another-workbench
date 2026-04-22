import { createHash } from "node:crypto";
import {
  parseWorkbenchBootstrap,
  parseWorkbenchConnectionSnapshot,
  parseWorkbenchSessionTokenPayload
} from "../packages/shared/src/remote-control.js";
import { RemoteAuthSessionService } from "../apps/desktop-server/src/remote-auth-session-service.js";
import { RemoteBootstrapService } from "../apps/desktop-server/src/remote-bootstrap-service.js";
import { RemoteConnectionService } from "../apps/desktop-server/src/remote-connection-service.js";
import { RemotePairingService } from "../apps/desktop-server/src/remote-pairing-service.js";

const stableNow = (() => {
  let tick = 0;
  return () => `2026-04-21T00:00:${String(++tick).padStart(2, "0")}Z`;
})();

const shellService = {
  listEngines: () => [
    {
      engineId: "codex",
      displayName: "Codex",
      integrationTier: "native"
    }
  ]
} as const;

const run = async (): Promise<void> => {
  const connection = new RemoteConnectionService({
    hostId: "check-host",
    relayId: "check-relay",
    now: stableNow
  });
  const pairing = new RemotePairingService({
    hostId: "check-host",
    now: stableNow,
    createPairingId: () => "pair-check",
    createCode: () => "PAIR42"
  });
  const auth = new RemoteAuthSessionService({
    hostId: "check-host",
    now: stableNow,
    createToken: (() => {
      let index = 0;
      return () => `token-${++index}`;
    })(),
    createClientId: () => "client-check"
  });
  const bootstrap = new RemoteBootstrapService({
    shellService: shellService as never,
    connectionService: connection,
    relay: {
      relayId: "check-relay",
      label: "Check Relay",
      httpBaseUrl: "https://relay.example.com",
      wsBaseUrl: "wss://relay.example.com"
    },
    host: {
      hostId: "check-host",
      label: "Check Host",
      appVersion: "0.1.0",
      serverInstanceId: createHash("sha1").update("check-host").digest("hex")
    },
    now: stableNow
  });

  const issuedPairing = pairing.issue("desktop-full");
  const consumedPairing = pairing.consumeByCode({
    code: issuedPairing.code,
    clientSurface: "desktop-full"
  });
  if (!consumedPairing) {
    throw new Error("Pairing consume failed.");
  }

  const session = auth.issueFromPairing(consumedPairing);
  connection.update({
    state: "live",
    authenticated: true,
    authorizedClientId: session.clientId,
    resumeToken: session.resumeToken,
    routeId: "route-check"
  });

  const parsedBootstrap = parseWorkbenchBootstrap(
    bootstrap.buildBootstrap("desktop-full", true)
  );
  const parsedConnection = parseWorkbenchConnectionSnapshot(
    connection.getSnapshot()
  );
  const parsedSession = parseWorkbenchSessionTokenPayload(session);

  console.log(
    JSON.stringify(
      {
        ok: true,
        bootstrap: {
          hostId: parsedBootstrap.host.hostId,
          relayId: parsedBootstrap.relay.relayId,
          clientSurface: parsedBootstrap.clientSurface,
          engineIds: parsedBootstrap.capabilities.engineIds
        },
        connection: {
          state: parsedConnection.state,
          routeId: parsedConnection.routeId,
          authenticated: parsedConnection.authenticated
        },
        session: {
          clientId: parsedSession.clientId,
          pairingId: parsedSession.pairingId
        }
      },
      null,
      2
    )
  );
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
