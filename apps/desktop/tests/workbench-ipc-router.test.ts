import { describe, expect, it, vi } from "vitest";
import type { WorkbenchShellService } from "@another-workbench/desktop-server";
import type {
  EventEnvelope,
  WorkbenchEventPush,
  WorkbenchEventPushBatch,
  WorkbenchRpcRequest
} from "@another-workbench/shared";
import { createWorkbenchIpcRouter } from "../src/electron/workbench-ipc-router.js";

const now = "2026-05-26T00:00:00.000Z";

const createEnvelope = (sequence: number): EventEnvelope => ({
  eventId: `evt-${sequence}`,
  cursor: `cursor-${sequence}`,
  occurredAt: now,
  event: {
    type: "message.delta",
    sessionId: "session-1",
    turnId: "turn-1",
    messageId: "message-1",
    delta: String(sequence)
  }
});

describe("Workbench IPC router", () => {
  it("batches subscription pushes before crossing the Electron IPC boundary", async () => {
    let subscribed:
      | ((envelope: EventEnvelope) => void)
      | undefined;
    let scheduledDrain:
      | (() => void)
      | undefined;
    const unsubscribe = vi.fn();
    const service = {
      subscribeFromCursor: vi.fn((handler: (envelope: EventEnvelope) => void) => {
        subscribed = handler;
        return unsubscribe;
      }),
      dispose: vi.fn(async () => {})
    } as unknown as WorkbenchShellService;
    const onPush = vi.fn<(push: WorkbenchEventPush) => void>();
    const onPushBatch = vi.fn<(batch: WorkbenchEventPushBatch) => void>();
    const router = createWorkbenchIpcRouter({
      service,
      onPush,
      onPushBatch,
      createSubscriptionId: () => "sub-fixed",
      pushBatchMaxSize: 2,
      schedulePushDrain: (callback) => {
        scheduledDrain = callback;
        return () => {
          scheduledDrain = undefined;
        };
      }
    });

    const request = {
      id: "req-subscribe",
      method: "events.subscribe",
      params: {}
    } satisfies WorkbenchRpcRequest;
    const response = await router.handleRequest(request);

    expect(response.ok).toBe(true);
    expect(subscribed).toBeDefined();
    subscribed?.(createEnvelope(1));
    subscribed?.(createEnvelope(2));
    subscribed?.(createEnvelope(3));

    expect(onPush).not.toHaveBeenCalled();
    expect(onPushBatch).not.toHaveBeenCalled();

    scheduledDrain?.();
    expect(onPush).not.toHaveBeenCalled();
    expect(onPushBatch).toHaveBeenCalledTimes(1);
    expect(onPushBatch.mock.calls[0]?.[0]).toMatchObject({
      channel: "workbench.events.batch",
      pushes: [
        { subscriptionId: "sub-fixed", envelope: { eventId: "evt-1" } },
        { subscriptionId: "sub-fixed", envelope: { eventId: "evt-2" } }
      ]
    });

    scheduledDrain?.();
    expect(onPushBatch).toHaveBeenCalledTimes(2);
    expect(onPushBatch.mock.calls[1]?.[0].pushes).toHaveLength(1);
    expect(onPushBatch.mock.calls[1]?.[0].pushes[0]?.envelope.eventId).toBe("evt-3");
  });

  it("flushes only the unsubscribed subscription's queued pushes before returning", async () => {
    // This verifies targeted unsubscribe drain, not cross-subscription global
    // FIFO. The desktop store uses one full-domain subscription for cursor
    // tracking, so independent subscription queues should not be merged into a
    // single cursor consumer.
    const handlers = new Map<string, (envelope: EventEnvelope) => void>();
    let scheduledDrain:
      | (() => void)
      | undefined;
    const unsubscribeBySubscriptionId = new Map<string, ReturnType<typeof vi.fn>>();
    const subscriptionOrder = ["sub-a", "sub-b"];
    const service = {
      subscribeFromCursor: vi.fn(
        (handler: (envelope: EventEnvelope) => void) => {
          const subscriptionId =
            subscriptionOrder[handlers.size] ?? `sub-${handlers.size + 1}`;
          handlers.set(subscriptionId, handler);
          const unsubscribe = vi.fn(() => {
            handlers.delete(subscriptionId);
          });
          unsubscribeBySubscriptionId.set(subscriptionId, unsubscribe);
          return unsubscribe;
        }
      ),
      dispose: vi.fn(async () => {})
    } as unknown as WorkbenchShellService;
    const onPush = vi.fn<(push: WorkbenchEventPush) => void>();
    const onPushBatch = vi.fn<(batch: WorkbenchEventPushBatch) => void>();
    const router = createWorkbenchIpcRouter({
      service,
      onPush,
      onPushBatch,
      pushBatchMaxSize: 10,
      schedulePushDrain: (callback) => {
        scheduledDrain = callback;
        return () => {
          scheduledDrain = undefined;
        };
      }
    });

    await router.handleRequest({
      id: "req-subscribe-a",
      method: "events.subscribe",
      params: { subscriptionId: "sub-a" }
    } satisfies WorkbenchRpcRequest);
    await router.handleRequest({
      id: "req-subscribe-b",
      method: "events.subscribe",
      params: { subscriptionId: "sub-b" }
    } satisfies WorkbenchRpcRequest);

    handlers.get("sub-a")?.(createEnvelope(1));
    handlers.get("sub-b")?.(createEnvelope(2));
    handlers.get("sub-a")?.(createEnvelope(3));

    expect(onPushBatch).not.toHaveBeenCalled();
    const response = await router.handleRequest({
      id: "req-unsubscribe-a",
      method: "events.unsubscribe",
      params: { subscriptionId: "sub-a" }
    } satisfies WorkbenchRpcRequest);

    expect(response.ok).toBe(true);
    expect(unsubscribeBySubscriptionId.get("sub-a")).toHaveBeenCalledTimes(1);
    expect(onPush).not.toHaveBeenCalled();
    expect(onPushBatch).toHaveBeenCalledTimes(1);
    expect(onPushBatch.mock.calls[0]?.[0].pushes.map((push) => push.envelope.eventId))
      .toEqual(["evt-1", "evt-3"]);

    scheduledDrain?.();
    expect(onPushBatch).toHaveBeenCalledTimes(2);
    expect(onPushBatch.mock.calls[1]?.[0].pushes.map((push) => push.subscriptionId))
      .toEqual(["sub-b"]);
    expect(onPushBatch.mock.calls[1]?.[0].pushes[0]?.envelope.eventId).toBe("evt-2");
  });

  it("bounds each scheduled IPC batch by serialized bytes", async () => {
    let subscribed: ((envelope: EventEnvelope) => void) | undefined;
    const scheduled: Array<() => void> = [];
    const service = {
      subscribeFromCursor: vi.fn((handler: (envelope: EventEnvelope) => void) => {
        subscribed = handler;
        return vi.fn();
      }),
      dispose: vi.fn(async () => {})
    } as unknown as WorkbenchShellService;
    const onPushBatch = vi.fn<(batch: WorkbenchEventPushBatch) => void>();
    const router = createWorkbenchIpcRouter({
      service,
      onPush: vi.fn(),
      onPushBatch,
      pushBatchMaxSize: 100,
      pushBatchMaxBytes: 700,
      schedulePushDrain: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      }
    });

    await router.handleRequest({
      id: "req-subscribe",
      method: "events.subscribe",
      params: {}
    } satisfies WorkbenchRpcRequest);
    for (let index = 1; index <= 3; index += 1) {
      const envelope = createEnvelope(index);
      subscribed?.({
        ...envelope,
        event: {
          ...envelope.event,
          delta: "x".repeat(400)
        }
      });
    }

    scheduled.shift()?.();
    scheduled.shift()?.();
    scheduled.shift()?.();
    expect(onPushBatch.mock.calls.map(([batch]) => batch.pushes.length)).toEqual([
      1,
      1,
      1
    ]);
  });
});
