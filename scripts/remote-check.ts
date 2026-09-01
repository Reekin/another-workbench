import { createHash } from "node:crypto";
import {
  parseHostRelayConnectionSnapshot,
  parseMobileRemoteBootstrap,
  parseMobileSessionToken
} from "../packages/shared/src/remote-control.js";
import { HostRelayConnectionService } from "../apps/desktop-server/src/host-relay-connection-service.js";
import { MobileAuthSessionService } from "../apps/desktop-server/src/mobile-auth-session-service.js";
import { MobilePairingService } from "../apps/desktop-server/src/mobile-pairing-service.js";
import { MobileRemoteBootstrapService } from "../apps/desktop-server/src/mobile-remote-bootstrap-service.js";

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
  const connection = new HostRelayConnectionService({
    hostId: "check-host",
    relayId: "check-relay",
    now: stableNow
  });
  const pairing = new MobilePairingService({
    hostId: "check-host",
    now: stableNow,
    createPairingId: () => "pair-check",
    createCode: () => "PAIR42"
  });
  const auth = new MobileAuthSessionService({
    hostId: "check-host",
    now: stableNow,
    createToken: (() => {
      let index = 0;
      return () => `token-${++index}`;
    })(),
    createClientId: () => "client-check"
  });
  const bootstrap = new MobileRemoteBootstrapService({
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

  const issuedPairing = pairing.issue();
  const consumedPairing = pairing.consumeByCode(issuedPairing.code);
  if (!consumedPairing) {
    throw new Error("Pairing consume failed.");
  }

  const session = auth.issueFromPairing(consumedPairing);
  connection.update({
    state: "connected",
    routeId: "route-check"
  });

  const parsedBootstrap = parseMobileRemoteBootstrap(bootstrap.buildBootstrap());
  const parsedConnection = parseHostRelayConnectionSnapshot(
    connection.getSnapshot()
  );
  const parsedSession = parseMobileSessionToken(session);

  console.log(
    JSON.stringify(
      {
        ok: true,
        bootstrap: {
          hostId: parsedBootstrap.host.hostId,
          relayId: parsedBootstrap.relay.relayId,
          engineIds: parsedBootstrap.capabilities.engineIds
        },
        connection: {
          state: parsedConnection.state,
          routeId: parsedConnection.routeId
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
