export type RuntimeProcessErrorCode =
  | "process_already_started"
  | "process_spawn_failed"
  | "process_exited_before_spawn"
  | "process_stop_failed";

export type RuntimeProcessErrorInput = {
  code: RuntimeProcessErrorCode;
  message: string;
  generation?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export class RuntimeProcessError extends Error {
  public readonly code: RuntimeProcessErrorCode;
  public readonly generation: number | undefined;
  public readonly details: Record<string, unknown> | undefined;
  public override readonly cause: unknown;

  public constructor(input: RuntimeProcessErrorInput) {
    super(input.message);
    this.name = "RuntimeProcessError";
    this.code = input.code;
    this.generation = input.generation;
    this.details = input.details;
    this.cause = input.cause;
  }
}

export const isRuntimeProcessError = (
  error: unknown
): error is RuntimeProcessError => error instanceof RuntimeProcessError;
