import type { AdapterRuntimePort } from "../src/runtime-port.js";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "../src/codex/types.js";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/codex/adapter.js";

class FakeCodexRuntimePort
  implements
    AdapterRuntimePort<CodexRuntimeRequest, CodexRuntimeResponse, CodexRuntimeEvent>
{
  public started = false;
  public stopped = false;
  public readonly requests: CodexRuntimeRequest[] = [];
  private listener: ((event: CodexRuntimeEvent) => void) | undefined;

  public async start(): Promise<void> {
    this.started = true;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
  }

  public async request(
    payload: CodexRuntimeRequest
  ): Promise<CodexRuntimeResponse> {
    this.requests.push(payload);
    return {
      id: payload.id,
      ok: true,
      result: {
        accepted: true
      }
    };
  }

  public subscribe(listener: (event: CodexRuntimeEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public emit(event: CodexRuntimeEvent): void {
    this.listener?.(event);
  }
}

describe("CodexAdapter", () => {
  it("maps commands to codex runtime methods", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
      runtimePort,
      fallbackAgentId: "codex-agent"
    });

    await adapter.initialize();
    await adapter.executeCommand({
      commandId: "cmd-1",
      command: {
        type: "sendUserMessage",
        sessionId: "session-1",
        messageId: "message-1",
        content: "hello",
        attachments: []
      }
    });

    expect(runtimePort.requests).toHaveLength(1);
    expect(runtimePort.requests[0].method).toBe("turn/start");
    expect(runtimePort.requests[0].params.type).toBe("sendUserMessage");
  });

  it("maps runtime events to shared envelopes with actor fallback", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
      runtimePort,
      fallbackAgentId: "codex-agent"
    });
    const received: string[] = [];

    await adapter.initialize();
    adapter.subscribe((envelope) => {
      if (envelope.event.type === "message.delta") {
        received.push(
          (envelope.event.agentId ?? "none") + ":" + envelope.event.delta
        );
      }
    });

    runtimePort.emit({
      method: "message.delta",
      params: {
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "a"
      },
      eventId: "evt-1",
      cursor: "1"
    });

    expect(received).toEqual(["codex-agent:a"]);
  });

  it("requires initialize before command execution", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
      runtimePort
    });

    await expect(
      adapter.executeCommand({
        commandId: "cmd-2",
        command: {
          type: "initialize"
        }
      })
    ).rejects.toThrow("is not ready");
  });

  it("supports conversation filtering for session-scoped events", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
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
      method: "turn.started",
      params: {
        sessionId: "session-a",
        turnId: "turn-a"
      },
      eventId: "evt-turn-a",
      cursor: "1"
    });
    runtimePort.emit({
      method: "turn.started",
      params: {
        sessionId: "session-b",
        turnId: "turn-b"
      },
      eventId: "evt-turn-b",
      cursor: "2"
    });

    expect(received).toEqual(["turn.started"]);
  });

  it("maps session.disposed runtime events into shared envelopes", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
      runtimePort,
      fallbackAgentId: "codex-agent"
    });
    const received: string[] = [];

    await adapter.initialize();
    adapter.subscribe((envelope) => {
      if (envelope.event.type === "session.disposed") {
        received.push(envelope.event.sessionId);
      }
    });

    runtimePort.emit({
      method: "session.disposed",
      params: {
        conversationId: "conversation-a",
        sessionId: "session-a",
        disposedAt: "2026-04-17T00:00:00.000Z"
      },
      eventId: "evt-session-disposed",
      cursor: "3"
    });

    expect(received).toEqual(["session-a"]);
  });
});
