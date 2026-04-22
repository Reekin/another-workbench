import { createConnection, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteAuthSessionService } from "../src/remote-auth-session-service.js";
import { RemoteBootstrapService } from "../src/remote-bootstrap-service.js";
import { RemoteConnectionService } from "../src/remote-connection-service.js";
import { RemotePairingService } from "../src/remote-pairing-service.js";
import { WorkbenchRemoteServer } from "../src/remote-server.js";
import { WorkbenchRuntimeService } from "../src/runtime-service.js";
import { WorkbenchShellService } from "../src/workbench-shell-service.js";

const createService = () =>
  new WorkbenchRuntimeService({
    now: (() => {
      let tick = 0;
      return () => `2026-04-18T00:20:${String(++tick).padStart(2, "0")}Z`;
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
        agentId: "codex",
        displayName: "Codex",
        capabilities: ["chat"]
      }
    ]
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
      fail(new Error("Timed out waiting for websocket event frames."));
    }, 3000);

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

describe("WorkbenchRemoteServer", () => {
  const servers: WorkbenchRemoteServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        await server.close();
      })
    );
  });

  it("serves health and auth-protected rpc requests", async () => {
    const service = createService();
    const server = new WorkbenchRemoteServer({
      service,
      host: "127.0.0.1",
      port: 0,
      auth: {
        token: "secret-token"
      }
    });
    servers.push(server);

    const listenResult = await server.listen();
    const address = server.getHttpServer().address() as AddressInfo;

    expect(listenResult.port).toBe(address.port);

    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      ok: true,
      transport: "http+websocket"
    });

    const unauthorizedRpc = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: "req-create",
        method: "runtime.command",
        params: {
          envelope: {
            commandId: "cmd-create",
            command: {
              type: "createSession",
              engineId: "codex"
            }
          }
        }
      })
    });

    expect(unauthorizedRpc.status).toBe(401);
    await expect(unauthorizedRpc.json()).resolves.toMatchObject({
      error: {
        code: "REMOTE_UNAUTHORIZED"
      }
    });

    const authorizedRpc = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: "req-create",
        method: "runtime.command",
        params: {
          envelope: {
            commandId: "cmd-create",
            command: {
              type: "createSession",
              engineId: "codex"
            }
          }
        }
      })
    });

    expect(authorizedRpc.status).toBe(200);
    await expect(authorizedRpc.json()).resolves.toMatchObject({
      id: "req-create",
      method: "runtime.command",
      ok: true,
      result: {
        commandType: "createSession",
        accepted: true
      }
    });
  });

  it("replays and streams workbench event pushes over websocket", async () => {
    const service = createService();
    await service.executeCommand({
      commandId: "cmd-create",
      command: {
        type: "createSession",
        engineId: "codex",
        conversationId: "conversation-1"
      }
    });

    const server = new WorkbenchRemoteServer({
      service,
      host: "127.0.0.1",
      port: 0,
      auth: {
        token: "secret-token"
      }
    });
    servers.push(server);
    await server.listen();
    const address = server.getHttpServer().address() as AddressInfo;

    const pushes = await openEventSocket({
      port: address.port,
      path: "/events?token=secret-token&fromCursor=1&conversationId=conversation-1",
      minFrames: 4,
      onUpgraded: async () => {
        await service.executeCommand({
          commandId: "cmd-archive",
          command: {
            type: "archiveSession",
            sessionId: "session-1"
          }
        });
      }
    });

    expect(pushes).toHaveLength(4);
    expect(pushes.every((push) => (push as { channel: string }).channel === "workbench.events")).toBe(
      true
    );
    expect(
      pushes.map(
        (push) =>
          (push as { envelope: { event: { type: string } } }).envelope.event.type
      )
    ).toEqual([
      "session.created",
      "conversation.updated",
      "session.archived",
      "conversation.updated"
    ]);
  });

  it("serves bootstrap and pairing exchange endpoints when remote control services are configured", async () => {
    const service = createService();
    const shell = new WorkbenchShellService({
      runtimeService: service,
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
    const connection = new RemoteConnectionService({
      hostId: "host-1",
      relayId: "relay-1"
    });
    const pairing = new RemotePairingService({
      hostId: "host-1",
      createPairingId: () => "pair-1",
      createCode: () => "PAIR99"
    });
    const authSessions = new RemoteAuthSessionService({
      hostId: "host-1",
      createToken: (() => {
        let index = 0;
        return () => `token-${++index}`;
      })(),
      createClientId: () => "client-1"
    });
    const bootstrap = new RemoteBootstrapService({
      shellService: shell,
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
        serverInstanceId: "srv-1"
      }
    });
    const server = new WorkbenchRemoteServer({
      service: shell,
      host: "127.0.0.1",
      port: 0,
      bootstrapService: bootstrap,
      pairingService: pairing,
      authSessions
    });
    servers.push(server);

    await server.listen();
    const address = server.getHttpServer().address() as AddressInfo;

    const bootstrapResponse = await fetch(
      `http://127.0.0.1:${address.port}/bootstrap?clientSurface=desktop-full`
    );
    expect(bootstrapResponse.status).toBe(200);
    await expect(bootstrapResponse.json()).resolves.toMatchObject({
      host: {
        hostId: "host-1"
      },
      clientSurface: "desktop-full",
      version: {
        protocolVersion: "2026-04-remote-v1"
      }
    });

    const pairingResponse = await fetch(
      `http://127.0.0.1:${address.port}/pairing/code`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          clientSurface: "desktop-full"
        })
      }
    );
    expect(pairingResponse.status).toBe(200);
    await expect(pairingResponse.json()).resolves.toMatchObject({
      ok: true,
      pairing: {
        pairingId: "pair-1",
        code: "PAIR99"
      }
    });

    const exchangeResponse = await fetch(
      `http://127.0.0.1:${address.port}/pairing/exchange`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          code: "PAIR99",
          clientSurface: "desktop-full"
        })
      }
    );
    expect(exchangeResponse.status).toBe(200);
    const exchanged = await exchangeResponse.json();
    expect(exchanged).toMatchObject({
      ok: true,
      session: {
        clientId: "client-1"
      }
    });

    const authedRpc = await fetch(`http://127.0.0.1:${address.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${exchanged.session.sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: "req-session-list",
        method: "session.list",
        params: {}
      })
    });

    expect(authedRpc.status).toBe(200);
    await expect(authedRpc.json()).resolves.toMatchObject({
      ok: true,
      method: "session.list"
    });
  });
});
