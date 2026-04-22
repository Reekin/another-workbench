import { createConnection, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HostRelayClient } from "../../desktop-server/src/host-relay-client.js";
import { RemoteAuthSessionService } from "../../desktop-server/src/remote-auth-session-service.js";
import { RemoteBootstrapService } from "../../desktop-server/src/remote-bootstrap-service.js";
import { RemoteConnectionService } from "../../desktop-server/src/remote-connection-service.js";
import { RemotePairingService } from "../../desktop-server/src/remote-pairing-service.js";
import { WorkbenchRemoteServer } from "../../desktop-server/src/remote-server.js";
import { WorkbenchRuntimeService } from "../../desktop-server/src/runtime-service.js";
import { WorkbenchShellService } from "../../desktop-server/src/workbench-shell-service.js";
import { RelayHostRegistry, RelayServer } from "../src/index.js";

const relays: RelayServer[] = [];
const hosts: WorkbenchRemoteServer[] = [];
const hostClients: HostRelayClient[] = [];

const createClock = () => {
  let tick = 0;
  return () => `2026-04-21T08:00:${String(++tick).padStart(2, "0")}Z`;
};

const createRuntimeService = () =>
  new WorkbenchRuntimeService({
    now: (() => {
      let tick = 0;
      return () => `2026-04-21T09:00:${String(++tick).padStart(2, "0")}Z`;
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
    agents: [
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
  minFrames: number;
  onUpgraded?: () => void | Promise<void>;
}): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({
      host: "127.0.0.1",
      port: input.port
    });
    let buffer = Buffer.alloc(0);
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

const startRelayServer = async (): Promise<{
  server: RelayServer;
  baseUrl: string;
}> => {
  const now = createClock();
  const registry = new RelayHostRegistry({
    now,
    createHostId: (() => {
      let index = 0;
      return () => `host-${++index}`;
    })(),
    createConnectionId: (() => {
      let index = 0;
      return () => `connection-${++index}`;
    })()
  });
  const server = new RelayServer({
    host: "127.0.0.1",
    port: 0,
    registry,
    now,
    createAnonymousClientId: (() => {
      let index = 0;
      return () => `client-${++index}`;
    })(),
    createRelayRequestId: (() => {
      let index = 0;
      return () => `relay-request-${++index}`;
    })()
  });
  relays.push(server);

  await server.listen();
  const address = server.getHttpServer().address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
};

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

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map(async (server) => {
      await waitWithCeiling(() => server.close());
    })
  );
  await Promise.all(
    relays.splice(0).map(async (server) => {
      await waitWithCeiling(() => server.close());
    })
  );
  for (const client of hostClients.splice(0)) {
    client.close();
  }
});

describe("RelayServer", () => {
  it("serves health state", async () => {
    const { baseUrl } = await startRelayServer();

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "relay-server",
      protocolVersion: "relay.v1"
    });
  });

  it("bridges bootstrap, pairing, rpc, and events through a connected host tunnel", async () => {
    const runtime = createRuntimeService();
    const shell = createShellService(runtime);
    const connection = new RemoteConnectionService({
      hostId: "host-relay-1",
      relayId: "relay-1"
    });
    const pairing = new RemotePairingService({
      hostId: "host-relay-1",
      createPairingId: () => "pair-relay-1",
      createCode: () => "PAIRR1"
    });
    const authSessions = new RemoteAuthSessionService({
      hostId: "host-relay-1",
      createToken: (() => {
        let index = 0;
        return () => `relay-token-${++index}`;
      })(),
      createClientId: () => "client-relay-1"
    });

    const hostServer = new WorkbenchRemoteServer({
      service: shell,
      host: "127.0.0.1",
      port: 0,
      bootstrapService: new RemoteBootstrapService({
        shellService: shell,
        connectionService: connection,
        relay: {
          relayId: "relay-1",
          label: "Relay",
          httpBaseUrl: "https://relay.example.test",
          wsBaseUrl: "wss://relay.example.test"
        },
        host: {
          hostId: "host-relay-1",
          label: "Relay Host",
          appVersion: "0.1.0",
          serverInstanceId: "srv-relay-1"
        }
      }),
      pairingService: pairing,
      authSessions
    });
    hosts.push(hostServer);
    await hostServer.listen();
    const hostAddress = hostServer.getHttpServer().address() as AddressInfo;

    const { baseUrl: relayBaseUrl } = await startRelayServer();
    const relayClient = new HostRelayClient({
      relay: {
        relayId: "relay-1",
        label: "Relay",
        httpBaseUrl: relayBaseUrl,
        wsBaseUrl: relayBaseUrl.replace("http://", "ws://")
      },
      connectionService: connection,
      getHostDescriptor: () => ({
        hostId: "host-relay-1",
        label: "Relay Host",
        deviceName: "relay-box",
        platform: process.platform,
        appVersion: "0.1.0",
        serverInstanceId: "srv-relay-1",
        online: true,
        lastSeenAt: "2026-04-21T09:00:00.000Z"
      }),
      localHttpBaseUrl: `http://127.0.0.1:${hostAddress.port}`,
      localEventsUrl: `ws://127.0.0.1:${hostAddress.port}/events`
    });
    hostClients.push(relayClient);

    await expect(relayClient.connect()).resolves.toMatchObject({
      routeId: "connection-1"
    });

    const bootstrapResponse = await fetch(
      `${relayBaseUrl}/bootstrap?hostId=host-relay-1&clientSurface=desktop-full`
    );
    expect(bootstrapResponse.status).toBe(200);
    const bootstrapPayload = (await bootstrapResponse.json()) as {
      host: {
        hostId: string;
        label: string;
      };
      relay: {
        relayId: string;
      };
      clientSurface: string;
      capabilities: Record<string, unknown>;
    };
    expect(bootstrapPayload).toMatchObject({
      host: {
        hostId: "host-relay-1",
        label: "Relay Host"
      },
      relay: {
        relayId: "relay-1"
      },
      clientSurface: "desktop-full"
    });
    expect(bootstrapPayload.capabilities).toMatchObject({
      clientSurfaces: ["desktop-full", "mobile-companion"],
      supportsPairing: true,
      supportsResume: true,
      supportsResourceGateway: false
    });
    expect(bootstrapPayload.capabilities).not.toHaveProperty("features");
    expect(bootstrapPayload.capabilities).not.toHaveProperty(
      "supportsDiagnostics"
    );
    expect(bootstrapPayload.capabilities).not.toHaveProperty(
      "supportsReviewContext"
    );

    const pairingCodeResponse = await fetch(`${relayBaseUrl}/pairing/code?hostId=host-relay-1`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        clientSurface: "desktop-full"
      })
    });
    expect(pairingCodeResponse.status).toBe(200);
    const pairingCodePayload = (await pairingCodeResponse.json()) as {
      pairing: { code: string };
    };
    expect(pairingCodePayload.pairing.code).toBe("PAIRR1");

    const exchangeResponse = await fetch(
      `${relayBaseUrl}/pairing/exchange?hostId=host-relay-1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          code: pairingCodePayload.pairing.code,
          clientSurface: "desktop-full"
        })
      }
    );
    expect(exchangeResponse.status).toBe(200);
    const exchangePayload = (await exchangeResponse.json()) as {
      session: {
        sessionToken: string;
      };
    };
    const sessionToken = exchangePayload.session.sessionToken;

    const createSessionResponse = await fetch(`${relayBaseUrl}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
        "x-workbench-host-id": "host-relay-1"
      },
      body: JSON.stringify({
        id: "relay-create-session",
        method: "runtime.command",
        params: {
          envelope: {
            commandId: "cmd-create",
            command: {
              type: "createSession",
              engineId: "codex",
              conversationId: "conversation-relay-1"
            }
          }
        }
      })
    });
    expect(createSessionResponse.status).toBe(200);
    await expect(createSessionResponse.json()).resolves.toMatchObject({
      id: "relay-create-session",
      method: "runtime.command",
      ok: true,
      result: {
        accepted: true,
        commandType: "createSession"
      }
    });

    const subscribeResponse = await fetch(`${relayBaseUrl}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
        "x-workbench-host-id": "host-relay-1"
      },
      body: JSON.stringify({
        id: "relay-subscribe",
        method: "events.subscribe",
        params: {
          subscriptionId: "sub-relay-1",
          fromCursor: "1",
          filter: {
            conversationId: "conversation-relay-1"
          }
        }
      })
    });
    expect(subscribeResponse.status).toBe(200);
    await expect(subscribeResponse.json()).resolves.toMatchObject({
      id: "relay-subscribe",
      method: "events.subscribe",
      ok: true,
      result: {
        subscriptionId: "sub-relay-1"
      }
    });

    const relayAddress = relays[0]!.getHttpServer().address() as AddressInfo;
    const pushes = await openEventSocket({
      port: relayAddress.port,
      path: `/events?hostId=host-relay-1&subscriptionId=sub-relay-1&sessionToken=${encodeURIComponent(sessionToken)}&fromCursor=1&conversationId=conversation-relay-1`,
      minFrames: 2,
      onUpgraded: async () => {
        await fetch(`${relayBaseUrl}/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${sessionToken}`,
            "content-type": "application/json",
            "x-workbench-host-id": "host-relay-1"
          },
          body: JSON.stringify({
            id: "relay-create-session-2",
            method: "runtime.command",
            params: {
              envelope: {
                commandId: "cmd-create-2",
                command: {
                  type: "createSession",
                  engineId: "codex",
                  conversationId: "conversation-relay-1"
                }
              }
            }
          })
        });
      }
    });

    expect(pushes).toHaveLength(2);
    expect(
      pushes.every(
        (push) =>
          (push as { channel: string; subscriptionId: string }).channel ===
            "workbench.events"
          && (push as { subscriptionId: string }).subscriptionId === "sub-relay-1"
      )
    ).toBe(true);
    expect(
      pushes.map(
        (push) =>
          (push as { envelope: { event: { type: string } } }).envelope.event.type
      )
    ).toEqual(["session.created", "conversation.updated"]);

    const hostsResponse = await fetch(`${relayBaseUrl}/api/hosts`);
    expect(hostsResponse.status).toBe(200);
    await expect(hostsResponse.json()).resolves.toMatchObject({
      ok: true,
      hosts: [
        {
          hostId: "host-relay-1",
          label: "Relay Host",
          status: "connected"
        }
      ]
    });
  });
});
