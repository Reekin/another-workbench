import { contextBridge, ipcRenderer } from "electron";
import type {
  WorkbenchClientApi,
  WorkbenchEventHandler,
  WorkbenchEventPush,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  safeParseWorkbenchEventPush,
  safeParseWorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  WORKBENCH_IPC_EVENTS_PUSH_CHANNEL,
  WORKBENCH_IPC_REQUEST_CHANNEL
} from "./ipc-channels.js";

const handlersBySubscriptionId = new Map<string, Set<WorkbenchEventHandler>>();

ipcRenderer.on(WORKBENCH_IPC_EVENTS_PUSH_CHANNEL, (_event, payload: unknown) => {
  const parsed = safeParseWorkbenchEventPush(payload);
  if (!parsed.success) {
    return;
  }
  const push = parsed.data;
  const handlers = handlersBySubscriptionId.get(push.subscriptionId);
  if (!handlers || handlers.size === 0) {
    return;
  }
  for (const handler of handlers) {
    handler(push);
  }
});

const request = async (payload: WorkbenchRpcRequest): Promise<WorkbenchRpcResponse> => {
  const raw = (await ipcRenderer.invoke(
    WORKBENCH_IPC_REQUEST_CHANNEL,
    payload
  )) as unknown;
  const parsed = safeParseWorkbenchRpcResponse(raw);
  if (!parsed.success) {
    throw new Error("Electron IPC returned an invalid WorkbenchRpcResponse payload.");
  }
  return parsed.data;
};

const ensureOk = <T extends WorkbenchRpcResponse>(
  response: T,
  expectedMethod: WorkbenchRpcRequest["method"]
): T => {
  if (response.method !== expectedMethod) {
    throw new Error(
      `Electron IPC method mismatch. expected=${expectedMethod} actual=${response.method}`
    );
  }
  if (!response.ok) {
    throw new Error(`[${response.method}] ${response.error.code}: ${response.error.message}`);
  }
  return response;
};

const subscribe: WorkbenchClientApi["subscribe"] = async (params, handler) => {
  const response = ensureOk(await request({
    id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    method: "events.subscribe",
    params
  }), "events.subscribe") as Extract<WorkbenchRpcResponse, { method: "events.subscribe"; ok: true }>;

  const subscriptionId = response.result.subscriptionId;
  const handlerSet = handlersBySubscriptionId.get(subscriptionId) ?? new Set();
  handlerSet.add(handler);
  handlersBySubscriptionId.set(subscriptionId, handlerSet);

  return {
    subscriptionId,
    unsubscribe: async () => {
      const existing = handlersBySubscriptionId.get(subscriptionId);
      if (existing) {
        existing.delete(handler);
        if (existing.size === 0) {
          handlersBySubscriptionId.delete(subscriptionId);
        }
      }

      // Tell main it can stop pushing for this subscription.
      ensureOk(
        await request({
          id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          method: "events.unsubscribe",
          params: { subscriptionId }
        }),
        "events.unsubscribe"
      );
    }
  };
};

const api: WorkbenchClientApi = {
  request,
  subscribe
};

contextBridge.exposeInMainWorld("workbench", api);
