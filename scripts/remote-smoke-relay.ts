import { createConnection, type AddressInfo } from "node:net";
import { HostRelayClient } from "../apps/desktop-server/src/host-relay-client.js";
import { HostRelayConnectionService } from "../apps/desktop-server/src/host-relay-connection-service.js";
import { MobileAuthSessionService } from "../apps/desktop-server/src/mobile-auth-session-service.js";
import { MobilePairingService } from "../apps/desktop-server/src/mobile-pairing-service.js";
import { MobileRemoteBootstrapService } from "../apps/desktop-server/src/mobile-remote-bootstrap-service.js";
import { WorkbenchRemoteServer } from "../apps/desktop-server/src/remote-server.js";
import { WorkbenchRuntimeService } from "../apps/desktop-server/src/runtime-service.js";
import { WorkbenchShellService } from "../apps/desktop-server/src/workbench-shell-service.js";
import { RelayHostRegistry, RelayServer } from "../apps/relay-server/src/index.js";

const createRuntimeService = () =>
  new WorkbenchRuntimeService({
    now: (() => {
      let tick = 0;
      return () => `2026-04-21T10:00:${String(++tick).padStart(2, "0")}Z`;
    })(),
    createConversationId: (() => {
      let index = 0;
      return () => `conversation-${++index}`;
    })(),
    createRelationId: (() => {
      let index = 0;
      return () => `relation-${++index}`;
    })(),
    createSessionId: (() => {
      let index = 0;
      return () => `session-${++index}`;
    })(),
    createEventId: (() => {
      let index = 0;
      return () => `event-${++index}`;
    })(),
    engines: [
      {
        engineId: "codex",
        displayName: "Codex",
        capabilities: ["chat"]
      }
    ]
  });

const createShellService = (runtime: WorkbenchRuntimeService) =>
  new WorkbenchShellService({
    runtimeService: runtime,
    sessionCatalog: {} as never,
    sessionActions: {} as never,
    chatTreeProvider: {} as never,
    engineRegistry: {
      list: () => [
        {
          engineId: "codex",
          displayName: "Codex",
          integrationTier: "native"
        }
      ]
    } as never
  });

const decodeTextFrames = (
  input: Buffer
): { frames: string[]; rest: Buffer } => {
  let offset = 0;
  const frames: string[] = [];

  while (offset + 2 <= input.length) {
    const secondByte = input[offset + 1]!;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > input.length) {
        break;
      }
      payloadLength = input.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > input.length) {
        break;
      }
      payloadLength = Number(input.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > input.length) {
      break;
    }

    const payloadStart = offset + headerLength + maskLength;
    const payload = input.subarray(payloadStart, payloadStart + payloadLength);
    frames.push(payload.toString("utf8"));
    offset += frameLength;
  }

  return {
    frames,
    rest: input.subarray(offset)
  };
};

const openEventSocket = async (input: {
  port: number;
  path: string;
  onUpgraded?: () => void | Promise<void>;
  minFrames: number;
}): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: input.port
    });
    let buffer: Buffer = Buffer.alloc(0);
    let upgraded = false;
    const frames: unknown[] = [];
    let timeoutId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    timeoutId = setTimeout(() => {
      fail(new Error("Timed out waiting for relay websocket event frames."));
    }, 5000);

    socket.on("connect", () => {
      socket.write(
        [
          `GET ${input.path} HTTP/1.1`,
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          ""
        ].join("\r\n")
      );
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const headers = buffer.subarray(0, headerEnd).toString("utf8");
        if (!headers.startsWith("HTTP/1.1 101")) {
          fail(new Error(`Unexpected websocket upgrade response: ${headers}`));
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
        void input.onUpgraded?.();
      }

      const decoded = decodeTextFrames(buffer);
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        frames.push(JSON.parse(frame));
      }

      if (frames.length >= input.minFrames) {
        cleanup();
        resolve(frames);
      }
    });

    socket.on("error", fail);
  });

const waitWithCeiling = async (
  action: () => Promise<void>,
  timeoutMs = 1_000
): Promise<void> => {
  await Promise.race([
    action().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    })
  ]);
};

const run = async (): Promise<void> => {
  const hostAuthToken = "relay-smoke-host-auth";
  const hostId = "relay-smoke-host";
  const runtime = createRuntimeService();
  const shell = createShellService(runtime);
  const connection = new HostRelayConnectionService({
    hostId,
    relayId: "relay-smoke"
  });
  const pairing = new MobilePairingService({
    hostId,
    createPairingId: () => "relay-pair-1",
    createCode: () => "RSMOKE1"
  });
  const authSessions = new MobileAuthSessionService({
    hostId,
    createToken: (() => {
      let index = 0;
      return () => `relay-smoke-token-${++index}`;
    })(),
    createClientId: () => "relay-smoke-client"
  });

  const hostServer = new WorkbenchRemoteServer({
    service: shell,
    host: "127.0.0.1",
    port: 0,
    bootstrapService: new MobileRemoteBootstrapService({
      shellService: shell,
      connectionService: connection,
      relay: {
        relayId: "relay-smoke",
        label: "Relay Smoke",
        httpBaseUrl: "https://relay.example.test",
        wsBaseUrl: "wss://relay.example.test"
      },
      host: {
        hostId: "relay-smoke-host",
        label: "Relay Smoke Host",
        appVersion: "0.1.0",
        serverInstanceId: "relay-smoke-srv"
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
    port: 0,
    registry: new RelayHostRegistry()
  });
  const getHostDescriptor = () => ({
    hostId: "relay-smoke-host",
    label: "Relay Smoke Host",
    deviceName: "relay-smoke-box",
    platform: process.platform,
    appVersion: "0.1.0",
    serverInstanceId: "relay-smoke-srv",
    online: true,
    lastSeenAt: "2026-04-21T10:00:00.000Z"
  });
  let connectedHostClient: HostRelayClient | undefined;

  try {
    await hostServer.listen();
    const hostAddress = hostServer.getHttpServer().address() as AddressInfo;

    const relayListening = await relay.listen();
    const relayBaseUrl = `http://${relayListening.host}:${relayListening.port}`;
    const relayWsBaseUrl = relayBaseUrl.replace("http://", "ws://");

    connectedHostClient = new HostRelayClient({
      relay: {
        relayId: "relay-smoke",
        label: "Relay Smoke",
        httpBaseUrl: relayBaseUrl,
        wsBaseUrl: relayWsBaseUrl
      },
      connectionService: connection,
      authToken: hostAuthToken,
      getHostDescriptor,
      localHttpBaseUrl: `http://127.0.0.1:${hostAddress.port}`,
      localEventsUrl: `ws://127.0.0.1:${hostAddress.port}/events`
    });

    const tunnel = await connectedHostClient.connect();

    const bootstrap = await fetch(
      `${relayBaseUrl}/bootstrap?hostId=relay-smoke-host`
    ).then((response) => response.json());

    const issuedPairing = pairing.issue();
    const exchangePayload = await fetch(
      `${relayBaseUrl}/pairing/exchange?hostId=relay-smoke-host`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          code: issuedPairing.code
        })
      }
    ).then((response) => response.json()) as {
      session: { sessionToken: string };
    };
    const sessionToken = exchangePayload.session.sessionToken;

    const createSession = await fetch(`${relayBaseUrl}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
        "x-workbench-host-id": "relay-smoke-host"
      },
      body: JSON.stringify({
        id: "relay-smoke-create",
        method: "runtime.command",
        params: {
          envelope: {
            commandId: "relay-smoke-command-1",
            command: {
              type: "createSession",
              engineId: "codex",
              conversationId: "relay-smoke-conversation"
            }
          }
        }
      })
    }).then((response) => response.json());

    const subscribe = await fetch(`${relayBaseUrl}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
        "x-workbench-host-id": "relay-smoke-host"
      },
      body: JSON.stringify({
        id: "relay-smoke-subscribe",
        method: "events.subscribe",
        params: {
          subscriptionId: "relay-smoke-sub-1",
          fromCursor: "1",
          filter: {
            conversationId: "relay-smoke-conversation"
          }
        }
      })
    }).then((response) => response.json());

    const relayAddress = relay.getHttpServer().address() as AddressInfo;
    const pushes = await openEventSocket({
      port: relayAddress.port,
      path: `/events?hostId=relay-smoke-host&subscriptionId=relay-smoke-sub-1&sessionToken=${encodeURIComponent(sessionToken)}&fromCursor=1&conversationId=relay-smoke-conversation`,
      minFrames: 2,
      onUpgraded: async () => {
        await fetch(`${relayBaseUrl}/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${sessionToken}`,
            "content-type": "application/json",
            "x-workbench-host-id": "relay-smoke-host"
          },
          body: JSON.stringify({
            id: "relay-smoke-create-2",
            method: "runtime.command",
            params: {
              envelope: {
                commandId: "relay-smoke-command-2",
                command: {
                  type: "createSession",
                  engineId: "codex",
                  conversationId: "relay-smoke-conversation"
                }
              }
            }
          })
        });
      }
    });

    const hosts = await fetch(`${relayBaseUrl}/api/hosts`).then((response) =>
      response.json()
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          relayBaseUrl,
          tunnel,
          bootstrap: {
            hostId: bootstrap.host.hostId,
            relayId: bootstrap.relay.relayId
          },
          pairingCode: issuedPairing.code,
          createSession,
          subscribe,
          pushes: pushes.map((push) => ({
            subscriptionId: (push as { subscriptionId: string }).subscriptionId,
            type: (push as { envelope: { event: { type: string } } }).envelope.event.type
          })),
          hosts
        },
        null,
        2
      )
    );

    connectedHostClient.close();
  } finally {
    connectedHostClient?.close();
    await waitWithCeiling(() => hostServer.close());
    await waitWithCeiling(() => relay.close());
  }
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
