import type { AgentAdapterRuntimeConfig } from "./types.js";
import type {
  RuntimeLifecycleState,
  RuntimeOperationOptions,
  RuntimeStartOptions,
  RuntimeStateListener,
  RuntimeStopOptions
} from "./runtime-lifecycle.js";

export type RuntimeEventListener<TEvent> = (event: TEvent) => void;

export interface AdapterRuntimePort<
  TRequest = unknown,
  TResponse = unknown,
  TEvent = unknown
> {
  getState(): RuntimeLifecycleState;
  start(
    config?: AgentAdapterRuntimeConfig,
    options?: RuntimeStartOptions
  ): Promise<void>;
  stop(options?: RuntimeStopOptions): Promise<void>;
  request(
    payload: TRequest,
    options?: RuntimeOperationOptions
  ): Promise<TResponse>;
  subscribe(listener: RuntimeEventListener<TEvent>): () => void;
  subscribeState(listener: RuntimeStateListener): () => void;
}
