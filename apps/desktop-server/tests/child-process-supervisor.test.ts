import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildProcessSupervisor,
  type SupervisedProcessExit,
  type SupervisedProcessStderr
} from "../src/runtime/child-process-supervisor.js";
import {
  RuntimeProcessError,
  isRuntimeProcessError
} from "../src/runtime/runtime-process-error.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/runtime-process-fixture.mjs", import.meta.url)
);

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killCalls: Array<NodeJS.Signals | undefined> = [];
  public killReturn = true;

  public kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return this.killReturn;
  }

  public asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

const flushMicrotasks = () => Promise.resolve();

describe("ChildProcessSupervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not expose a process before spawn succeeds", async () => {
    const child = new FakeChildProcess();
    const supervisor = new ChildProcessSupervisor({
      spawnProcess: () => child.asChildProcess()
    });

    const start = supervisor.start({
      command: "fake",
      args: []
    });
    await flushMicrotasks();

    expect(supervisor.getCurrentProcess()).toBeUndefined();

    child.emit("spawn");
    const handle = await start;

    expect(handle.generation).toBe(1);
    expect(supervisor.getCurrentProcess()?.generation).toBe(1);
  });

  it("ignores stderr and exit from failed old generations", async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    const spawned = [first, second];
    const exits: SupervisedProcessExit[] = [];
    const stderr: SupervisedProcessStderr[] = [];
    const supervisor = new ChildProcessSupervisor({
      spawnProcess: () => {
        const child = spawned.shift();
        if (!child) {
          throw new Error("missing fake child");
        }
        return child.asChildProcess();
      }
    });
    supervisor.onExit((event) => exits.push(event));
    supervisor.onStderr((event) => stderr.push(event));

    const failedStart = supervisor.start({
      command: "fake",
      args: []
    });
    first.emit("error", new Error("spawn failed"));
    await expect(failedStart).rejects.toBeInstanceOf(RuntimeProcessError);

    first.stderr.write("old stderr");
    first.emit("exit", 1, null);

    const secondStart = supervisor.start({
      command: "fake",
      args: []
    });
    second.emit("spawn");
    await secondStart;
    second.stderr.write("new stderr");
    second.emit("exit", 0, null);

    expect(stderr).toEqual([
      {
        generation: 2,
        text: "new stderr"
      }
    ]);
    expect(exits).toEqual([
      {
        generation: 2,
        code: 0,
        signal: null,
        expected: false
      }
    ]);
  });

  it("escalates stop to SIGKILL and settles after exit", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const exits: SupervisedProcessExit[] = [];
    const supervisor = new ChildProcessSupervisor({
      killTimeoutMs: 10,
      spawnProcess: () => child.asChildProcess()
    });
    supervisor.onExit((event) => exits.push(event));

    const start = supervisor.start({
      command: "fake",
      args: []
    });
    child.emit("spawn");
    await start;

    expect(supervisor.getHealth()).toMatchObject({
      generation: 1,
      state: "running"
    });

    const stop = supervisor.stop({
      reason: "test"
    });
    await flushMicrotasks();

    expect(child.killCalls).toEqual(["SIGTERM"]);
    expect(supervisor.getHealth()).toMatchObject({
      generation: 1,
      state: "stopping"
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);

    child.emit("exit", null, "SIGKILL");
    await stop;

    expect(supervisor.getCurrentProcess()).toBeUndefined();
    expect(supervisor.getHealth()).toEqual({
      generation: 1,
      state: "stopped"
    });
    expect(exits).toEqual([
      {
        generation: 1,
        code: null,
        signal: "SIGKILL",
        expected: true
      }
    ]);
  });

  it("reports current-generation process errors after spawn", async () => {
    const child = new FakeChildProcess();
    const exits: SupervisedProcessExit[] = [];
    const supervisor = new ChildProcessSupervisor({
      spawnProcess: () => child.asChildProcess()
    });
    supervisor.onExit((event) => exits.push(event));

    const start = supervisor.start({
      command: "fake",
      args: []
    });
    child.emit("spawn");
    await start;

    const processError = new Error("runtime stream failed");
    child.emit("error", processError);

    expect(supervisor.getCurrentProcess()).toBeUndefined();
    expect(exits).toEqual([
      {
        generation: 1,
        code: null,
        signal: null,
        expected: false,
        error: processError
      }
    ]);
  });

  it("rejects stop instead of staying pending when forced kill does not exit", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const supervisor = new ChildProcessSupervisor({
      killTimeoutMs: 10,
      spawnProcess: () => child.asChildProcess()
    });

    const start = supervisor.start({
      command: "fake",
      args: []
    });
    child.emit("spawn");
    await start;

    const stop = supervisor.stop({
      reason: "test-timeout"
    });
    await flushMicrotasks();
    const rejectedStop = expect(stop).rejects.toMatchObject({
      code: "process_stop_failed",
      generation: 1
    });
    await vi.advanceTimersByTimeAsync(20);

    await rejectedStop;
  });

  it("rejects missing executables with a runtime process error", async () => {
    const supervisor = new ChildProcessSupervisor();

    try {
      await supervisor.start({
        command: "awb-definitely-missing-executable-for-supervisor-test",
        args: []
      });
      throw new Error("Expected start to reject.");
    } catch (error) {
      expect(isRuntimeProcessError(error)).toBe(true);
      expect(error).toMatchObject({
        code: "process_spawn_failed",
        generation: 1
      });
    }
  });

  it("captures stderr from a real child process", async () => {
    const stderr: string[] = [];
    const supervisor = new ChildProcessSupervisor();
    supervisor.onStderr((event) => stderr.push(event.text));
    const exited = new Promise<SupervisedProcessExit>((resolve) => {
      supervisor.onExit(resolve);
    });

    await supervisor.start({
      command: process.execPath,
      args: [fixturePath, "stderr"]
    });
    const exit = await exited;

    expect(exit).toMatchObject({
      generation: 1,
      code: 0,
      expected: false
    });
    expect(stderr.join("")).toContain("fixture stderr line");
  });

  it("observes normal real-process exit", async () => {
    const supervisor = new ChildProcessSupervisor();
    const exited = new Promise<SupervisedProcessExit>((resolve) => {
      supervisor.onExit(resolve);
    });

    await supervisor.start({
      command: process.execPath,
      args: [fixturePath, "exit", "7"]
    });
    const exit = await exited;

    expect(exit).toMatchObject({
      generation: 1,
      code: 7,
      expected: false
    });
    expect(supervisor.getCurrentProcess()).toBeUndefined();
  });

  it("stops a real long-running child process", async () => {
    const supervisor = new ChildProcessSupervisor({
      killTimeoutMs: 25
    });

    await supervisor.start({
      command: process.execPath,
      args: [fixturePath, "hold"]
    });

    await supervisor.stop({
      reason: "integration-test",
      timeoutMs: 25
    });

    expect(supervisor.getCurrentProcess()).toBeUndefined();
  });
});
