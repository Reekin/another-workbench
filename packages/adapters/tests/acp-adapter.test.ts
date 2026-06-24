import type { AdapterRuntimePort } from "../src/runtime-port.js";
import type {
  RuntimeLifecycleState,
  RuntimeStateListener
} from "../src/runtime-lifecycle.js";
import type {
  AcpRuntimeEvent,
  AcpRuntimeRequest,
  AcpRuntimeResponse
} from "../src/acp/types.js";
import { describe, expect, it } from "vitest";
import { AcpAdapter } from "../src/acp/adapter.js";

class FakeAcpRuntimePort
  implements
    AdapterRuntimePort<AcpRuntimeRequest, AcpRuntimeResponse, AcpRuntimeEvent>
{
  public readonly requests: AcpRuntimeRequest[] = [];
  private lifecycleState: RuntimeLifecycleState = "stopped";
  private listener: ((event: AcpRuntimeEvent) => void) | undefined;
  private stateListener: RuntimeStateListener | undefined;

  public getState(): RuntimeLifecycleState {
    return this.lifecycleState;
  }

  public async start(): Promise<void> {
    this.setState("ready");
  }

  public async stop(): Promise<void> {
    this.setState("stopped");
  }

  public async request(payload: AcpRuntimeRequest): Promise<AcpRuntimeResponse> {
    this.requests.push(payload);
    return {
      id: payload.id,
      ok: true,
      result: {
        accepted: true
      }
    };
  }

  public subscribe(listener: (event: AcpRuntimeEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public subscribeState(listener: RuntimeStateListener): () => void {
    this.stateListener = listener;
    return () => {
      this.stateListener = undefined;
    };
  }

  public emit(event: AcpRuntimeEvent): void {
    this.listener?.(event);
  }

  private setState(state: RuntimeLifecycleState): void {
    this.lifecycleState = state;
    this.stateListener?.(state);
  }
}

describe("AcpAdapter", () => {
  it("maps commands to acp runtime methods", async () => {
    const runtimePort = new FakeAcpRuntimePort();
    const adapter = new AcpAdapter({
      runtimePort
    });

    await adapter.initialize();
    await adapter.executeCommand({
      commandId: "cmd-acp-1",
      command: {
        type: "createSession",
        engineId: "agent-1"
      }
    });

    expect(runtimePort.requests).toHaveLength(1);
    expect(runtimePort.requests[0].method).toBe("session.create");
    expect(runtimePort.requests[0].params.type).toBe("createSession");
  });

  it("maps steerTurn commands to the ACP steer method", async () => {
    const runtimePort = new FakeAcpRuntimePort();
    const adapter = new AcpAdapter({
      runtimePort
    });

    await adapter.initialize();
    await adapter.executeCommand({
      commandId: "cmd-acp-steer-1",
      command: {
        type: "steerTurn",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "Keep the current plan but tighten the summary.",
        attachments: []
      }
    });

    expect(runtimePort.requests).toHaveLength(1);
    expect(runtimePort.requests[0].method).toBe("turn.steer");
    expect(runtimePort.requests[0].params.type).toBe("steerTurn");
  });

  it("maps acp runtime events into shared event envelopes", async () => {
    const runtimePort = new FakeAcpRuntimePort();
    const adapter = new AcpAdapter({
      runtimePort,
      fallbackAgentId: "acp-agent"
    });
    const received: string[] = [];

    await adapter.initialize();
    adapter.subscribe((envelope) => {
      if (envelope.event.type === "tool.started") {
        received.push(envelope.event.engineId ?? "none");
      }
    });

    runtimePort.emit({
      event: "tool.started",
      payload: {
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        toolName: "read_file",
        inputSummary: "x"
      },
      eventId: "evt-acp-1"
    });

    expect(received).toEqual(["acp-agent"]);
  });

  it("supports adapter-side event filtering", async () => {
    const runtimePort = new FakeAcpRuntimePort();
    const adapter = new AcpAdapter({
      runtimePort,
      fallbackAgentId: "acp-agent"
    });
    const received: string[] = [];

    await adapter.initialize();
    adapter.subscribe(
      (envelope) => {
        received.push(envelope.event.type);
      },
      {
        sessionId: "session-a",
        eventTypes: ["turn.started"]
      }
    );

    runtimePort.emit({
      event: "turn.started",
      payload: {
        sessionId: "session-a",
        turnId: "turn-a"
      }
    });
    runtimePort.emit({
      event: "turn.completed",
      payload: {
        sessionId: "session-a",
        turnId: "turn-a",
        finishReason: "completed"
      }
    });
    runtimePort.emit({
      event: "turn.started",
      payload: {
        sessionId: "session-b",
        turnId: "turn-b"
      }
    });

    expect(received).toEqual(["turn.started"]);
  });

  it("supports conversation filtering for session-scoped events", async () => {
    const runtimePort = new FakeAcpRuntimePort();
    const adapter = new AcpAdapter({
      runtimePort,
      resolveConversationIdBySessionId: (sessionId) =>
        sessionId === "session-a" ? "conversation-a" : "conversation-b"
    });
    const received: string[] = [];

    await adapter.initialize();
    adapter.subscribe(
      (envelope) => {
        received.push(envelope.event.type);
      },
      {
        conversationId: "conversation-a"
      }
    );

    runtimePort.emit({
      event: "turn.started",
      payload: {
        sessionId: "session-a",
        turnId: "turn-a"
      },
      eventId: "evt-a"
    });
    runtimePort.emit({
      event: "turn.started",
      payload: {
        sessionId: "session-b",
        turnId: "turn-b"
      },
      eventId: "evt-b"
    });

    expect(received).toEqual(["turn.started"]);
  });

  it("maps session.disposed runtime events into shared envelopes", async () => {
    const runtimePort = new FakeAcpRuntimePort();
    const adapter = new AcpAdapter({
      runtimePort,
      fallbackAgentId: "acp-agent"
    });
    const received: string[] = [];

    await adapter.initialize();
    adapter.subscribe((envelope) => {
      if (envelope.event.type === "session.disposed") {
        received.push(envelope.event.sessionId);
      }
    });

    runtimePort.emit({
      event: "session.disposed",
      payload: {
        conversationId: "conversation-a",
        sessionId: "session-a",
        disposedAt: "2026-04-17T00:00:00.000Z"
      },
      eventId: "evt-session-disposed"
    });

    expect(received).toEqual(["session-a"]);
  });
});
