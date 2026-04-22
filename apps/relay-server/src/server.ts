import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";
import {
  parseWorkbenchRpcRequest,
  safeParseRelayHostBridgeMessage,
  type RelayHostBridgeMessage,
  type WorkbenchRpcRequest,
  type WorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  RELAY_PROTOCOL_VERSION,
  type RelayClientBootstrap,
  type RelayHostConnectInput,
  type RelayHostRegistrationInput,
  type RelayRpcResponse
} from "./contracts.js";
import {
  InMemoryRelayHostRegistryStore,
  RelayHostRegistry,
  type RelayHostRegistryOptions
} from "./host-registry.js";
import {
  createWebSocketAcceptKey,
  decodeWebSocketFrames,
  sendWebSocketTextFrame
} from "./ws-frames.js";

type Clock = () => string;
type IdFactory = () => string;

type RelayHostChannel = {
  buffer: Buffer;
  hostId?: string;
  routeId?: string;
  socket: Socket;
};

type PendingHostRequest = {
  hostId: string;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeoutId: NodeJS.Timeout;
};

type RelayClientEventStream = {
  hostId: string;
  socket: Socket;
};

export type RelayServerOptions = {
  host?: string;
  port?: number;
  registry?: RelayHostRegistry;
  registryOptions?: RelayHostRegistryOptions;
  now?: Clock;
  createAnonymousClientId?: IdFactory;
  createRelayRequestId?: IdFactory;
  requestTimeoutMs?: number;
};

class RelayHttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "RelayHttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const createOpaqueId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown
): void => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
};

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

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const body = await readBody(request);
  if (!body.trim()) {
    return {};
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new RelayHttpError(
      400,
      "RELAY_BAD_JSON",
      error instanceof Error ? error.message : "Request body must be valid JSON"
    );
  }
};

const readOptionalString = (
  source: Record<string, unknown>,
  key: string
): string | undefined => {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new RelayHttpError(400, "RELAY_BAD_REQUEST", `"${key}" must be a non-empty string`);
  }
  return value.trim();
};

const readOptionalStringArray = (
  source: Record<string, unknown>,
  key: string
): string[] | undefined => {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RelayHttpError(400, "RELAY_BAD_REQUEST", `"${key}" must be a string array`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
};

const readOptionalMetadata = (
  source: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined => {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new RelayHttpError(400, "RELAY_BAD_REQUEST", `"${key}" must be an object`);
  }
  return { ...value };
};

const parseHostRegistrationInput = (
  payload: unknown
): RelayHostRegistrationInput => {
  if (!isRecord(payload)) {
    throw new RelayHttpError(400, "RELAY_BAD_REQUEST", "Host registration payload must be an object");
  }

  const hostInput = isRecord(payload.host) ? payload.host : payload;

  return {
    hostId: readOptionalString(hostInput, "hostId"),
    label: readOptionalString(hostInput, "label"),
    capabilities: readOptionalStringArray(hostInput, "capabilities"),
    metadata: readOptionalMetadata(hostInput, "metadata")
      ?? (isRecord(payload.host)
        ? {
            deviceName: payload.host.deviceName,
            platform: payload.host.platform,
            appVersion: payload.host.appVersion,
            serverInstanceId: payload.host.serverInstanceId
          }
        : undefined)
  };
};

const parseHostConnectInput = (payload: unknown): RelayHostConnectInput => {
  if (!isRecord(payload)) {
    throw new RelayHttpError(400, "RELAY_BAD_REQUEST", "Host connect payload must be an object");
  }

  return {
    clientId: readOptionalString(payload, "clientId"),
    sessionId: readOptionalString(payload, "sessionId")
  };
};

const parseBootstrapInput = (payload: unknown): { clientId?: string } => {
  if (!isRecord(payload)) {
    throw new RelayHttpError(400, "RELAY_BAD_REQUEST", "Bootstrap payload must be an object");
  }
  return {
    clientId: readOptionalString(payload, "clientId")
  };
};

const normalizeHeaderValue = (
  value: string | string[] | undefined
): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
};

const extractHeaders = (
  request: IncomingMessage
): Record<string, string> | undefined => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const normalized = normalizeHeaderValue(value);
    if (typeof normalized === "string" && normalized.length > 0) {
      headers[key] = normalized;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

const sanitizeForwardHeaders = (
  headers: Record<string, string> | undefined
): Record<string, string> | undefined => {
  if (!headers) {
    return undefined;
  }

  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "host"
      || normalized === "connection"
      || normalized === "upgrade"
      || normalized === "content-length"
      || normalized === "sec-websocket-key"
      || normalized === "sec-websocket-version"
      || normalized === "sec-websocket-protocol"
      || normalized === "x-workbench-host-id"
    ) {
      continue;
    }
    forwarded[key] = value;
  }

  return Object.keys(forwarded).length > 0 ? forwarded : undefined;
};

const getTargetHostId = (
  request: IncomingMessage,
  url: URL,
  registry: RelayHostRegistry
): string | undefined => {
  const headerHostId = normalizeHeaderValue(request.headers["x-workbench-host-id"]);
  if (headerHostId) {
    return headerHostId;
  }
  const queryHostId = url.searchParams.get("hostId");
  if (queryHostId) {
    return queryHostId;
  }
  const connectedHosts = registry
    .listHosts()
    .filter((host) => host.status === "connected");
  return connectedHosts.length === 1 ? connectedHosts[0]?.hostId : undefined;
};

export class RelayServer {
  private readonly host: string;
  private readonly port: number;
  private readonly registry: RelayHostRegistry;
  private readonly now: Clock;
  private readonly createAnonymousClientId: IdFactory;
  private readonly createRelayRequestId: IdFactory;
  private readonly requestTimeoutMs: number;
  private readonly server: HttpServer;
  private readonly sockets = new Set<Socket>();
  private readonly hostChannels = new Map<string, RelayHostChannel>();
  private readonly pendingRequests = new Map<string, PendingHostRequest>();
  private readonly clientEventStreams = new Map<string, RelayClientEventStream>();

  public constructor(options: RelayServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 4417;
    this.registry =
      options.registry ??
      new RelayHostRegistry({
        store: new InMemoryRelayHostRegistryStore(),
        ...options.registryOptions
      });
    this.now = options.now ?? (() => new Date().toISOString());
    this.createAnonymousClientId =
      options.createAnonymousClientId ?? (() => createOpaqueId("client"));
    this.createRelayRequestId =
      options.createRelayRequestId ?? (() => createOpaqueId("relay-request"));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket as Socket, Buffer.from(head));
    });
  }

  public async listen(): Promise<{ host: string; port: number }> {
    await this.registry.ready();
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        const address = this.server.address();
        this.server.off("error", reject);
        if (!address || typeof address === "string") {
          resolve({ host: this.host, port: this.port });
          return;
        }
        resolve({
          host: address.address,
          port: address.port
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
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Relay server closed."));
    }
    this.pendingRequests.clear();

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

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`
    );

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          service: "relay-server",
          protocolVersion: RELAY_PROTOCOL_VERSION,
          serverTime: this.now()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hosts") {
        sendJson(response, 200, {
          ok: true,
          hosts: this.registry.listHostSummaries()
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/hosts/register") {
        const input = parseHostRegistrationInput(await readJson(request));
        const host = await this.registry.registerHost(input);
        sendJson(response, 201, {
          ok: true,
          host
        });
        return;
      }

      const connectMatch = request.method === "POST"
        ? url.pathname.match(/^\/api\/hosts\/([^/]+)\/connect$/)
        : null;
      if (connectMatch) {
        const hostId = decodeURIComponent(connectMatch[1] ?? "");
        const input = parseHostConnectInput(await readJson(request));
        const host = await this.registry.connectHost(hostId, input);
        if (!host) {
          throw new RelayHttpError(404, "RELAY_HOST_NOT_FOUND", `Host "${hostId}" was not found`);
        }
        sendJson(response, 200, {
          ok: true,
          host
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/client/bootstrap") {
        const input = parseBootstrapInput(await readJson(request));
        const bootstrap = this.createBootstrapResponse(url, input.clientId);
        sendJson(response, 200, {
          ok: true,
          bootstrap
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/bootstrap") {
        const hostId = getTargetHostId(request, url, this.registry);
        if (!hostId) {
          throw new RelayHttpError(
            400,
            "RELAY_HOST_REQUIRED",
            "hostId is required when multiple hosts are available."
          );
        }
        const proxied = await this.forwardControlRequest(hostId, {
          method: "GET",
          path: "/bootstrap",
          query: Object.fromEntries(
            [...url.searchParams.entries()].filter(([key]) => key !== "hostId")
          ),
          headers: sanitizeForwardHeaders(extractHeaders(request))
        });
        sendJson(response, proxied.statusCode, proxied.body);
        return;
      }

      if (request.method === "POST" && url.pathname === "/pairing/code") {
        const hostId = getTargetHostId(request, url, this.registry);
        if (!hostId) {
          throw new RelayHttpError(
            400,
            "RELAY_HOST_REQUIRED",
            "hostId is required when multiple hosts are available."
          );
        }
        const proxied = await this.forwardControlRequest(hostId, {
          method: "POST",
          path: "/pairing/code",
          headers: sanitizeForwardHeaders(extractHeaders(request)),
          body: await readJson(request)
        });
        sendJson(response, proxied.statusCode, proxied.body);
        return;
      }

      if (request.method === "POST" && url.pathname === "/pairing/exchange") {
        const hostId = getTargetHostId(request, url, this.registry);
        if (!hostId) {
          throw new RelayHttpError(
            400,
            "RELAY_HOST_REQUIRED",
            "hostId is required when multiple hosts are available."
          );
        }
        const proxied = await this.forwardControlRequest(hostId, {
          method: "POST",
          path: "/pairing/exchange",
          headers: sanitizeForwardHeaders(extractHeaders(request)),
          body: await readJson(request)
        });
        sendJson(response, proxied.statusCode, proxied.body);
        return;
      }

      if (request.method === "POST" && url.pathname === "/auth/revoke") {
        const hostId = getTargetHostId(request, url, this.registry);
        if (!hostId) {
          throw new RelayHttpError(
            400,
            "RELAY_HOST_REQUIRED",
            "hostId is required when multiple hosts are available."
          );
        }
        const proxied = await this.forwardControlRequest(hostId, {
          method: "POST",
          path: "/auth/revoke",
          headers: sanitizeForwardHeaders(extractHeaders(request)),
          body: await readJson(request)
        });
        sendJson(response, proxied.statusCode, proxied.body);
        return;
      }

      if (request.method === "POST" && url.pathname === "/rpc") {
        const payload = await readJson(request);
        if (isRecord(payload) && payload.method === "relay.ping") {
          const rpcResponse: RelayRpcResponse = {
            id: typeof payload.id === "string" ? payload.id : undefined,
            ok: true,
            result: {
              protocolVersion: RELAY_PROTOCOL_VERSION,
              serverTime: this.now(),
              hostCount: this.registry.listHosts().length
            }
          };
          sendJson(response, 200, rpcResponse);
          return;
        }

        const hostId = getTargetHostId(request, url, this.registry);
        if (!hostId) {
          throw new RelayHttpError(
            400,
            "RELAY_HOST_REQUIRED",
            "hostId is required when multiple hosts are available."
          );
        }
        const rpcRequest = parseWorkbenchRpcRequest(payload);
        const rpcResponse = await this.forwardRpcRequest(
          hostId,
          rpcRequest,
          sanitizeForwardHeaders(extractHeaders(request))
        );
        sendJson(response, 200, rpcResponse);
        return;
      }

      sendJson(response, 404, {
        ok: false,
        error: {
          code: "RELAY_NOT_FOUND",
          message: "Relay endpoint not found"
        }
      });
    } catch (error) {
      if (error instanceof RelayHttpError) {
        sendJson(response, error.statusCode, {
          ok: false,
          error: {
            code: error.code,
            message: error.message
          }
        });
        return;
      }

      sendJson(response, 500, {
        ok: false,
        error: {
          code: "RELAY_INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Relay server failed"
        }
      });
    }
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer
  ): void {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`
    );
    if (url.pathname === "/relay/host") {
      this.handleHostUpgrade(request, socket, head);
      return;
    }
    if (url.pathname === "/events") {
      this.handleClientEventsUpgrade(request, socket, url);
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }

  private handleHostUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer
  ): void {
    const websocketKey = normalizeHeaderValue(request.headers["sec-websocket-key"]);
    if (!websocketKey) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${createWebSocketAcceptKey(websocketKey)}`,
        "",
        ""
      ].join("\r\n")
    );

    const channel: RelayHostChannel = {
      buffer: head,
      socket
    };
    this.sockets.add(socket);

    const cleanup = () => {
      this.sockets.delete(socket);
      if (channel.hostId && this.hostChannels.get(channel.hostId) === channel) {
        this.hostChannels.delete(channel.hostId);
        void this.registry.disconnectHost(channel.hostId);
        this.closeClientStreamsForHost(channel.hostId);
        for (const [requestId, pending] of this.pendingRequests) {
          if (pending.hostId !== channel.hostId) {
            continue;
          }
          clearTimeout(pending.timeoutId);
          pending.reject(new Error(`Host "${channel.hostId}" disconnected.`));
          this.pendingRequests.delete(requestId);
        }
      }
    };

    const consumeBuffer = (chunk: Buffer) => {
      channel.buffer = Buffer.concat([channel.buffer, chunk]);
      const decoded = decodeWebSocketFrames(channel.buffer);
      channel.buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 0x1) {
          continue;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(frame.payload.toString("utf8"));
        } catch {
          continue;
        }
        const parsed = safeParseRelayHostBridgeMessage(payload);
        if (!parsed.success) {
          continue;
        }
        void this.handleHostBridgeMessage(channel, parsed.data);
      }
    };

    if (head.length > 0) {
      consumeBuffer(Buffer.alloc(0));
    }

    socket.on("data", consumeBuffer);
    socket.on("close", cleanup);
    socket.on("end", cleanup);
    socket.on("error", cleanup);
  }

  private handleClientEventsUpgrade(
    request: IncomingMessage,
    socket: Socket,
    url: URL
  ): void {
    const hostId = getTargetHostId(request, url, this.registry);
    if (!hostId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const channel = this.hostChannels.get(hostId);
    if (!channel) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    const websocketKey = normalizeHeaderValue(request.headers["sec-websocket-key"]);
    if (!websocketKey) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${createWebSocketAcceptKey(websocketKey)}`,
        "",
        ""
      ].join("\r\n")
    );

    this.sockets.add(socket);

    const streamId =
      url.searchParams.get("subscriptionId") ?? this.createRelayRequestId();
    this.clientEventStreams.set(streamId, {
      hostId,
      socket
    });

    const query = Object.fromEntries(
      [...url.searchParams.entries()].filter(([key]) => key !== "hostId")
    );

    const cleanup = () => {
      if (!this.clientEventStreams.has(streamId)) {
        return;
      }
      this.clientEventStreams.delete(streamId);
      this.sockets.delete(socket);
      void this.sendHostMessage(hostId, {
        type: "event.stop",
        streamId
      }).catch(() => undefined);
    };

    socket.on("close", cleanup);
    socket.on("end", cleanup);
    socket.on("error", cleanup);
    socket.on("data", () => {
      // Browser/event client sockets are send-only in this transport.
    });

    void this.sendHostMessage(hostId, {
      type: "event.start",
      streamId,
      query
    }).catch(() => {
      cleanup();
      socket.destroy();
    });
  }

  private async handleHostBridgeMessage(
    channel: RelayHostChannel,
    message: RelayHostBridgeMessage
  ): Promise<void> {
    switch (message.type) {
      case "host.hello": {
        const existing = this.hostChannels.get(message.host.hostId);
        if (existing && existing !== channel) {
          existing.socket.destroy();
        }
        await this.registry.registerHost({
          hostId: message.host.hostId,
          label: message.host.label,
          metadata: {
            appVersion: message.host.appVersion,
            deviceName: message.host.deviceName,
            platform: message.host.platform,
            serverInstanceId: message.host.serverInstanceId
          }
        });
        const connected = await this.registry.connectHost(message.host.hostId);
        if (!connected?.activeConnection?.connectionId) {
          throw new Error(`Failed to connect host "${message.host.hostId}".`);
        }
        channel.hostId = message.host.hostId;
        channel.routeId = connected.activeConnection.connectionId;
        this.hostChannels.set(message.host.hostId, channel);
        sendWebSocketTextFrame(
          channel.socket,
          JSON.stringify({
            type: "host.ready",
            routeId: channel.routeId
          } satisfies RelayHostBridgeMessage)
        );
        return;
      }
      case "control.response":
      case "rpc.response": {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.requestId);
        pending.resolve(
          message.type === "control.response" ? message : message.response
        );
        return;
      }
      case "event.push": {
        const clientStream = this.clientEventStreams.get(message.streamId);
        if (!clientStream) {
          return;
        }
        sendWebSocketTextFrame(
          clientStream.socket,
          JSON.stringify(message.push)
        );
        return;
      }
      case "event.error": {
        const clientStream = this.clientEventStreams.get(message.streamId);
        if (!clientStream) {
          return;
        }
        clientStream.socket.destroy(
          new Error(`Host event stream failed: ${message.message}`)
        );
        return;
      }
      case "host.ping":
        sendWebSocketTextFrame(
          channel.socket,
          JSON.stringify({
            type: "host.pong",
            timestamp: message.timestamp
          } satisfies RelayHostBridgeMessage)
        );
        return;
      case "host.ready":
      case "host.pong":
      case "control.request":
      case "rpc.request":
      case "event.start":
      case "event.stop":
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  private createBootstrapResponse(
    requestUrl: URL,
    clientId: string | undefined
  ): RelayClientBootstrap {
    return {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      serverTime: this.now(),
      clientId: clientId ?? this.createAnonymousClientId(),
      healthUrl: new URL("/health", requestUrl).toString(),
      rpc: {
        endpoint: new URL("/rpc", requestUrl).toString(),
        transport: "http"
      },
      hosts: this.registry.listHostSummaries()
    };
  }

  private async forwardControlRequest(
    hostId: string,
    input: {
      method: "GET" | "POST";
      path: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<{ statusCode: number; body: unknown }> {
    const response = await this.sendHostMessage(hostId, {
      type: "control.request",
      requestId: this.createRelayRequestId(),
      method: input.method,
      path: input.path,
      query: input.query,
      headers: input.headers,
      body: input.body
    });

    if (
      !response
      || typeof response !== "object"
      || !("statusCode" in response)
    ) {
      throw new RelayHttpError(
        502,
        "RELAY_HOST_PROTOCOL_ERROR",
        `Host "${hostId}" returned an invalid control response.`
      );
    }

    return response as { statusCode: number; body: unknown };
  }

  private async forwardRpcRequest(
    hostId: string,
    rpc: WorkbenchRpcRequest,
    headers: Record<string, string> | undefined
  ): Promise<WorkbenchRpcResponse> {
    const response = await this.sendHostMessage(hostId, {
      type: "rpc.request",
      requestId: this.createRelayRequestId(),
      rpc,
      headers
    });
    return response as WorkbenchRpcResponse;
  }

  private async sendHostMessage(
    hostId: string,
    message: RelayHostBridgeMessage
  ): Promise<unknown> {
    const channel = this.hostChannels.get(hostId);
    if (!channel || !channel.routeId) {
      throw new RelayHttpError(
        503,
        "RELAY_HOST_OFFLINE",
        `Host "${hostId}" is registered but not connected`
      );
    }

    const requestId =
      "requestId" in message ? message.requestId : undefined;
    if (!requestId) {
      sendWebSocketTextFrame(channel.socket, JSON.stringify(message));
      return undefined;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new RelayHttpError(
            504,
            "RELAY_HOST_TIMEOUT",
            `Host "${hostId}" did not respond in time.`
          )
        );
      }, this.requestTimeoutMs);

      this.pendingRequests.set(requestId, {
        hostId,
        resolve,
        reject,
        timeoutId
      });

      try {
        sendWebSocketTextFrame(channel.socket, JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error(`Failed to deliver request to host "${hostId}".`)
        );
      }
    });
  }

  private closeClientStreamsForHost(hostId: string): void {
    for (const [streamId, stream] of this.clientEventStreams) {
      if (stream.hostId !== hostId) {
        continue;
      }
      this.clientEventStreams.delete(streamId);
      stream.socket.destroy();
    }
  }
}
