import {
  createRemoteRpcHandler,
  type WorkbenchShellService
} from "@another-workbench/desktop-server";
import type {
  WorkbenchEventPushBatch,
  WorkbenchEventPush,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import { parseWorkbenchRpcResponse, safeParseWorkbenchRpcRequest } from "@another-workbench/shared";

type SubscriptionRecord = {
  subscriptionId: string;
  unsubscribe: () => void;
};

type CancelScheduledPushDrain = () => void;
type PushDrainScheduler = (callback: () => void) => CancelScheduledPushDrain;
type QueuedPush = {
  push: WorkbenchEventPush;
  bytes: number;
};

export type WorkbenchIpcRouter = {
  handleRequest: (rawRequest: unknown) => Promise<WorkbenchRpcResponse>;
  dispose: () => Promise<void>;
};

export type CreateWorkbenchIpcRouterOptions = {
  service: WorkbenchShellService;
  onPush: (push: WorkbenchEventPush) => void;
  onPushBatch?: (batch: WorkbenchEventPushBatch) => void;
  createSubscriptionId?: () => string;
  pushBatchMaxSize?: number;
  pushBatchMaxBytes?: number;
  pushDrainBudgetMs?: number;
  schedulePushDrain?: PushDrainScheduler;
};

const defaultPushBatchMaxSize = 500;
const defaultPushBatchMaxBytes = 256 * 1024;
const defaultPushDrainBudgetMs = 8;
const utf8ByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const scheduleDefaultPushDrain: PushDrainScheduler = (callback) => {
  const timeoutId = setTimeout(callback, 0);
  return () => clearTimeout(timeoutId);
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
  const pushBatchMaxSize = options.pushBatchMaxSize ?? defaultPushBatchMaxSize;
  const pushBatchMaxBytes = options.pushBatchMaxBytes ?? defaultPushBatchMaxBytes;
  const pushDrainBudgetMs = options.pushDrainBudgetMs ?? defaultPushDrainBudgetMs;
  const schedulePushDrain = options.schedulePushDrain ?? scheduleDefaultPushDrain;

  const subscriptions = new Map<string, SubscriptionRecord>();
  const pushQueue: QueuedPush[] = [];
  let pushQueueHead = 0;
  let cancelScheduledPushDrain: CancelScheduledPushDrain | undefined;

  const deliverPushes = (pushes: WorkbenchEventPush[]): void => {
    if (pushes.length === 0) {
      return;
    }
    if (options.onPushBatch) {
      options.onPushBatch({
        channel: "workbench.events.batch",
        pushes
      });
      return;
    }
    for (const push of pushes) {
      options.onPush(push);
    }
  };

  const schedulePushQueueDrain = (): void => {
    if (cancelScheduledPushDrain || pushQueueHead >= pushQueue.length) {
      return;
    }
    cancelScheduledPushDrain = schedulePushDrain(() => {
      cancelScheduledPushDrain = undefined;
      const startedAt = performance.now();
      const pushes: WorkbenchEventPush[] = [];
      let batchBytes = 0;
      while (pushQueueHead < pushQueue.length && pushes.length < pushBatchMaxSize) {
        const queued = pushQueue[pushQueueHead];
        if (!queued) {
          break;
        }
        if (
          pushes.length > 0 &&
          (batchBytes + queued.bytes > pushBatchMaxBytes ||
            performance.now() - startedAt >= pushDrainBudgetMs)
        ) {
          break;
        }
        pushQueueHead += 1;
        pushes.push(queued.push);
        batchBytes += queued.bytes;
      }
      deliverPushes(pushes);
      if (pushQueueHead >= pushQueue.length) {
        pushQueue.length = 0;
        pushQueueHead = 0;
      } else if (pushQueueHead >= 1_024 && pushQueueHead * 2 >= pushQueue.length) {
        pushQueue.splice(0, pushQueueHead);
        pushQueueHead = 0;
      }
      schedulePushQueueDrain();
    });
  };

  const enqueuePush = (push: WorkbenchEventPush): void => {
    pushQueue.push({
      push,
      bytes: utf8ByteLength(push)
    });
    schedulePushQueueDrain();
  };

  const flushPushQueue = (subscriptionId?: string): void => {
    if (cancelScheduledPushDrain) {
      cancelScheduledPushDrain();
      cancelScheduledPushDrain = undefined;
    }
    if (!subscriptionId) {
      while (pushQueueHead < pushQueue.length) {
        deliverPushes(
          pushQueue
            .slice(pushQueueHead, pushQueueHead + pushBatchMaxSize)
            .map((queued) => queued.push)
        );
        pushQueueHead += pushBatchMaxSize;
      }
      pushQueue.length = 0;
      pushQueueHead = 0;
      return;
    }
    // Targeted unsubscribe drain is scoped to the subscription being torn down.
    // It does not promise global FIFO across multiple subscriptions; consumers
    // that share a single cursor should use the desktop shell's single
    // full-domain subscription rather than merging independent subscriptions.
    const pendingForSubscription: WorkbenchEventPush[] = [];
    const retainedPushes: WorkbenchEventPush[] = [];
    for (let index = pushQueueHead; index < pushQueue.length; index += 1) {
      const queued = pushQueue[index];
      if (!queued) {
        continue;
      }
      if (queued.push.subscriptionId === subscriptionId) {
        pendingForSubscription.push(queued.push);
      } else {
        retainedPushes.push(queued.push);
      }
    }
    pushQueue.splice(
      0,
      pushQueue.length,
      ...retainedPushes.map((push) => ({
        push,
        bytes: utf8ByteLength(push)
      }))
    );
    pushQueueHead = 0;
    while (pendingForSubscription.length > 0) {
      deliverPushes(pendingForSubscription.splice(0, pushBatchMaxSize));
    }
    schedulePushQueueDrain();
  };

  const unsubscribeRecord = (record: SubscriptionRecord): void => {
    try {
      record.unsubscribe();
    } finally {
      subscriptions.delete(record.subscriptionId);
      flushPushQueue(record.subscriptionId);
    }
  };

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
        enqueuePush(rpc.createEventPush(subscriptionId, envelope));
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
      unsubscribeRecord(record);
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
        unsubscribeRecord(record);
      }
      subscriptions.clear();
      flushPushQueue();
      await options.service.dispose();
    }
  };
};
