import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";
import { RuntimeProcessError } from "./runtime-process-error.js";

export type SupervisedProcess = {
  generation: number;
  process: ChildProcessWithoutNullStreams;
};

export type SupervisedProcessExit = {
  generation: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  error?: Error;
};

export type SupervisedProcessStderr = {
  generation: number;
  text: string;
};

export type ChildProcessSupervisorHealth = {
  generation: number;
  pid?: number;
  state: "stopped" | "running" | "stopping";
};

export type ChildProcessSupervisorStartOptions = {
  command: string;
  args?: string[];
  options?: SpawnOptionsWithoutStdio;
};

export type ChildProcessSupervisorStopOptions = {
  reason?: string;
  timeoutMs?: number;
};

export type ChildProcessSupervisorOptions = {
  killTimeoutMs?: number;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams;
};

type ProcessRecord = SupervisedProcess & {
  stopping: boolean;
};

type Listener<T> = (event: T) => void;

export class ChildProcessSupervisor {
  private readonly killTimeoutMs: number;
  private readonly spawnProcess: NonNullable<
    ChildProcessSupervisorOptions["spawnProcess"]
  >;
  private readonly exitListeners = new Set<Listener<SupervisedProcessExit>>();
  private readonly stderrListeners = new Set<Listener<SupervisedProcessStderr>>();
  private current: ProcessRecord | undefined;
  private nextGeneration = 0;

  public constructor(options: ChildProcessSupervisorOptions = {}) {
    this.killTimeoutMs = options.killTimeoutMs ?? 1000;
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) =>
        spawn(command, args, {
          ...spawnOptions,
          stdio: ["pipe", "pipe", "pipe"]
        }));
  }

  public getCurrentProcess(): SupervisedProcess | undefined {
    if (!this.current) {
      return undefined;
    }
    return {
      generation: this.current.generation,
      process: this.current.process
    };
  }

  public getHealth(): ChildProcessSupervisorHealth {
    if (!this.current) {
      return {
        generation: this.nextGeneration,
        state: "stopped"
      };
    }
    return {
      generation: this.current.generation,
      pid: this.current.process.pid,
      state: this.current.stopping ? "stopping" : "running"
    };
  }

  public onExit(listener: Listener<SupervisedProcessExit>): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  public onStderr(listener: Listener<SupervisedProcessStderr>): () => void {
    this.stderrListeners.add(listener);
    return () => {
      this.stderrListeners.delete(listener);
    };
  }

  public async start(
    input: ChildProcessSupervisorStartOptions
  ): Promise<SupervisedProcess> {
    if (this.current) {
      throw new RuntimeProcessError({
        code: "process_already_started",
        message: "Runtime process is already started.",
        generation: this.current.generation
      });
    }

    const generation = this.nextGeneration + 1;
    this.nextGeneration = generation;
    const child = this.spawnProcess(input.command, input.args ?? [], {
      ...(input.options ?? {}),
      stdio: ["pipe", "pipe", "pipe"]
    });

    const record: ProcessRecord = {
      generation,
      process: child,
      stopping: false
    };
    this.attachProcessListeners(record);

    await this.waitForSpawn(record, input.command);
    return {
      generation,
      process: child
    };
  }

  public async stop(
    options: ChildProcessSupervisorStopOptions = {}
  ): Promise<void> {
    const record = this.current;
    if (!record) {
      return;
    }

    record.stopping = true;
    const timeoutMs = options.timeoutMs ?? this.killTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      let failureTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (escalationTimer) {
          clearTimeout(escalationTimer);
        }
        if (failureTimer) {
          clearTimeout(failureTimer);
        }
        record.process.off("exit", onExit);
        record.process.off("error", onError);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const onExit = () => settle();
      const onError = (error: Error) =>
        settle(
          new RuntimeProcessError({
            code: "process_stop_failed",
            message: "Runtime process emitted an error while stopping.",
            generation: record.generation,
            cause: error
          })
        );
      const scheduleFailure = () => {
        failureTimer = setTimeout(() => {
          settle(
            new RuntimeProcessError({
              code: "process_stop_failed",
              message: "Runtime process did not exit after forced termination.",
              generation: record.generation,
              details: {
                reason: options.reason
              }
            })
          );
        }, timeoutMs);
      };
      const escalateKill = () => {
        record.process.kill("SIGKILL");
        scheduleFailure();
      };
      escalationTimer = setTimeout(escalateKill, timeoutMs);

      record.process.once("exit", onExit);
      record.process.once("error", onError);
      const killed = record.process.kill("SIGTERM");
      if (!killed) {
        if (escalationTimer) {
          clearTimeout(escalationTimer);
          escalationTimer = undefined;
        }
        escalateKill();
      }
    });
  }

  private waitForSpawn(
    record: ProcessRecord,
    command: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        record.process.off("spawn", onSpawn);
        record.process.off("error", onError);
        record.process.off("exit", onExit);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const onSpawn = () => {
        this.current = record;
        settle();
      };
      const onError = (error: Error) =>
        settle(
          new RuntimeProcessError({
            code: "process_spawn_failed",
            message: `Failed to spawn runtime process: ${command}`,
            generation: record.generation,
            cause: error
          })
        );
      const onExit = (
        code: number | null,
        signal: NodeJS.Signals | null
      ) =>
        settle(
          new RuntimeProcessError({
            code: "process_exited_before_spawn",
            message: "Runtime process exited before spawn completed.",
            generation: record.generation,
            details: {
              code,
              signal
            }
          })
        );

      record.process.once("spawn", onSpawn);
      record.process.once("error", onError);
      record.process.once("exit", onExit);
    });
  }

  private attachProcessListeners(record: ProcessRecord): void {
    record.process.stderr.on("data", (chunk: Buffer | string) => {
      if (this.current?.generation !== record.generation) {
        return;
      }
      this.emitStderr({
        generation: record.generation,
        text: typeof chunk === "string" ? chunk : String(chunk)
      });
    });

    record.process.once("exit", (code, signal) => {
      if (this.current?.generation !== record.generation) {
        return;
      }
      this.current = undefined;
      this.emitExit({
        generation: record.generation,
        code,
        signal,
        expected: record.stopping
      });
    });
    record.process.once("error", (error) => {
      if (this.current?.generation !== record.generation) {
        return;
      }
      this.current = undefined;
      this.emitExit({
        generation: record.generation,
        code: null,
        signal: null,
        expected: record.stopping,
        error
      });
    });
  }

  private emitExit(event: SupervisedProcessExit): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }

  private emitStderr(event: SupervisedProcessStderr): void {
    for (const listener of this.stderrListeners) {
      listener(event);
    }
  }
}
