import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import { URL } from "node:url";
import type { Socket } from "node:net";
import {
  eventTypes,
  type WorkbenchEventSubscriptionFilter,
  type EventType
} from "@another-workbench/shared";
import { getRemoteAuthErrorBody, type RemoteAuthConfig, isRemoteRequestAuthorized } from "./remote-auth.js";
import { createRemoteRpcHandler } from "./remote-protocol.js";
import type { WorkbenchShellService } from "./workbench-shell-service.js";

type IdFactory = () => string;

export type WorkbenchRemoteServerOptions = {
  service: WorkbenchShellService;
  host?: string;
  port?: number;
  rpcPath?: string;
  wsPath?: string;
  createSubscriptionId?: IdFactory;
  auth?: RemoteAuthConfig;
};

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const readBody = async (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown
): void => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

const sendTextFrame = (socket: Socket, payload: string): void => {
  const body = Buffer.from(payload, "utf8");
  if (body.length < 126) {
    const header = Buffer.from([0x81, body.length]);
    socket.write(Buffer.concat([header, body]));
    return;
  }
  if (body.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    socket.write(Buffer.concat([header, body]));
    return;
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  socket.write(Buffer.concat([header, body]));
};

const isEventType = (value: string): value is EventType =>
  (eventTypes as readonly string[]).includes(value);

const parseEventFilter = (url: URL): WorkbenchEventSubscriptionFilter => {
  const eventTypesParam = url.searchParams.get("eventTypes");
  return {
    sessionId: url.searchParams.get("sessionId") ?? undefined,
    conversationId: url.searchParams.get("conversationId") ?? undefined,
    eventTypes: eventTypesParam
      ? eventTypesParam
          .split(",")
          .map((value) => value.trim())
          .filter(isEventType)
      : undefined
  };
};

export class WorkbenchRemoteServer {
  private readonly service: WorkbenchShellService;
  private readonly rpcHandler: ReturnType<typeof createRemoteRpcHandler>;
  private readonly host: string;
  private readonly port: number;
  private readonly rpcPath: string;
  private readonly wsPath: string;
  private readonly createSubscriptionId: IdFactory;
  private readonly auth: RemoteAuthConfig | undefined;
  private readonly server: HttpServer;
  private readonly sockets = new Set<Socket>();

  public constructor(options: WorkbenchRemoteServerOptions) {
    this.service = options.service;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4317;
    this.rpcPath = options.rpcPath ?? "/rpc";
    this.wsPath = options.wsPath ?? "/events";
    this.createSubscriptionId =
      options.createSubscriptionId ??
      (() => `remote-sub-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`);
    this.auth = options.auth;
    this.rpcHandler = createRemoteRpcHandler(this.service, {
      createSubscriptionId: this.createSubscriptionId
    });
    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  public listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        const address = (
          this.server as HttpServer & {
            address?: () => { address: string; port: number } | string | null;
          }
        ).address?.();
        this.server.off("error", reject);
        resolve({
          host:
            typeof address === "object" && address
              ? address.address
              : this.host,
          port:
            typeof address === "object" && address
              ? address.port
              : this.port
        });
      });
    });
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  public getHttpServer(): HttpServer {
    return this.server;
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`
    );

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        transport: "http+websocket"
      });
      return;
    }

    if (request.method === "POST" && url.pathname === this.rpcPath) {
      if (!isRemoteRequestAuthorized(request, this.auth)) {
        sendJson(response, 401, getRemoteAuthErrorBody());
        return;
      }

      try {
        const body = await readBody(request);
        const rawRequest = JSON.parse(body);
        const rpcResponse = await this.rpcHandler.handleRequest(rawRequest);
        sendJson(response, 200, rpcResponse);
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: {
            code: "REMOTE_BAD_REQUEST",
            message:
              error instanceof Error ? error.message : "Invalid remote request"
          }
        });
      }
      return;
    }

    sendJson(response, 404, {
      ok: false,
      error: {
        code: "REMOTE_NOT_FOUND",
        message: "Remote endpoint not found"
      }
    });
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    _head: Uint8Array
  ): void {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`
    );
    if (url.pathname !== this.wsPath) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!isRemoteRequestAuthorized(request, this.auth)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n"
      );
      socket.destroy();
      return;
    }

    const websocketKey = request.headers["sec-websocket-key"];
    if (typeof websocketKey !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1")
      .update(websocketKey + websocketGuid)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "",
        ""
      ].join("\r\n")
    );

    this.sockets.add(socket);

    const subscriptionId =
      url.searchParams.get("subscriptionId") ?? this.createSubscriptionId();
    const fromCursor = url.searchParams.get("fromCursor") ?? undefined;
    const filter = parseEventFilter(url);

    const unsubscribe = this.service.subscribeFromCursor((envelope) => {
      sendTextFrame(
        socket,
        JSON.stringify(this.rpcHandler.createEventPush(subscriptionId, envelope))
      );
    }, {
      fromCursor,
      filter
    });

    const cleanup = () => {
      unsubscribe();
      this.sockets.delete(socket);
    };

    socket.on("close", cleanup);
    socket.on("end", cleanup);
    socket.on("error", cleanup);
    socket.on("data", () => {
      // Skeleton server is send-only for event streaming.
    });
  }
}
