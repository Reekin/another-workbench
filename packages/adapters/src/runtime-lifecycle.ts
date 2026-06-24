export type RuntimeLifecycleState =
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "failed";

export type RuntimePortErrorCode =
  | "runtime_not_started"
  | "runtime_start_failed"
  | "runtime_stop_failed"
  | "runtime_request_timeout"
  | "runtime_request_aborted"
  | "runtime_process_exited"
  | "runtime_write_failed"
  | "runtime_protocol_error";

export type RuntimePortErrorInput = {
  code: RuntimePortErrorCode;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export type RuntimeOperationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RuntimeStartOptions = Pick<RuntimeOperationOptions, "signal">;

export type RuntimeStopOptions = {
  reason?: string;
  timeoutMs?: number;
};

export type RuntimeStateListener = (state: RuntimeLifecycleState) => void;

const allowedRuntimeLifecycleTransitions: Record<
  RuntimeLifecycleState,
  readonly RuntimeLifecycleState[]
> = {
  stopped: ["starting", "stopping"],
  starting: ["ready", "stopping", "failed"],
  ready: ["stopping", "failed"],
  stopping: ["stopped", "failed"],
  failed: ["starting", "stopping", "stopped"]
};

export class RuntimePortError extends Error {
  public readonly code: RuntimePortErrorCode;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown> | undefined;
  public override readonly cause: unknown;

  public constructor(input: RuntimePortErrorInput) {
    super(input.message);
    this.name = "RuntimePortError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
    this.cause = input.cause;
  }
}

export const isRuntimePortError = (error: unknown): error is RuntimePortError =>
  error instanceof RuntimePortError;

export const canTransitionRuntimeLifecycleState = (
  from: RuntimeLifecycleState,
  to: RuntimeLifecycleState
): boolean =>
  from === to || allowedRuntimeLifecycleTransitions[from].includes(to);

export const assertRuntimeLifecycleTransition = (
  from: RuntimeLifecycleState,
  to: RuntimeLifecycleState
): void => {
  if (canTransitionRuntimeLifecycleState(from, to)) {
    return;
  }

  throw new RuntimePortError({
    code: "runtime_protocol_error",
    message: `Illegal runtime lifecycle transition: ${from} -> ${to}.`,
    retryable: false,
    details: {
      from,
      to
    }
  });
};

export type RuntimeLifecycleController = {
  getState(): RuntimeLifecycleState;
  setState(state: RuntimeLifecycleState): void;
  subscribe(listener: RuntimeStateListener): () => void;
};

export const createRuntimeLifecycleController = (
  initialState: RuntimeLifecycleState = "stopped"
): RuntimeLifecycleController => {
  let state = initialState;
  const listeners = new Set<RuntimeStateListener>();

  return {
    getState: () => state,
    setState: (nextState) => {
      if (state === nextState) {
        return;
      }
      assertRuntimeLifecycleTransition(state, nextState);
      state = nextState;
      for (const listener of listeners) {
        listener(state);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
};
