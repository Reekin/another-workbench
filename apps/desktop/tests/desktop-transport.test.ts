import { describe, expect, it, vi } from "vitest";
import type {
  WorkbenchClientApi,
  WorkbenchEventPush,
  WorkbenchRpcRequest,
  WorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  safeParseWorkbenchRpcRequest,
  safeParseWorkbenchRpcResponse
} from "@another-workbench/shared";
import {
  DesktopTransportError,
  createDesktopTransport
} from "../src/transport/desktop-transport.js";
import { connectDesktopTransportToStore } from "../src/transport/store-bridge.js";
import { createRendererStore } from "../src/store/store.js";

type PreloadMock = {
  api: WorkbenchClientApi;
  request: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  emitPush: (push: WorkbenchEventPush) => void;
};

const createPreloadMock = (config?: {
  onRequest?: (request: WorkbenchRpcRequest) => Promise<WorkbenchRpcResponse>;
}): PreloadMock => {
  let subscribedHandler: ((push: WorkbenchEventPush) => void) | undefined;
  const unsubscribe = vi.fn(async () => {});
  const request = vi.fn(async (payload: WorkbenchRpcRequest) => {
    if (config?.onRequest) {
      return config.onRequest(payload);
    }
    if (payload.method === "agent.list") {
      return {
        id: payload.id,
        method: "agent.list",
        ok: true,
        result: {
          agents: []
        }
      } as const;
    }
    if (payload.method === "agent.select") {
      return {
        id: payload.id,
        method: "agent.select",
        ok: true,
        result: {
          selectedAgentId: payload.params.agentId
        }
      } as const;
    }
    if (payload.method === "settings.get") {
      return {
        id: payload.id,
        method: "settings.get",
        ok: true,
        result: {}
      } as const;
    }
    if (payload.method === "settings.update") {
      return {
        id: payload.id,
        method: "settings.update",
        ok: true,
        result: payload.params
      } as const;
    }
    if (payload.method === "session.list") {
      return {
        id: payload.id,
        method: "session.list",
        ok: true,
        result: {
          sessions: []
        }
      } as const;
    }
    if (payload.method === "domain.snapshot") {
      return {
        id: payload.id,
        method: "domain.snapshot",
        ok: true,
        result: {
          snapshot: {
            conversations: [],
            sessions: [],
            turns: [],
            messageBlocks: [],
            toolCalls: [],
            terminalStreams: [],
            approvalRequests: [],
            participants: [],
            sessionRelations: []
          },
          cursor: "cursor-0"
        }
      } as const;
    }
    if (payload.method === "events.replay") {
      return {
        id: payload.id,
        method: "events.replay",
        ok: true,
        result: {
          replayed: 0,
          fromCursor: payload.params.fromCursor,
          toCursor: payload.params.toCursor,
          envelopes: []
        }
      } as const;
    }
    return {
      id: payload.id,
      method: "runtime.command",
      ok: true,
      result: {
        commandId: payload.params.envelope.commandId,
        commandType: payload.params.envelope.command.type,
        accepted: true
      }
    } as const;
  });

  const subscribe = vi.fn(async (params, handler) => {
    subscribedHandler = handler;
    return {
      subscriptionId: params.subscriptionId ?? "sub-1",
      unsubscribe
    };
  });

  return {
    api: {
      request,
      subscribe
    } satisfies WorkbenchClientApi,
    request,
    subscribe,
    emitPush: (push: WorkbenchEventPush) => {
      subscribedHandler?.(push);
    }
  };
};

describe("Desktop transport facade", () => {
  it("keeps session.list as typed read contract with default includeArchived", () => {
    const parsedRequest = safeParseWorkbenchRpcRequest({
      id: "req-session-list",
      method: "session.list",
      params: {}
    });

    expect(parsedRequest.success).toBe(true);
    if (!parsedRequest.success) {
      return;
    }
    expect(parsedRequest.data.params.includeArchived).toBe(false);

    const parsedResponse = safeParseWorkbenchRpcResponse({
      id: "req-session-list",
      method: "session.list",
      ok: true,
      result: {
        sessions: []
      }
    });

    expect(parsedResponse.success).toBe(true);
    if (!parsedResponse.success || !parsedResponse.data.ok) {
      return;
    }
    expect(parsedResponse.data.method).toBe("session.list");
    expect(Array.isArray(parsedResponse.data.result.sessions)).toBe(true);
  });

  it("maps high-level session.create to runtime.command", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api, {
      createId: () => "fixed-id",
      now: () => "2026-04-17T00:00:00.000Z"
    });

    const receipt = await transport.session.create({
      agentId: "agent-1",
      conversationId: "conversation-1"
    });

    expect(receipt.commandType).toBe("createSession");
    const request = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(request.method).toBe("runtime.command");
    if (request.method !== "runtime.command") {
      throw new Error("Expected runtime.command request.");
    }
    expect(request.params.envelope.command.type).toBe("createSession");
    expect(request.params.envelope.command.agentId).toBe("agent-1");
  });

  it("maps session.list to dedicated session.list read path", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "session.list") {
          return {
            id: request.id,
            method: "session.list",
            ok: true,
            result: {
              sessions: [
                {
                  sessionId: "session-1",
                  conversationId: "conversation-1",
                  agentId: "agent-1",
                  status: "idle",
                  createdAt: "2026-04-17T00:00:00.000Z",
                  updatedAt: "2026-04-17T00:00:00.000Z"
                }
              ]
            }
          } as const;
        }
        throw new Error(`Unexpected method: ${request.method}`);
      }
    });
    const transport = createDesktopTransport(preload.api);

    const sessions = await transport.session.list({
      conversationId: "conversation-1"
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("session-1");

    const request = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(request.method).toBe("session.list");
    if (request.method !== "session.list") {
      throw new Error("Expected session.list request.");
    }
    expect(request.params.conversationId).toBe("conversation-1");
    expect(request.params.includeArchived).toBe(false);
  });

  it("maps shell settings through typed get/update RPC contracts", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);

    await expect(transport.settings.get()).resolves.toEqual({});
    await expect(
      transport.settings.update({
        defaultNewSessionAgentId: "codex"
      })
    ).resolves.toEqual({
      defaultNewSessionAgentId: "codex"
    });

    const getRequest = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    const updateRequest = preload.request.mock.calls[1][0] as WorkbenchRpcRequest;
    expect(getRequest.method).toBe("settings.get");
    expect(updateRequest.method).toBe("settings.update");
  });

  it("throws DesktopTransportError when low-level request fails", async () => {
    const preload = createPreloadMock({
      onRequest: async (request) => {
        if (request.method === "runtime.command") {
          return {
            id: request.id,
            method: request.method,
            ok: false,
            error: {
              code: "PERMISSION_DENIED",
              message: "not allowed"
            }
          } as const;
        }
        return {
          id: request.id,
          method: "agent.list",
          ok: true,
          result: {
            agents: []
          }
        } as const;
      }
    });
    const transport = createDesktopTransport(preload.api);

    await expect(
      transport.chat.interrupt({
        sessionId: "session-1",
        turnId: "turn-1"
      })
    ).rejects.toBeInstanceOf(DesktopTransportError);
  });

  it("bridges event envelopes into renderer store ingestion", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);
    const store = createRendererStore();

    await connectDesktopTransportToStore({
      transport,
      store,
      fromCursor: "cursor-10"
    });

    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].fromCursor).toBe("cursor-10");

    preload.emitPush({
      channel: "workbench.events",
      subscriptionId: "sub-1",
      envelope: {
        eventId: "evt-1",
        cursor: "cursor-11",
        occurredAt: "2026-04-17T00:00:01.000Z",
        event: {
          type: "turn.started",
          sessionId: "session-1",
          turnId: "turn-1"
        }
      }
    });

    const nextState = store.getState();
    expect(nextState.eventStream.lastEventId).toBe("evt-1");
    expect(nextState.eventStream.lastCursor).toBe("cursor-11");
    expect(nextState.entities.turns["turn-1"]?.sessionId).toBe("session-1");
  });

  it("subscribes without a conversation filter by default so renderer state stays globally mirrored", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);
    const store = createRendererStore();

    await connectDesktopTransportToStore({
      transport,
      store
    });

    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].filter).toBeUndefined();
  });

  it("still forwards an explicit event filter for specialized consumers", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);
    const store = createRendererStore();

    await connectDesktopTransportToStore({
      transport,
      store,
      filter: {
        conversationId: "conversation-2"
      }
    });

    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].filter).toEqual({
      conversationId: "conversation-2"
    });
  });

  it("uses typed events.replay wrapper instead of raw request()", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);

    const replay = await transport.events.replay({
      fromCursor: "cursor-20",
      toCursor: "cursor-30"
    });

    expect(replay.fromCursor).toBe("cursor-20");
    expect(replay.envelopes).toEqual([]);
    const request = preload.request.mock.calls[0][0] as WorkbenchRpcRequest;
    expect(request.method).toBe("events.replay");
  });

  it("skips snapshot hydration when store already has domain state and reuses lastCursor for subscription", async () => {
    const preload = createPreloadMock();
    const transport = createDesktopTransport(preload.api);
    const store = createRendererStore();
    store.ingestEnvelope({
      eventId: "evt-10",
      cursor: "cursor-10",
      occurredAt: "2026-04-17T00:00:00.000Z",
      event: {
        type: "session.created",
        conversationId: "conversation-1",
        sessionId: "session-1",
        agentId: "agent-1",
        status: "idle"
      }
    });

    await connectDesktopTransportToStore({
      transport,
      store
    });

    expect(preload.request).not.toHaveBeenCalled();
    expect(preload.subscribe).toHaveBeenCalledTimes(1);
    expect(preload.subscribe.mock.calls[0][0].fromCursor).toBe("cursor-10");

    preload.emitPush({
      channel: "workbench.events",
      subscriptionId: "sub-1",
      envelope: {
        eventId: "evt-live-1",
        cursor: "cursor-12",
        occurredAt: "2026-04-17T00:00:02.000Z",
        event: {
          type: "turn.completed",
          sessionId: "session-1",
          turnId: "turn-replay-1",
          finishReason: "completed"
        }
      }
    });

    const finalState = store.getState();
    expect(finalState.entities.turns["turn-replay-1"]?.status).toBe("completed");
    expect(finalState.eventStream.lastCursor).toBe("cursor-12");
  });
});
