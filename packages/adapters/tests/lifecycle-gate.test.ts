import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleGate } from "../src/lifecycle-gate.js";

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

const flushMicrotasks = () => Promise.resolve();

describe("LifecycleGate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one start operation across concurrent callers", async () => {
    const gate = new LifecycleGate();
    const deferred = createDeferred();
    const start = vi.fn(() => deferred.promise);

    const starts = Array.from({ length: 10 }, () => gate.start(start));
    await flushMicrotasks();

    expect(start).toHaveBeenCalledTimes(1);
    expect(gate.getPendingState()).toEqual({
      starting: true,
      stopping: false
    });

    deferred.resolve();
    await Promise.all(starts);

    expect(gate.getPendingState()).toEqual({
      starting: false,
      stopping: false
    });
  });

  it("clears failed starts so a later start can retry", async () => {
    const gate = new LifecycleGate();
    const startError = new Error("spawn failed");
    const start = vi
      .fn<[], Promise<void>>()
      .mockRejectedValueOnce(startError)
      .mockResolvedValueOnce(undefined);

    await expect(gate.start(start)).rejects.toBe(startError);
    expect(gate.getPendingState().starting).toBe(false);

    await gate.start(start);

    expect(start).toHaveBeenCalledTimes(2);
    expect(gate.getPendingState()).toEqual({
      starting: false,
      stopping: false
    });
  });

  it("waits for an in-flight start before stopping and shares repeated stops", async () => {
    const gate = new LifecycleGate();
    const startDeferred = createDeferred();
    const start = vi.fn(() => startDeferred.promise);
    const stop = vi.fn().mockResolvedValue(undefined);

    const startPromise = gate.start(start);
    await flushMicrotasks();

    const stopA = gate.stop(stop);
    const stopB = gate.stop(stop);
    await flushMicrotasks();

    expect(stop).not.toHaveBeenCalled();

    startDeferred.resolve();
    await Promise.all([startPromise, stopA, stopB]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(gate.getPendingState()).toEqual({
      starting: false,
      stopping: false
    });
  });

  it("still runs stop cleanup after start rejects", async () => {
    const gate = new LifecycleGate();
    const startError = new Error("initialize failed");
    const start = vi.fn().mockRejectedValue(startError);
    const stop = vi.fn().mockResolvedValue(undefined);

    const startPromise = gate.start(start);
    const stopPromise = gate.stop(stop);

    await expect(startPromise).rejects.toBe(startError);
    await stopPromise;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(gate.getPendingState()).toEqual({
      starting: false,
      stopping: false
    });
  });

  it("waits for stop before starting with fake timers", async () => {
    vi.useFakeTimers();
    const gate = new LifecycleGate();
    const stop = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 25))
    );
    const start = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 50))
    );

    const stopPromise = gate.stop(stop);
    await flushMicrotasks();
    const startPromise = gate.start(start);
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    await stopPromise;
    await flushMicrotasks();

    expect(start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    await startPromise;

    expect(gate.getPendingState()).toEqual({
      starting: false,
      stopping: false
    });
  });
});
