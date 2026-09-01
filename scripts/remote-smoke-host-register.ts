import { HostRelayClient } from "../apps/desktop-server/src/host-relay-client.js";
import { HostRelayConnectionService } from "../apps/desktop-server/src/host-relay-connection-service.js";
import { RelayServer } from "../apps/relay-server/src/server.js";

const now = (() => {
  let tick = 0;
  return () => `2026-04-21T00:20:${String(++tick).padStart(2, "0")}Z`;
})();

const run = async (): Promise<void> => {
  const hostAuthToken = "host-register-smoke-auth";
  const hostId = "host-smoke-register";
  const relay = new RelayServer({
    hostTokens: {
      [hostId]: hostAuthToken
    },
    host: "127.0.0.1",
    port: 0,
    now
  });

  try {
    const listening = await relay.listen();
    const relayBaseUrl = `http://${listening.host}:${listening.port}`;
    const connection = new HostRelayConnectionService({
      hostId,
      relayId: "relay-smoke",
      now
    });
    const client = new HostRelayClient({
      relay: {
        relayId: "relay-smoke",
        label: "Relay Smoke",
        httpBaseUrl: relayBaseUrl,
        wsBaseUrl: relayBaseUrl.replace("http://", "ws://")
      },
      connectionService: connection,
      authToken: hostAuthToken,
      getHostDescriptor: () => ({
        hostId,
        label: "Host Smoke Register",
        deviceName: "smoke-box",
        platform: process.platform,
        appVersion: "0.1.0",
        serverInstanceId: "srv-register",
        online: true,
        lastSeenAt: now()
      })
    });

    const registration = await client.register();
    const hostsResponse = await fetch(`${relayBaseUrl}/api/hosts`);
    const hostsPayload = (await hostsResponse.json()) as {
      ok: boolean;
      hosts: Array<{ hostId: string; label: string }>;
    };

    console.log(
      JSON.stringify(
        {
          ok: true,
          relayBaseUrl,
          registration,
          connection: connection.getSnapshot(),
          hosts: hostsPayload.hosts
        },
        null,
        2
      )
    );
  } finally {
    await relay.close();
  }
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
