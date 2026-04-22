import {
  createRemoteRpcHandler,
  type WorkbenchShellService
} from "@another-workbench/desktop-server";
import type {
  WorkbenchEventPush,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import { parseWorkbenchRpcResponse, safeParseWorkbenchRpcRequest } from "@another-workbench/shared";

type SubscriptionRecord = {
  subscriptionId: string;
  unsubscribe: () => void;
};

export type WorkbenchIpcRouter = {
  handleRequest: (rawRequest: unknown) => Promise<WorkbenchRpcResponse>;
  dispose: () => Promise<void>;
};

export type CreateWorkbenchIpcRouterOptions = {
  service: WorkbenchShellService;
  onPush: (push: WorkbenchEventPush) => void;
  createSubscriptionId?: () => string;
};

const createOpaqueSubscriptionId = (): string =>
  `electron-sub-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

const toErrorResponse = (
  request: { id: string; method: WorkbenchRpcRequest["method"] } | undefined,
  code: string,
  message: string,
  details?: Record<string, unknown>
): WorkbenchRpcResponse =>
  parseWorkbenchRpcResponse({
    id: request?.id ?? "unknown-request",
    method: request?.method ?? "engine.list",
    ok: false,
    error: {
      code,
      message,
      details
    }
  } as WorkbenchRpcResponse);

export const createWorkbenchIpcRouter = (
  options: CreateWorkbenchIpcRouterOptions
): WorkbenchIpcRouter => {
  const createSubscriptionId =
    options.createSubscriptionId ?? createOpaqueSubscriptionId;
  const rpc = createRemoteRpcHandler(options.service, {
    createSubscriptionId
  });

  const subscriptions = new Map<string, SubscriptionRecord>();

  const handleSubscribe = async (
    request: Extract<WorkbenchRpcRequest, { method: "events.subscribe" }>
  ): Promise<WorkbenchRpcResponse> => {
    const subscriptionId = request.params.subscriptionId ?? createSubscriptionId();
    const existing = subscriptions.get(subscriptionId);
    if (existing) {
      return parseWorkbenchRpcResponse({
        id: request.id,
        method: request.method,
        ok: true,
        result: {
          subscriptionId,
          fromCursor: request.params.fromCursor
        }
      });
    }

    const unsubscribe = options.service.subscribeFromCursor(
      (envelope) => {
        options.onPush(rpc.createEventPush(subscriptionId, envelope));
      },
      {
        fromCursor: request.params.fromCursor,
        filter: request.params.filter
      }
    );

    subscriptions.set(subscriptionId, { subscriptionId, unsubscribe });

    return parseWorkbenchRpcResponse({
      id: request.id,
      method: request.method,
      ok: true,
      result: {
        subscriptionId,
        fromCursor: request.params.fromCursor
      }
    });
  };

  const handleUnsubscribe = async (
    request: Extract<WorkbenchRpcRequest, { method: "events.unsubscribe" }>
  ): Promise<WorkbenchRpcResponse> => {
    const record = subscriptions.get(request.params.subscriptionId);
    if (record) {
      record.unsubscribe();
      subscriptions.delete(record.subscriptionId);
    }
    return parseWorkbenchRpcResponse({
      id: request.id,
      method: request.method,
      ok: true,
      result: {
        unsubscribed: true
      }
    });
  };

  return {
    handleRequest: async (rawRequest: unknown) => {
      const parsed = safeParseWorkbenchRpcRequest(rawRequest);
      if (!parsed.success) {
        return toErrorResponse(
          undefined,
          "ELECTRON_BAD_REQUEST",
          "Invalid WorkbenchRpcRequest payload."
        );
      }

      const request = parsed.data;
      try {
        switch (request.method) {
          case "events.subscribe":
            return handleSubscribe(request);
          case "events.unsubscribe":
            return handleUnsubscribe(request);
          default:
            return rpc.handleRequest(request);
        }
      } catch (error) {
        return toErrorResponse(
          request,
          "ELECTRON_REQUEST_FAILED",
          error instanceof Error ? error.message : "Unknown electron request error"
        );
      }
    },

    dispose: async () => {
      for (const record of subscriptions.values()) {
        record.unsubscribe();
      }
      subscriptions.clear();
      await options.service.dispose();
    }
  };
};
