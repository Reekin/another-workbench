import { describe, expect, it, vi } from "vitest";
import { HostRelayClient } from "../src/host-relay-client.js";
import { RemoteAuthSessionService } from "../src/remote-auth-session-service.js";
import { RemoteBootstrapService } from "../src/remote-bootstrap-service.js";
import { RemoteConnectionService } from "../src/remote-connection-service.js";
import { RemotePairingService } from "../src/remote-pairing-service.js";

const now = (() => {
  let tick = 0;
  return () => `2026-04-21T00:00:${String(++tick).padStart(2, "0")}Z`;
})();

describe("remote control services", () => {
  it("issues and consumes pairing codes with expiration semantics", () => {
    const service = new RemotePairingService({
      hostId: "host-1",
      now,
      createPairingId: () => "pair-1",
      createCode: () => "ABC123"
    });

    const issued = service.issue("desktop-full");
    expect(issued.hostId).toBe("host-1");
    expect(issued.clientSurface).toBe("desktop-full");

    const consumed = service.consumeByCode({
      code: "ABC123",
      clientSurface: "desktop-full"
    });
    expect(consumed?.pairingId).toBe("pair-1");
    expect(service.consumeByCode({
      code: "ABC123",
      clientSurface: "desktop-full"
    })).toBeUndefined();
  });

  it("issues, validates and revokes session token bundles", () => {
    const pairingService = new RemotePairingService({
      hostId: "host-1",
      now,
      createPairingId: () => "pair-2",
      createCode: () => "XYZ999"
    });
    const pairing = pairingService.issue("mobile-companion");
    const auth = new RemoteAuthSessionService({
      hostId: "host-1",
      now,
      createToken: (() => {
        let index = 0;
        return () => `token-${++index}`;
      })(),
      createClientId: () => "client-1"
    });

    const session = auth.issueFromPairing(pairing);
    expect(auth.validateSessionToken(session.sessionToken)?.clientId).toBe(
      "client-1"
    );
    expect(
      auth.validateResumeToken(session.resumeToken, "mobile-companion")
        ?.sessionToken
    ).toBe(session.sessionToken);
    expect(
      auth.validateResourceToken(session.resourceToken, "desktop-full")
    ).toBeUndefined();

    auth.revokeSession(session.sessionToken);
    expect(auth.validateSessionToken(session.sessionToken)).toBeUndefined();
  });

  it("builds remote bootstrap snapshots from shell and connection state", () => {
    const connection = new RemoteConnectionService({
      hostId: "host-1",
      relayId: "relay-1",
      now
    });
    connection.update({
      state: "live",
      routeId: "route-1",
      authenticated: true,
      authorizedClientId: "client-1",
      resumeToken: "resume-1"
    });

    const bootstrap = new RemoteBootstrapService({
      shellService: {
        listEngines: () => [
          {
            engineId: "codex",
            displayName: "Codex",
            integrationTier: "native"
          },
          {
            engineId: "pi-acp",
            displayName: "Pi",
            integrationTier: "fallback"
          }
        ]
      } as never,
      connectionService: connection,
      relay: {
        relayId: "relay-1",
        label: "Relay",
        httpBaseUrl: "https://relay.example.com",
        wsBaseUrl: "wss://relay.example.com"
      },
      host: {
        hostId: "host-1",
        label: "Home Host",
        appVersion: "0.1.0",
        serverInstanceId: "srv-1",
        deviceName: "MyHost",
        platform: "win32"
      },
      now
    }).buildBootstrap("desktop-full", true);

    expect(bootstrap.clientSurface).toBe("desktop-full");
    expect(bootstrap.connection.state).toBe("live");
    expect(bootstrap.capabilities).toEqual({
      clientSurfaces: ["desktop-full", "mobile-companion"],
      engineIds: ["codex", "pi-acp"],
      supportsPairing: true,
      supportsResume: true,
      supportsResourceGateway: false
    });
    expect("features" in bootstrap.capabilities).toBe(false);
    expect("supportsDiagnostics" in bootstrap.capabilities).toBe(false);
    expect("supportsReviewContext" in bootstrap.capabilities).toBe(false);
  });

  it("registers host metadata through relay and updates connection state", async () => {
    const connection = new RemoteConnectionService({
      hostId: "host-1",
      relayId: "relay-1",
      now
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ routeId: "route-9" })
    })) as typeof fetch;

    const client = new HostRelayClient({
      relay: {
        relayId: "relay-1",
        label: "Relay",
        httpBaseUrl: "https://relay.example.com",
        wsBaseUrl: "wss://relay.example.com"
      },
      connectionService: connection,
      getHostDescriptor: () => ({
        hostId: "host-1",
        label: "Home Host",
        deviceName: "box",
        platform: "win32",
        appVersion: "0.1.0",
        serverInstanceId: "srv-1",
        online: true,
        lastSeenAt: now()
      }),
      fetchImpl
    });

    await expect(client.register()).resolves.toEqual({
      routeId: "route-9"
    });
    expect(connection.getSnapshot()).toMatchObject({
      state: "connecting",
      routeId: "route-9"
    });
  });
});
