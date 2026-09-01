import { describe, expect, it, vi } from "vitest";
import { HostRelayClient } from "../src/host-relay-client.js";
import { HostRelayConnectionService } from "../src/host-relay-connection-service.js";
import { MobileAuthSessionService } from "../src/mobile-auth-session-service.js";
import { MobilePairingService } from "../src/mobile-pairing-service.js";
import { MobileRemoteBootstrapService } from "../src/mobile-remote-bootstrap-service.js";

const now = (() => {
  let tick = 0;
  return () => `2026-04-21T00:00:${String(++tick).padStart(2, "0")}Z`;
})();

describe("mobile remote control services", () => {
  it("issues and consumes pairing codes with expiration semantics", () => {
    const service = new MobilePairingService({
      hostId: "host-1",
      now,
      createPairingId: () => "pair-1",
      createCode: () => "ABC123"
    });

    const issued = service.issue();
    expect(issued.hostId).toBe("host-1");

    const consumed = service.consumeByCode("ABC123");
    expect(consumed?.pairingId).toBe("pair-1");
    expect(service.consumeByCode("ABC123")).toBeUndefined();
  });

  it("issues, validates and revokes session token bundles", () => {
    const pairingService = new MobilePairingService({
      hostId: "host-1",
      now,
      createPairingId: () => "pair-2",
      createCode: () => "XYZ999"
    });
    const pairing = pairingService.issue();
    const auth = new MobileAuthSessionService({
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
    expect(auth.validateResumeToken(session.resumeToken)?.sessionToken).toBe(
      session.sessionToken
    );

    auth.revokeSession(session.sessionToken);
    expect(auth.validateSessionToken(session.sessionToken)).toBeUndefined();
    expect(() =>
      new MobileAuthSessionService({ hostId: "host-2" }).issueFromPairing(pairing)
    ).toThrowError(/different host/i);
  });

  it("builds mobile bootstrap snapshots from shell and host relay state", () => {
    const connection = new HostRelayConnectionService({
      hostId: "host-1",
      relayId: "relay-1",
      now
    });
    connection.update({
      state: "connected",
      routeId: "route-1"
    });

    const bootstrap = new MobileRemoteBootstrapService({
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
    }).buildBootstrap();

    expect(bootstrap.connection.state).toBe("connected");
    expect(bootstrap.capabilities).toEqual({
      engineIds: ["codex", "pi-acp"],
      supportsPairing: true,
      supportsResume: true,
      supportsResourceGateway: false
    });
    expect(bootstrap.version.protocolVersion).toBe("2026-09-mobile-v1");
  });

  it("registers host metadata through relay and updates connection state", async () => {
    const connection = new HostRelayConnectionService({
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
      authToken: "host-auth-token",
      fetchImpl
    });

    await expect(client.register()).resolves.toEqual({
      routeId: "route-9"
    });
    expect(connection.getSnapshot()).toMatchObject({
      state: "connecting",
      routeId: "route-9"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://relay.example.com/api/hosts/register"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer host-auth-token"
        })
      })
    );
  });
});
