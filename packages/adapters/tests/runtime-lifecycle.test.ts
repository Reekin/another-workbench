import { describe, expect, it } from "vitest";
import type { AdapterRuntimePort } from "../src/runtime-port.js";
import type { AgentAdapterRuntimeConfig } from "../src/types.js";
import {
  RuntimePortError,
  assertRuntimeLifecycleTransition,
  canTransitionRuntimeLifecycleState,
  createRuntimeLifecycleController,
  isRuntimePortError,
  type RuntimeLifecycleController,
  type RuntimeLifecycleState,
  type RuntimeOperationOptions,
  type RuntimeStartOptions,
  type RuntimeStateListener
} from "../src/runtime-lifecycle.js";

type TestRuntimeRequest = {
  id: string;
};

type TestRuntimeResponse = {
  id: string;
  ok: true;
};

type TestRuntimeEvent = {
  event: "test.event";
};

class ContractRuntimePort
  implements
    AdapterRuntimePort<TestRuntimeRequest, TestRuntimeResponse, TestRuntimeEvent>
{
  public readonly requestOptions: RuntimeOperationOptions[] = [];
  public readonly startSignals: Array<AbortSignal | undefined> = [];
  private readonly lifecycle: RuntimeLifecycleController =
    createRuntimeLifecycleController();
  private readonly eventListeners = new Set<(event: TestRuntimeEvent) => void>();

  public getState(): RuntimeLifecycleState {
    return this.lifecycle.getState();
  }

  public async start(
    _config: AgentAdapterRuntimeConfig = {},
    options: RuntimeStartOptions = {}
  ): Promise<void> {
    this.startSignals.push(options.signal);
    this.lifecycle.setState("starting");
    this.lifecycle.setState("ready");
  }

  public async stop(): Promise<void> {
    this.lifecycle.setState("stopping");
    this.lifecycle.setState("stopped");
  }

  public async request(
    payload: TestRuntimeRequest,
    options: RuntimeOperationOptions = {}
  ): Promise<TestRuntimeResponse> {
    this.requestOptions.push(options);
    return {
      id: payload.id,
      ok: true
    };
  }

  public subscribe(listener: (event: TestRuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  public subscribeState(listener: RuntimeStateListener): () => void {
    return this.lifecycle.subscribe(listener);
  }

  public emit(event: TestRuntimeEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

describe("runtime lifecycle contract", () => {
  it("carries typed runtime errors across adapter and host boundaries", () => {
    const cause = new Error("write failed");
    const error = new RuntimePortError({
      code: "runtime_write_failed",
      message: "Unable to write runtime request.",
      retryable: true,
      details: {
        requestId: "rpc-1"
      },
      cause
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RuntimePortError");
    expect(error.code).toBe("runtime_write_failed");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({
      requestId: "rpc-1"
    });
    expect(error.cause).toBe(cause);
    expect(isRuntimePortError(error)).toBe(true);
    expect(isRuntimePortError(new Error("x"))).toBe(false);
  });

  it("exposes state, state subscription, and operation options on ports", async () => {
    const port = new ContractRuntimePort();
    const controller = new AbortController();
    const states: RuntimeLifecycleState[] = [];
    const events: TestRuntimeEvent[] = [];

    port.subscribeState((state) => states.push(state));
    port.subscribe((event) => events.push(event));

    await port.start({ cwd: "I:/workspace" }, { signal: controller.signal });
    const response = await port.request(
      {
        id: "request-1"
      },
      {
        signal: controller.signal,
        timeoutMs: 250
      }
    );
    port.emit({ event: "test.event" });
    await port.stop({ reason: "test" });

    expect(port.getState()).toBe("stopped");
    expect(states).toEqual(["starting", "ready", "stopping", "stopped"]);
    expect(port.startSignals).toEqual([controller.signal]);
    expect(port.requestOptions).toEqual([
      {
        signal: controller.signal,
        timeoutMs: 250
      }
    ]);
    expect(response).toEqual({
      id: "request-1",
      ok: true
    });
    expect(events).toEqual([{ event: "test.event" }]);
  });

  it("defines legal lifecycle transitions and rejects illegal ones", () => {
    expect(canTransitionRuntimeLifecycleState("stopped", "starting")).toBe(true);
    expect(canTransitionRuntimeLifecycleState("starting", "ready")).toBe(true);
    expect(canTransitionRuntimeLifecycleState("ready", "failed")).toBe(true);
    expect(canTransitionRuntimeLifecycleState("failed", "starting")).toBe(true);
    expect(canTransitionRuntimeLifecycleState("stopped", "ready")).toBe(false);
    expect(canTransitionRuntimeLifecycleState("ready", "starting")).toBe(false);

    expect(() =>
      assertRuntimeLifecycleTransition("stopped", "ready")
    ).toThrow(RuntimePortError);
  });
});
