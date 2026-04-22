import type {
  WorkbenchClientApi,
  WorkbenchEventHandler,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  safeParseWorkbenchEventPush,
  safeParseWorkbenchRpcResponse
} from "@another-workbench/shared";

const createOpaqueId = (): string =>
  `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type IdFactory = () => string;

type RemoteWorkbenchMessageEvent = {
  data: unknown;
};

type RemoteWorkbenchCloseEvent = {
  code?: number;
  reason?: string;
};

type RemoteWorkbenchErrorEvent = {
  error?: unknown;
  message?: string;
};

type RemoteWorkbenchWebSocketEventMap = {
  close: RemoteWorkbenchCloseEvent;
  error: RemoteWorkbenchErrorEvent;
  message: RemoteWorkbenchMessageEvent;
  open: Event;
};

export type RemoteWorkbenchWebSocketLike = {
  addEventListener<K extends keyof RemoteWorkbenchWebSocketEventMap>(
    type: K,
    listener: (event: RemoteWorkbenchWebSocketEventMap[K]) => void
  ): void;
  removeEventListener<K extends keyof RemoteWorkbenchWebSocketEventMap>(
    type: K,
    listener: (event: RemoteWorkbenchWebSocketEventMap[K]) => void
  ): void;
  close: (code?: number, reason?: string) => void;
  readyState?: number;
};

export type RemoteWorkbenchWebSocketConstructor = new (
  url: string,
  protocols?: string | string[]
) => RemoteWorkbenchWebSocketLike;

export type RemoteWorkbenchClientOptions = {
  httpUrl: string;
  websocketUrl: string;
  headers?: Readonly<Record<string, string>>;
  websocketProtocols?: string | string[];
  createId?: IdFactory;
  fetch?: typeof fetch;
  WebSocket?: RemoteWorkbenchWebSocketConstructor;
};

export type RemoteWorkbenchClientErrorInput = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export class RemoteWorkbenchClientError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  public constructor(input: RemoteWorkbenchClientErrorInput) {
    super(input.message, input.cause ? { cause: input.cause } : undefined);
    this.name = "RemoteWorkbenchClientError";
    this.code = input.code;
    this.details = input.details;
  }
}

const encodeQueryValue = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readBearerToken = (
  headers: Readonly<Record<string, string>> | undefined
): string | undefined => {
  const authorization =
    headers?.authorization ?? headers?.Authorization;
  if (!authorization) {
    return undefined;
  }
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : authorization;
};

const buildSubscriptionWebSocketUrl = (
  websocketUrl: string,
  params: Extract<WorkbenchRpcRequest, { method: "events.subscribe" }>["params"],
  subscriptionId: string,
  fromCursor?: string,
  headers?: Readonly<Record<string, string>>
): string => {
  const url = new URL(websocketUrl);
  url.searchParams.set("subscriptionId", subscriptionId);
  const cursor = encodeQueryValue(fromCursor ?? params.fromCursor);
  if (cursor) {
    url.searchParams.set("fromCursor", cursor);
  }
  if (params.filter) {
    if (params.filter.sessionId) {
      url.searchParams.set("sessionId", params.filter.sessionId);
    }
    if (params.filter.conversationId) {
      url.searchParams.set("conversationId", params.filter.conversationId);
    }
    if (params.filter.eventTypes && params.filter.eventTypes.length > 0) {
      url.searchParams.set("eventTypes", params.filter.eventTypes.join(","));
    }
  }
  const sessionToken = readBearerToken(headers);
  if (sessionToken) {
    url.searchParams.set("sessionToken", sessionToken);
  }
  const resumeToken =
    headers?.["x-workbench-resume-token"] ??
    headers?.["X-Workbench-Resume-Token"];
  if (resumeToken) {
    url.searchParams.set("resumeToken", resumeToken);
  }
  const hostId =
    headers?.["x-workbench-host-id"] ?? headers?.["X-Workbench-Host-Id"];
  if (hostId) {
    url.searchParams.set("hostId", hostId);
  }
  return url.toString();
};

const parseWebSocketData = async (data: unknown): Promise<unknown> => {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(data)));
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      )
    );
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return JSON.parse(await data.text());
  }
  return data;
};

const requestRemoteRpc = async (
  request: WorkbenchRpcRequest,
  options: Required<Pick<RemoteWorkbenchClientOptions, "httpUrl">> & {
    headers?: Readonly<Record<string, string>>;
    fetch: typeof fetch;
  }
): Promise<WorkbenchRpcResponse> => {
  let rawText = "";
  let httpStatus = 0;

  try {
    const response = await options.fetch(options.httpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options.headers
      },
      body: JSON.stringify(request)
    });
    httpStatus = response.status;
    rawText = await response.text();
  } catch (error) {
    throw new RemoteWorkbenchClientError({
      code: "REMOTE_RPC_FETCH_FAILED",
      message: `Remote workbench request failed for ${request.method}.`,
      details: {
        httpUrl: options.httpUrl,
        method: request.method
      },
      cause: error
    });
  }

  let rawPayload: unknown = rawText;
  try {
    rawPayload = JSON.parse(rawText);
  } catch {
    // Keep the original text for diagnostics if the remote endpoint did not
    // return structured JSON.
  }

  const parsed = safeParseWorkbenchRpcResponse(rawPayload);
  if (!parsed.success) {
    throw new RemoteWorkbenchClientError({
      code: "REMOTE_RPC_RESPONSE_INVALID",
      message: `Remote workbench returned an invalid RPC payload for ${request.method}.`,
      details: {
        httpStatus,
        httpUrl: options.httpUrl,
        method: request.method,
        body:
          typeof rawPayload === "string"
            ? rawPayload.slice(0, 1000)
            : rawPayload
      }
    });
  }

  return parsed.data;
};

const ensureSubscribeResponse = (
  response: WorkbenchRpcResponse
): Extract<WorkbenchRpcResponse, { method: "events.subscribe"; ok: true }> => {
  if (response.method !== "events.subscribe") {
    throw new RemoteWorkbenchClientError({
      code: "REMOTE_EVENTS_SUBSCRIBE_METHOD_MISMATCH",
      message: `Remote workbench subscribe returned ${response.method} instead of events.subscribe.`,
      details: {
        actualMethod: response.method
      }
    });
  }
  if (!response.ok) {
    throw new RemoteWorkbenchClientError({
      code: response.error.code,
      message: `[events.subscribe] ${response.error.message}`,
      details: response.error.details
    });
  }
  return response;
};

const ensureUnsubscribeResponse = (
  response: WorkbenchRpcResponse
): Extract<WorkbenchRpcResponse, { method: "events.unsubscribe"; ok: true }> => {
  if (response.method !== "events.unsubscribe") {
    throw new RemoteWorkbenchClientError({
      code: "REMOTE_EVENTS_UNSUBSCRIBE_METHOD_MISMATCH",
      message: `Remote workbench unsubscribe returned ${response.method} instead of events.unsubscribe.`,
      details: {
        actualMethod: response.method
      }
    });
  }
  if (!response.ok) {
    throw new RemoteWorkbenchClientError({
      code: response.error.code,
      message: `[events.unsubscribe] ${response.error.message}`,
      details: response.error.details
    });
  }
  return response;
};

export const createRemoteWorkbenchClientApi = (
  options: RemoteWorkbenchClientOptions
): WorkbenchClientApi => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new RemoteWorkbenchClientError({
      code: "REMOTE_FETCH_UNAVAILABLE",
      message: "Remote mode requires fetch to be available in the renderer runtime."
    });
  }

  const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new RemoteWorkbenchClientError({
      code: "REMOTE_WEBSOCKET_UNAVAILABLE",
      message:
        "Remote mode requires WebSocket to be available in the renderer runtime."
    });
  }

  const createId = options.createId ?? createOpaqueId;

  const request: WorkbenchClientApi["request"] = async (rpcRequest) =>
    requestRemoteRpc(rpcRequest, {
      fetch: fetchImpl,
      httpUrl: options.httpUrl,
      headers: options.headers
    });

  const subscribe: WorkbenchClientApi["subscribe"] = async (params, handler) => {
    const subscribeResponse = ensureSubscribeResponse(
      await request({
        id: createId(),
        method: "events.subscribe",
        params
      })
    );

    const subscriptionId = subscribeResponse.result.subscriptionId;
    const websocketEndpoint = buildSubscriptionWebSocketUrl(
      options.websocketUrl,
      params,
      subscriptionId,
      subscribeResponse.result.fromCursor,
      options.headers
    );

    let socket: RemoteWorkbenchWebSocketLike | undefined;
    let unsubscribed = false;
    let openError: RemoteWorkbenchClientError | undefined;

    const messageListener = (event: RemoteWorkbenchMessageEvent): void => {
      void (async () => {
        try {
          const payload = await parseWebSocketData(event.data);
          const parsed = safeParseWorkbenchEventPush(payload);
          if (!parsed.success) {
            return;
          }
          const push = parsed.data;
          if (push.subscriptionId !== subscriptionId) {
            return;
          }
          handler(push);
        } catch {
          // Ignore malformed event frames so a single bad push does not tear
          // down the renderer event stream.
        }
      })();
    };

    const errorListener = (event: RemoteWorkbenchErrorEvent): void => {
      if (!unsubscribed && !openError) {
        openError = new RemoteWorkbenchClientError({
          code: "REMOTE_EVENTS_SOCKET_ERROR",
          message: "Remote workbench events socket reported an error.",
          details: {
            websocketUrl: websocketEndpoint,
            error:
              event.error instanceof Error
                ? event.error.message
                : event.message ?? "unknown"
          }
        });
      }
    };

    const closeListener = (event: RemoteWorkbenchCloseEvent): void => {
      if (!unsubscribed && !openError && event.code !== 1000) {
        openError = new RemoteWorkbenchClientError({
          code: "REMOTE_EVENTS_SOCKET_CLOSED",
          message: "Remote workbench events socket closed before unsubscribe.",
          details: {
            websocketUrl: websocketEndpoint,
            code: event.code,
            reason: event.reason
          }
        });
      }
    };

    try {
      socket = new WebSocketCtor(websocketEndpoint, options.websocketProtocols);
      socket.addEventListener("message", messageListener);
      socket.addEventListener("error", errorListener);
      socket.addEventListener("close", closeListener);
    } catch (error) {
      await request({
        id: createId(),
        method: "events.unsubscribe",
        params: {
          subscriptionId
        }
      }).catch(() => undefined);
      throw new RemoteWorkbenchClientError({
        code: "REMOTE_EVENTS_SOCKET_CONSTRUCTION_FAILED",
        message: "Remote workbench events socket could not be created.",
        details: {
          websocketUrl: websocketEndpoint
        },
        cause: error
      });
    }

    if (openError) {
      throw openError;
    }

    return {
      subscriptionId,
      unsubscribe: async () => {
        if (unsubscribed) {
          return;
        }
        unsubscribed = true;

        socket?.removeEventListener("message", messageListener);
        socket?.removeEventListener("error", errorListener);
        socket?.removeEventListener("close", closeListener);
        if ((socket?.readyState ?? 0) < 2) {
          socket?.close(1000, "client unsubscribe");
        }

        const unsubscribeResponse = await request({
          id: createId(),
          method: "events.unsubscribe",
          params: {
            subscriptionId
          }
        });
        ensureUnsubscribeResponse(unsubscribeResponse);
      }
    };
  };

  return {
    request,
    subscribe
  };
};
