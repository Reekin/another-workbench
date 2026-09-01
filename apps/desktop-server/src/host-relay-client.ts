import {
  parseWorkbenchRpcResponse,
  safeParseRelayHostBridgeMessage,
  safeParseWorkbenchRpcRequest,
  type RelayHostBridgeMessage,
  type WorkbenchHostDescriptor,
  type WorkbenchRelayDescriptor
} from "@another-workbench/shared";
import type { HostRelayConnectionService } from "./host-relay-connection-service.js";

type FetchLike = typeof fetch;
type IdFactory = () => string;

export type HostRelayClientWebSocketEventMap = {
  close: { code?: number; reason?: string };
  error: { error?: unknown; message?: string };
  message: { data: unknown };
  open: Event;
};

export type HostRelayClientWebSocketLike = {
  addEventListener<K extends keyof HostRelayClientWebSocketEventMap>(
    type: K,
    listener: (event: HostRelayClientWebSocketEventMap[K]) => void
  ): void;
  removeEventListener<K extends keyof HostRelayClientWebSocketEventMap>(
    type: K,
    listener: (event: HostRelayClientWebSocketEventMap[K]) => void
  ): void;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
};

export type HostRelayClientWebSocketConstructor = new (
  url: string,
  protocols?: string | string[]
) => HostRelayClientWebSocketLike;

export type HostRelayClientOptions = {
  relay: WorkbenchRelayDescriptor;
  connectionService: HostRelayConnectionService;
  getHostDescriptor: () => WorkbenchHostDescriptor;
  authToken: string;
  fetchImpl?: FetchLike;
  localHttpBaseUrl?: string;
  localEventsUrl?: string;
  websocketProtocols?: string | string[];
  WebSocket?: HostRelayClientWebSocketConstructor;
  createRequestId?: IdFactory;
};

export type HostRelayRegistration = {
  routeId: string;
};

export type HostRelayConnection = {
  routeId: string;
  close(): Promise<void>;
};

type PendingRelayRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
};

const createOpaqueId = (): string =>
  `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const parseRouteId = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const routeId = (value as { routeId?: unknown }).routeId;
  if (typeof routeId === "string" && routeId.length > 0) {
    return routeId;
  }
  const hostId = (value as { host?: { hostId?: unknown } }).host?.hostId;
  return typeof hostId === "string" && hostId.length > 0 ? hostId : undefined;
};

const normalizeBaseUrl = (value: string): string =>
  value.endsWith("/") ? value : `${value}/`;

const toWebSocketUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  return url.toString();
};

const parseJsonPayload = async (value: unknown): Promise<unknown> => {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  if (value instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(value)));
  }
  if (ArrayBuffer.isView(value)) {
    return JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      )
    );
  }
  if (
    typeof Blob !== "undefined"
    && value instanceof Blob
  ) {
    return JSON.parse(await value.text());
  }
  return value;
};

const readResponsePayload = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
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

const buildLocalEventsUrl = (
  localEventsUrl: string,
  query: Record<string, string> | undefined
): string => {
  const url = new URL(localEventsUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value.trim().length > 0) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
};

export class HostRelayClient {
  private readonly relay: WorkbenchRelayDescriptor;
  private readonly connectionService: HostRelayConnectionService;
  private readonly getHostDescriptor: () => WorkbenchHostDescriptor;
  private readonly fetchImpl: FetchLike;
  private readonly authToken: string;
  private readonly localHttpBaseUrl: string;
  private readonly localEventsUrl: string;
  private readonly websocketProtocols: string | string[] | undefined;
  private readonly WebSocketCtor: HostRelayClientWebSocketConstructor;
  private readonly createRequestId: IdFactory;

  private relaySocket: HostRelayClientWebSocketLike | undefined;
  private routeId: string | undefined;
  private readonly pendingRequests = new Map<string, PendingRelayRequest>();
  private readonly eventStreams = new Map<string, HostRelayClientWebSocketLike>();

  public constructor(options: HostRelayClientOptions) {
    this.relay = options.relay;
    this.connectionService = options.connectionService;
    this.getHostDescriptor = options.getHostDescriptor;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authToken = options.authToken.trim();
    if (!this.authToken) {
      throw new Error("Host relay auth token is required.");
    }
    this.localHttpBaseUrl = normalizeBaseUrl(
      options.localHttpBaseUrl ?? "http://127.0.0.1:4317"
    );
    this.localEventsUrl = options.localEventsUrl
      ?? toWebSocketUrl(new URL("events", this.localHttpBaseUrl).toString());
    this.websocketProtocols = options.websocketProtocols;
    this.createRequestId = options.createRequestId ?? createOpaqueId;

    const globalWebSocket = (globalThis as {
      WebSocket?: HostRelayClientWebSocketConstructor;
    }).WebSocket;
    if (options.WebSocket) {
      this.WebSocketCtor = options.WebSocket;
    } else if (globalWebSocket) {
      this.WebSocketCtor = globalWebSocket;
    } else {
      throw new Error("WebSocket is unavailable in this runtime.");
    }
  }

  public async register(): Promise<HostRelayRegistration> {
    this.connectionService.update({
      state: "connecting",
      stale: false,
      reason: undefined
    });

    const response = await this.fetchImpl(
      new URL("/api/hosts/register", this.relay.httpBaseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.authToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          relayId: this.relay.relayId,
          host: this.getHostDescriptor()
        })
      }
    );

    if (!response.ok) {
      this.connectionService.update({
        state: "degraded",
        reason: `relay-register-${response.status}`,
        stale: true
      });
      throw new Error(`Relay register failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as unknown;
    const routeId = parseRouteId(payload);
    if (!routeId) {
      this.connectionService.update({
        state: "degraded",
        reason: "relay-register-invalid-response",
        stale: true
      });
      throw new Error("Relay register response is missing routeId.");
    }

    this.connectionService.update({
      state: "connecting",
      routeId,
      stale: false
    });

    return { routeId };
  }

  public async connect(): Promise<HostRelayConnection> {
    await this.register();

    const host = this.getHostDescriptor();
    const relayUrl = new URL("/relay/host", normalizeBaseUrl(this.relay.wsBaseUrl));
    relayUrl.searchParams.set("hostId", host.hostId);
    relayUrl.searchParams.set("token", this.authToken);

    this.connectionService.update({
      state: "connecting",
      stale: false,
      reason: undefined
    });

    const socket = new this.WebSocketCtor(
      relayUrl.toString(),
      this.websocketProtocols
    );
    this.relaySocket = socket;
    socket.addEventListener("close", () => {
      if (this.relaySocket === socket) {
        this.close();
      }
    });

    return new Promise<HostRelayConnection>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        socket.removeEventListener("open", openListener);
        socket.removeEventListener("error", errorListener);
        socket.removeEventListener("close", closeListener);
      };

      const resolveReady = (routeId: string) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({
          routeId,
          close: async () => {
            this.close();
          }
        });
      };

      const rejectReady = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const openListener = (): void => {
        this.sendMessage({
          type: "host.hello",
          host
        });
      };

      const errorListener = (event: { error?: unknown; message?: string }): void => {
        rejectReady(
          new Error(
            event.error instanceof Error
              ? event.error.message
              : event.message ?? "Relay websocket failed."
          )
        );
      };

      const closeListener = (event: { code?: number; reason?: string }): void => {
        rejectReady(
          new Error(
            `Relay websocket closed before ready (${event.code ?? 0}: ${event.reason ?? "no-reason"}).`
          )
        );
      };

      socket.addEventListener("open", openListener);
      socket.addEventListener("error", errorListener);
      socket.addEventListener("close", closeListener);
      socket.addEventListener("message", (event) => {
        void (async () => {
          try {
            const payload = await parseJsonPayload(event.data);
            const parsed = safeParseRelayHostBridgeMessage(payload);
            if (!parsed.success) {
              return;
            }
            if (parsed.data.type === "host.ready") {
              this.routeId = parsed.data.routeId;
              this.connectionService.update({
                state: "connected",
                routeId: parsed.data.routeId,
                stale: false
              });
              resolveReady(parsed.data.routeId);
              return;
            }
            await this.handleMessage(parsed.data);
          } catch (error) {
            rejectReady(
              error instanceof Error
                ? error
                : new Error("Failed to parse relay bridge message.")
            );
          }
        })();
      });
    });
  }

  public close(): void {
    for (const [streamId] of this.eventStreams) {
      this.stopEventStream(streamId);
    }
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("Relay connection closed."));
    }
    this.pendingRequests.clear();
    if ((this.relaySocket?.readyState ?? 3) < 2) {
      this.relaySocket?.close(1000, "host relay client shutdown");
    }
    this.relaySocket = undefined;
    this.connectionService.close("relay-connection-closed");
  }

  private async handleMessage(message: RelayHostBridgeMessage): Promise<void> {
    switch (message.type) {
      case "control.request":
        await this.handleControlRequest(message);
        return;
      case "rpc.request":
        await this.handleRpcRequest(message);
        return;
      case "event.start":
        this.startEventStream(message);
        return;
      case "event.stop":
        this.stopEventStream(message.streamId);
        return;
      case "host.ping":
        this.sendMessage({
          type: "host.pong",
          timestamp: message.timestamp
        });
        return;
      case "control.response":
      case "rpc.response":
      case "event.push":
      case "event.error":
      case "host.hello":
      case "host.ready":
      case "host.pong":
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  private async handleControlRequest(
    message: Extract<RelayHostBridgeMessage, { type: "control.request" }>
  ): Promise<void> {
    const targetUrl = new URL(message.path, this.localHttpBaseUrl);
    for (const [key, value] of Object.entries(message.query ?? {})) {
      targetUrl.searchParams.set(key, value);
    }

    try {
      const response = await this.fetchImpl(targetUrl, {
        method: message.method,
        headers: sanitizeForwardHeaders(message.headers),
        body:
          message.method === "POST" && message.body !== undefined
            ? JSON.stringify(message.body)
            : undefined
      });
      this.sendMessage({
        type: "control.response",
        requestId: message.requestId,
        statusCode: response.status,
        body: await readResponsePayload(response)
      });
    } catch (error) {
      this.sendMessage({
        type: "control.response",
        requestId: message.requestId,
        statusCode: 502,
        body: {
          ok: false,
          error: {
            code: "HOST_RELAY_FORWARD_FAILED",
            message:
              error instanceof Error ? error.message : "Control request failed."
          }
        }
      });
    }
  }

  private async handleRpcRequest(
    message: Extract<RelayHostBridgeMessage, { type: "rpc.request" }>
  ): Promise<void> {
    try {
      const response = await this.fetchImpl(
        new URL("/rpc", this.localHttpBaseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(sanitizeForwardHeaders(message.headers) ?? {})
          },
          body: JSON.stringify(message.rpc)
        }
      );
      const payload = await readResponsePayload(response);
      this.sendMessage({
        type: "rpc.response",
        requestId: message.requestId,
        response: payload
      });
    } catch (error) {
      const request = safeParseWorkbenchRpcRequest(message.rpc);
      this.sendMessage({
        type: "rpc.response",
        requestId: message.requestId,
        response: request.success
          ? parseWorkbenchRpcResponse({
              id: request.data.id,
              method: request.data.method,
              ok: false,
              error: {
                code: "HOST_RELAY_FORWARD_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "RPC relay forward failed."
              }
            })
          : {
              ok: false,
              error: {
                code: "HOST_RELAY_FORWARD_FAILED",
                message: "Relay forwarded an invalid RPC request."
              }
            }
      });
    }
  }

  private startEventStream(
    message: Extract<RelayHostBridgeMessage, { type: "event.start" }>
  ): void {
    this.stopEventStream(message.streamId);

    const streamSocket = new this.WebSocketCtor(
      buildLocalEventsUrl(this.localEventsUrl, sanitizeForwardHeaders(message.query)),
      this.websocketProtocols
    );
    this.eventStreams.set(message.streamId, streamSocket);

    const sendError = (reason: string): void => {
      this.sendMessage({
        type: "event.error",
        streamId: message.streamId,
        message: reason
      });
    };

    streamSocket.addEventListener("message", (event) => {
      void (async () => {
        try {
          const payload = await parseJsonPayload(event.data);
          this.sendMessage({
            type: "event.push",
            streamId: message.streamId,
            push: payload as never
          });
        } catch (error) {
          sendError(
            error instanceof Error
              ? error.message
              : "Failed to parse local event stream payload."
          );
        }
      })();
    });
    streamSocket.addEventListener("error", (event) => {
      sendError(
        event.error instanceof Error
          ? event.error.message
          : event.message ?? "Local event stream websocket failed."
      );
    });
    streamSocket.addEventListener("close", (event) => {
      if (this.eventStreams.get(message.streamId) !== streamSocket) {
        return;
      }
      this.eventStreams.delete(message.streamId);
      if ((event.code ?? 1000) !== 1000) {
        sendError(
          `Local event stream closed unexpectedly (${event.code ?? 0}: ${event.reason ?? "no-reason"}).`
        );
      }
    });
  }

  private stopEventStream(streamId: string): void {
    const streamSocket = this.eventStreams.get(streamId);
    if (!streamSocket) {
      return;
    }
    this.eventStreams.delete(streamId);
    if ((streamSocket.readyState ?? 3) < 2) {
      streamSocket.close(1000, "relay event stream stop");
    }
  }

  private sendMessage(message: RelayHostBridgeMessage): void {
    this.relaySocket?.send(JSON.stringify(message));
  }
}
