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
  type RemoteClientSurface,
  type WorkbenchEventSubscriptionFilter,
  type EventType
} from "@another-workbench/shared";
import { getRemoteAuthErrorBody, type RemoteAuthConfig, isRemoteRequestAuthorized } from "./remote-auth.js";
import type { RemoteAuthSessionService } from "./remote-auth-session-service.js";
import type { RemoteBootstrapService } from "./remote-bootstrap-service.js";
import type { RemotePairingService } from "./remote-pairing-service.js";
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
  bootstrapService?: RemoteBootstrapService;
  pairingService?: RemotePairingService;
  authSessions?: RemoteAuthSessionService;
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

const readJsonBody = async (request: IncomingMessage): Promise<unknown> =>
  JSON.parse(await readBody(request));

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

const normalizeHeaderValue = (
  value: string | string[] | undefined
): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

const stripBearerPrefix = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
};

const parseClientSurface = (value: string | null | undefined): RemoteClientSurface =>
  value === "mobile-companion" ? "mobile-companion" : "desktop-full";

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
  private readonly bootstrapService: RemoteBootstrapService | undefined;
  private readonly pairingService: RemotePairingService | undefined;
  private readonly authSessions: RemoteAuthSessionService | undefined;
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
    this.bootstrapService = options.bootstrapService;
    this.pairingService = options.pairingService;
    this.authSessions = options.authSessions;
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
    (
      this.server as HttpServer & {
        closeAllConnections?: () => void;
      }
    ).closeAllConnections?.();

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

    if (request.method === "GET" && url.pathname === "/bootstrap") {
      if (!this.bootstrapService) {
        sendJson(response, 404, {
          ok: false,
          error: {
            code: "REMOTE_BOOTSTRAP_UNAVAILABLE",
            message: "Remote bootstrap service is unavailable."
          }
        });
        return;
      }

      const surface = parseClientSurface(url.searchParams.get("clientSurface"));
      const session = this.resolveAuthorizedSession(request);
      sendJson(
        response,
        200,
        this.bootstrapService.buildBootstrap(surface, Boolean(session))
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/pairing/code") {
      if (!this.pairingService) {
        sendJson(response, 404, {
          ok: false,
          error: {
            code: "REMOTE_PAIRING_UNAVAILABLE",
            message: "Remote pairing service is unavailable."
          }
        });
        return;
      }

      try {
        const body = (await readJsonBody(request)) as {
          clientSurface?: RemoteClientSurface;
        };
        const pairing = this.pairingService.issue(
          body.clientSurface ?? "desktop-full"
        );
        sendJson(response, 200, {
          ok: true,
          pairing
        });
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: {
            code: "REMOTE_BAD_REQUEST",
            message:
              error instanceof Error ? error.message : "Invalid pairing request"
          }
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/pairing/exchange") {
      if (!this.pairingService || !this.authSessions) {
        sendJson(response, 404, {
          ok: false,
          error: {
            code: "REMOTE_PAIRING_UNAVAILABLE",
            message: "Pairing exchange is unavailable."
          }
        });
        return;
      }

      try {
        const body = (await readJsonBody(request)) as {
          code?: string;
          clientSurface?: RemoteClientSurface;
        };
        const pairing = body.code
          ? this.pairingService.consumeByCode({
              code: body.code,
              clientSurface: body.clientSurface ?? "desktop-full"
            })
          : undefined;
        if (!pairing) {
          sendJson(response, 401, {
            ok: false,
            error: {
              code: "REMOTE_PAIRING_FAILED",
              message: "Pairing code is missing, expired, or invalid."
            }
          });
          return;
        }

        sendJson(response, 200, {
          ok: true,
          session: this.authSessions.issueFromPairing(pairing)
        });
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: {
            code: "REMOTE_BAD_REQUEST",
            message:
              error instanceof Error ? error.message : "Invalid pairing exchange request"
          }
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/revoke") {
      if (!this.authSessions) {
        sendJson(response, 404, {
          ok: false,
          error: {
            code: "REMOTE_AUTH_UNAVAILABLE",
            message: "Remote auth session service is unavailable."
          }
        });
        return;
      }

      try {
        const body = (await readJsonBody(request)) as { sessionToken?: string };
        if (!body.sessionToken) {
          sendJson(response, 400, {
            ok: false,
            error: {
              code: "REMOTE_BAD_REQUEST",
              message: "sessionToken is required."
            }
          });
          return;
        }
        const revoked = this.authSessions.revokeSession(body.sessionToken);
        if (!revoked) {
          sendJson(response, 404, {
            ok: false,
            error: {
              code: "REMOTE_SESSION_NOT_FOUND",
              message: "Remote session token was not found."
            }
          });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          revoked
        });
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: {
            code: "REMOTE_BAD_REQUEST",
            message:
              error instanceof Error ? error.message : "Invalid revoke request"
          }
        });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === this.rpcPath) {
      if (!this.isRequestAuthorized(request)) {
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

    if (!this.isRequestAuthorized(request)) {
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

  private resolveAuthorizedSession(request: IncomingMessage) {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`
    );
    const bearerToken = stripBearerPrefix(
      normalizeHeaderValue(request.headers.authorization)
        ?? normalizeHeaderValue(url.searchParams.get("sessionToken") ?? undefined)
    );
    const sessionFromBearer = bearerToken
      ? this.authSessions?.validateSessionToken(bearerToken)
      : undefined;
    if (sessionFromBearer) {
      return sessionFromBearer;
    }

    const resumeToken = normalizeHeaderValue(
      request.headers["x-workbench-resume-token"]
    ) ?? normalizeHeaderValue(url.searchParams.get("resumeToken") ?? undefined);
    return resumeToken
      ? this.authSessions?.validateResumeToken(resumeToken)
      : undefined;
  }

  private isRequestAuthorized(request: IncomingMessage): boolean {
    if (isRemoteRequestAuthorized(request, this.auth)) {
      return true;
    }
    return Boolean(this.resolveAuthorizedSession(request));
  }
}
