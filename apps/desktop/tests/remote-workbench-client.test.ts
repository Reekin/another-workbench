import { describe, expect, it, vi } from "vitest";
import type {
  WorkbenchEventPush,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import { createRemoteWorkbenchClientApi } from "../src/transport/remote-workbench-client.js";

type ListenerMap = {
  close: Array<(event: { code?: number; reason?: string }) => void>;
  error: Array<(event: { error?: unknown; message?: string }) => void>;
  message: Array<(event: { data: unknown }) => void>;
  open: Array<(event: Event) => void>;
};

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];

  public readonly url: string;
  public readonly protocols?: string | string[];
  public readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  public readyState = 1;

  private readonly listeners: ListenerMap = {
    close: [],
    error: [],
    message: [],
    open: []
  };

  public constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  public addEventListener<K extends keyof ListenerMap>(
    type: K,
    listener: ListenerMap[K][number]
  ): void {
    this.listeners[type].push(listener as never);
  }

  public removeEventListener<K extends keyof ListenerMap>(
    type: K,
    listener: ListenerMap[K][number]
  ): void {
    this.listeners[type] = this.listeners[type].filter(
      (entry) => entry !== listener
    ) as ListenerMap[K];
  }

  public close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push({
      code,
      reason
    });
  }

  public emitMessage(payload: unknown): void {
    for (const listener of this.listeners.message) {
      listener({
        data: payload
      });
    }
  }
}

const createJsonResponse = (
  payload: WorkbenchRpcResponse,
  status = 200
): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });

const parseRequestBody = (init?: RequestInit): WorkbenchRpcRequest => {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected JSON request body.");
  }
  return JSON.parse(body) as WorkbenchRpcRequest;
};

describe("remote workbench client api", () => {
  it("posts RPC requests to the configured HTTP endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = parseRequestBody(init);
      expect(request.method).toBe("agent.list");
      return createJsonResponse({
        id: request.id,
        method: "agent.list",
        ok: true,
        result: {
          agents: []
        }
      } as const);
    });

    const client = createRemoteWorkbenchClientApi({
      httpUrl: "https://remote.example.test/rpc",
      websocketUrl: "wss://remote.example.test/events",
      fetch: fetchMock as typeof fetch,
      WebSocket: FakeWebSocket as never
    });

    const response = await client.request({
      id: "req-agent-list",
      method: "agent.list",
      params: {}
    });

    expect(response).toEqual({
      id: "req-agent-list",
      method: "agent.list",
      ok: true,
      result: {
        agents: []
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://remote.example.test/rpc");
  });

  it("subscribes with HTTP bootstrap plus websocket events and tears down cleanly", async () => {
    FakeWebSocket.instances = [];
    const requestBodies: WorkbenchRpcRequest[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = parseRequestBody(init);
      requestBodies.push(request);

      if (request.method === "events.subscribe") {
        return createJsonResponse({
          id: request.id,
          method: "events.subscribe",
          ok: true,
          result: {
            subscriptionId: "sub-remote-1",
            fromCursor: "cursor-remote-2"
          }
        } as const);
      }

      if (request.method === "events.unsubscribe") {
        return createJsonResponse({
          id: request.id,
          method: "events.unsubscribe",
          ok: true,
          result: {
            unsubscribed: true
          }
        } as const);
      }

      throw new Error(`Unexpected method: ${request.method}`);
    });

    const client = createRemoteWorkbenchClientApi({
      httpUrl: "https://remote.example.test/rpc",
      websocketUrl: "wss://remote.example.test/events",
      fetch: fetchMock as typeof fetch,
      WebSocket: FakeWebSocket as never,
      createId: () => "req-fixed"
    });

    const handler = vi.fn();
    const subscription = await client.subscribe(
      {
        fromCursor: "cursor-client-1",
        filter: {
          conversationId: "conversation-1"
        }
      },
      handler
    );

    expect(subscription.subscriptionId).toBe("sub-remote-1");
    expect(requestBodies[0]?.method).toBe("events.subscribe");
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toContain("subscriptionId=sub-remote-1");
    expect(socket?.url).toContain("fromCursor=cursor-remote-2");
    expect(socket?.url).toContain("conversationId=conversation-1");

    const push: WorkbenchEventPush = {
      channel: "workbench.events",
      subscriptionId: "sub-remote-1",
      envelope: {
        eventId: "evt-remote-1",
        cursor: "cursor-remote-3",
        occurredAt: "2026-04-21T00:00:00.000Z",
        event: {
          type: "turn.started",
          sessionId: "session-1",
          turnId: "turn-1"
        }
      }
    };
    socket?.emitMessage(JSON.stringify(push));
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(push);

    await subscription.unsubscribe();

    expect(requestBodies[1]?.method).toBe("events.unsubscribe");
    expect(requestBodies[1]).toMatchObject({
      params: {
        subscriptionId: "sub-remote-1"
      }
    });
    expect(socket?.closeCalls).toEqual([
      {
        code: 1000,
        reason: "client unsubscribe"
      }
    ]);
  });
});
