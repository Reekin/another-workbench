import { createConnection, type Socket } from "node:net";
import { WorkbenchShellService } from "../apps/desktop-server/src/workbench-shell-service.js";
import { HostRelayConnectionService } from "../apps/desktop-server/src/host-relay-connection-service.js";
import { MobileAuthSessionService } from "../apps/desktop-server/src/mobile-auth-session-service.js";
import { MobilePairingService } from "../apps/desktop-server/src/mobile-pairing-service.js";
import { MobileRemoteBootstrapService } from "../apps/desktop-server/src/mobile-remote-bootstrap-service.js";
import { WorkbenchRemoteServer } from "../apps/desktop-server/src/remote-server.js";
import { WorkbenchRuntimeService } from "../apps/desktop-server/src/runtime-service.js";

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

const createService = () =>
  new WorkbenchRuntimeService({
    now: (() => {
      let tick = 0;
      return () => `2026-04-21T00:10:${String(++tick).padStart(2, "0")}Z`;
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

const openEventSocket = async (input: {
  port: number;
  sessionToken: string;
  onUpgraded?: () => void | Promise<void>;
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
      fail(new Error("Timed out waiting for websocket event frames."));
    }, 3000);

    socket.on("connect", () => {
      socket.write(
        [
          `GET /events HTTP/1.1`,
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Authorization: Bearer ${input.sessionToken}`,
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

      if (frames.length >= 1) {
        cleanup();
        resolve(frames);
      }
    });

    socket.on("error", fail);
  });

const run = async (): Promise<void> => {
  const runtime = createService();
  const shell = new WorkbenchShellService({
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
  const connection = new HostRelayConnectionService({
    hostId: "smoke-host",
    relayId: "smoke-relay"
  });
  const pairing = new MobilePairingService({
    hostId: "smoke-host",
    createPairingId: () => "pair-smoke",
    createCode: () => "SMOKE1"
  });
  const authSessions = new MobileAuthSessionService({
    hostId: "smoke-host",
    createToken: (() => {
      let index = 0;
      return () => `smoke-token-${++index}`;
    })(),
    createClientId: () => "client-smoke"
  });
  const bootstrap = new MobileRemoteBootstrapService({
    shellService: shell,
    connectionService: connection,
    relay: {
      relayId: "smoke-relay",
      label: "Smoke Relay",
      httpBaseUrl: "https://relay.example.com",
      wsBaseUrl: "wss://relay.example.com"
    },
    host: {
      hostId: "smoke-host",
      label: "Smoke Host",
      appVersion: "0.1.0",
      serverInstanceId: "srv-smoke"
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

  try {
    await server.listen();
    const address = server.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Missing server address.");
    }
    const port = address.port;

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    if (!health.ok) {
      throw new Error(`Health failed with status ${health.status}.`);
    }

    const initialBootstrap = await fetch(
      `http://127.0.0.1:${port}/bootstrap`
    ).then((response) => response.json());

    const issuedPairing = pairing.issue();
    const exchangeResponse = await fetch(
      `http://127.0.0.1:${port}/pairing/exchange`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          code: issuedPairing.code
        })
      }
    ).then((response) => response.json());

    const sessionToken = exchangeResponse.session.sessionToken as string;

    const eventPromise = openEventSocket({
      port,
      sessionToken,
      onUpgraded: async () => {
        await runtime.executeCommand({
          commandId: "smoke-create",
          command: {
            type: "createSession",
            engineId: "codex"
          }
        });
      }
    });

    const rpcResponse = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: "req-session-list",
        method: "session.list",
        params: {}
      })
    }).then((response) => response.json());

    const frames = await eventPromise;

    console.log(
      JSON.stringify(
        {
          ok: true,
          transport: "http+websocket",
          bootstrap: {
            hostId: initialBootstrap.host.hostId,
            relayId: initialBootstrap.relay.relayId
          },
          rpc: {
            method: rpcResponse.method,
            ok: rpcResponse.ok
          },
          streamedFrames: frames.length
        },
        null,
        2
      )
    );
  } finally {
    await server.close();
    await runtime.dispose();
  }
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
