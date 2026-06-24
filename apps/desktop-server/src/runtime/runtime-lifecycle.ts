import { RuntimePortError } from "@another-workbench/adapters";
import type { RuntimePortErrorInput } from "@another-workbench/adapters";

export {
  RuntimePortError,
  assertRuntimeLifecycleTransition,
  canTransitionRuntimeLifecycleState,
  createRuntimeLifecycleController,
  isRuntimePortError,
  type RuntimeLifecycleController,
  type RuntimeLifecycleState,
  type RuntimeOperationOptions,
  type RuntimePortErrorCode,
  type RuntimePortErrorInput,
  type RuntimeStartOptions,
  type RuntimeStateListener,
  type RuntimeStopOptions
} from "@another-workbench/adapters";

export const createRuntimePortError = (
  input: RuntimePortErrorInput
): RuntimePortError => new RuntimePortError(input);

export const createRuntimeNotStartedError = (
  details?: Record<string, unknown>
): RuntimePortError =>
  createRuntimePortError({
    code: "runtime_not_started",
    message: "Runtime process is not ready.",
    retryable: true,
    details
  });

export const createRuntimeRequestTimeoutError = (
  timeoutMs: number,
  details?: Record<string, unknown>
): RuntimePortError =>
  createRuntimePortError({
    code: "runtime_request_timeout",
    message: `Runtime request timed out after ${timeoutMs}ms.`,
    retryable: true,
    details: {
      ...details,
      timeoutMs
    }
  });
