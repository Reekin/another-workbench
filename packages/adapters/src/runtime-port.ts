export type RuntimeEventListener<TEvent> = (event: TEvent) => void;

export interface AdapterRuntimePort<
  TRequest = unknown,
  TResponse = unknown,
  TEvent = unknown
> {
  start(config?: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
  request(payload: TRequest): Promise<TResponse>;
  subscribe(listener: RuntimeEventListener<TEvent>): () => void;
}

