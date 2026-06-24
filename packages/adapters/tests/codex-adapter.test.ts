import type { AdapterRuntimePort } from "../src/runtime-port.js";
import type {
  RuntimeLifecycleState,
  RuntimeStateListener
} from "../src/runtime-lifecycle.js";
import type {
  CodexRuntimeEvent,
  CodexRuntimeRequest,
  CodexRuntimeResponse
} from "../src/codex/types.js";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/codex/adapter.js";

const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    resolve,
    reject
  };
};

class FakeCodexRuntimePort
  implements
    AdapterRuntimePort<CodexRuntimeRequest, CodexRuntimeResponse, CodexRuntimeEvent>
{
  public started = false;
  public stopped = false;
  public startCalls = 0;
  public subscribeCalls = 0;
  public startBarrier: Promise<void> | undefined;
  public readonly requests: CodexRuntimeRequest[] = [];
  private lifecycleState: RuntimeLifecycleState = "stopped";
  private listener: ((event: CodexRuntimeEvent) => void) | undefined;
  private stateListener: RuntimeStateListener | undefined;

  public getState(): RuntimeLifecycleState {
    return this.lifecycleState;
  }

  public async start(): Promise<void> {
    this.startCalls += 1;
    this.setState("starting");
    await this.startBarrier;
    this.started = true;
    this.setState("ready");
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.setState("stopped");
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
    this.subscribeCalls += 1;
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

  public emit(event: CodexRuntimeEvent): void {
    this.listener?.(event);
  }

  public fail(): void {
    this.setState("failed");
  }

  private setState(state: RuntimeLifecycleState): void {
    this.lifecycleState = state;
    this.stateListener?.(state);
  }
}

describe("CodexAdapter", () => {
  it("single-flights concurrent runtime initialization", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const startGate = createDeferred();
    runtimePort.startBarrier = startGate.promise;
    const adapter = new CodexAdapter({
      runtimePort,
      fallbackAgentId: "codex-agent"
    });

    const first = adapter.initialize();
    const second = adapter.initialize();
    await Promise.resolve();

    expect(runtimePort.startCalls).toBe(1);
    expect(runtimePort.subscribeCalls).toBe(0);

    startGate.resolve();
    await Promise.all([first, second]);

    expect(runtimePort.startCalls).toBe(1);
    expect(runtimePort.subscribeCalls).toBe(1);
    expect(adapter.getLifecycleState()).toBe("ready");
  });

  it("marks the adapter unavailable when the runtime fails and can reinitialize", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
      runtimePort,
      fallbackAgentId: "codex-agent"
    });

    await adapter.initialize();
    expect(adapter.getLifecycleState()).toBe("ready");

    runtimePort.fail();
    expect(adapter.getLifecycleState()).toBe("error");
    await expect(
      adapter.executeCommand({
        commandId: "cmd-after-failure",
        command: {
          type: "initialize"
        }
      })
    ).rejects.toThrow("is not ready");

    await adapter.initialize();
    expect(runtimePort.startCalls).toBe(2);
    expect(runtimePort.subscribeCalls).toBe(1);
    expect(adapter.getLifecycleState()).toBe("ready");
  });

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

  it("maps steerTurn commands to the dedicated codex steer method", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
      runtimePort,
      fallbackAgentId: "codex-agent"
    });

    await adapter.initialize();
    await adapter.executeCommand({
      commandId: "cmd-steer-1",
      command: {
        type: "steerTurn",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        content: "Stay on the current failing test.",
        attachments: []
      }
    });

    expect(runtimePort.requests).toHaveLength(1);
    expect(runtimePort.requests[0].method).toBe("turn/steer");
    expect(runtimePort.requests[0].params.type).toBe("steerTurn");
  });

  it("maps thread goal commands to codex goal runtime methods", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
      runtimePort,
      fallbackAgentId: "codex-agent"
    });

    await adapter.initialize();
    await adapter.executeCommand({
      commandId: "cmd-goal-set",
      command: {
        type: "setThreadGoal",
        sessionId: "session-1",
        objective: "Finish the protocol bridge",
        status: "active",
        tokenBudget: 12000
      }
    });
    await adapter.executeCommand({
      commandId: "cmd-goal-clear",
      command: {
        type: "clearThreadGoal",
        sessionId: "session-1"
      }
    });

    expect(runtimePort.requests).toHaveLength(2);
    expect(runtimePort.requests[0]).toMatchObject({
      method: "thread/goal/set",
      params: {
        type: "setThreadGoal",
        sessionId: "session-1",
        objective: "Finish the protocol bridge",
        status: "active",
        tokenBudget: 12000
      }
    });
    expect(runtimePort.requests[1]).toMatchObject({
      method: "thread/goal/clear",
      params: {
        type: "clearThreadGoal",
        sessionId: "session-1"
      }
    });
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
          (envelope.event.engineId ?? "none") + ":" + envelope.event.delta
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

  it("maps thread goal runtime events into shared envelopes", async () => {
    const runtimePort = new FakeCodexRuntimePort();
    const adapter = new CodexAdapter({
      runtimePort,
      fallbackAgentId: "codex-agent"
    });
    const received: string[] = [];

    await adapter.initialize();
    adapter.subscribe((envelope) => {
      if (
        envelope.event.type === "thread.goal.updated" ||
        envelope.event.type === "thread.goal.cleared"
      ) {
        received.push(envelope.event.type);
      }
    });

    runtimePort.emit({
      method: "thread.goal.updated",
      params: {
        sessionId: "session-a",
        threadId: "thread-a",
        goal: {
          sessionId: "session-a",
          threadId: "thread-a",
          objective: "Ship the goal UI",
          status: "active",
          tokensUsed: 10,
          timeUsedSeconds: 2,
          createdAt: 1700000000000,
          updatedAt: 1700000001000
        }
      },
      eventId: "evt-goal-updated",
      cursor: "4"
    });
    runtimePort.emit({
      method: "thread.goal.cleared",
      params: {
        sessionId: "session-a",
        threadId: "thread-a"
      },
      eventId: "evt-goal-cleared",
      cursor: "5"
    });

    expect(received).toEqual(["thread.goal.updated", "thread.goal.cleared"]);
  });
});
