import { parseEventEnvelope, type CommandEnvelope } from "@another-workbench/shared";
import { LifecycleGate } from "./lifecycle-gate.js";
import type { AdapterMapper } from "./mapper.js";
import type { AdapterRuntimePort } from "./runtime-port.js";
import type { RuntimeLifecycleState } from "./runtime-lifecycle.js";
import type {
  AdapterCommandResult,
  AdapterEventFilter,
  AdapterEventListener,
  AdapterKind,
  AdapterLifecycleState,
  AgentAdapter,
  AgentAdapterRuntimeConfig
} from "./types.js";

type RuntimeBackedAdapterOptions<
  TRequest,
  TResponse,
  TEvent
> = {
  id: string;
  kind: AdapterKind;
  runtimePort: AdapterRuntimePort<TRequest, TResponse, TEvent>;
  mapper: AdapterMapper<TRequest, TResponse, TEvent>;
  now?: () => string;
  createId?: () => string;
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined;
};

type Subscription = {
  listener: AdapterEventListener;
  filter: AdapterEventFilter;
};

const createOpaqueId = (): string =>
  `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const eventSessionId = (event: Record<string, unknown>): string | undefined =>
  typeof event.sessionId === "string" ? event.sessionId : undefined;

const eventConversationId = (event: Record<string, unknown>): string | undefined =>
  typeof event.conversationId === "string" ? event.conversationId : undefined;

const resolveConversationId = (
  envelope: ReturnType<typeof parseEventEnvelope>,
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined
): string | undefined => {
  const directConversationId = eventConversationId(
    envelope.event as Record<string, unknown>
  );
  if (directConversationId) {
    return directConversationId;
  }
  if (!resolveConversationIdBySessionId) {
    return undefined;
  }
  const sessionId = eventSessionId(envelope.event as Record<string, unknown>);
  if (!sessionId) {
    return undefined;
  }
  return resolveConversationIdBySessionId(sessionId);
};

const shouldDeliver = (
  filter: AdapterEventFilter,
  envelope: ReturnType<typeof parseEventEnvelope>,
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined
): boolean => {
  if (filter.eventTypes && !filter.eventTypes.includes(envelope.event.type)) {
    return false;
  }

  if (filter.sessionId) {
    const sessionId = eventSessionId(envelope.event as Record<string, unknown>);
    if (sessionId !== filter.sessionId) {
      return false;
    }
  }

  if (filter.conversationId) {
    const conversationId = resolveConversationId(
      envelope,
      resolveConversationIdBySessionId
    );
    if (conversationId !== filter.conversationId) {
      return false;
    }
  }

  return true;
};

export class RuntimeBackedAdapter<
  TRequest,
  TResponse,
  TEvent
> implements AgentAdapter {
  public readonly id: string;
  public readonly kind: AdapterKind;
  private readonly runtimePort: AdapterRuntimePort<TRequest, TResponse, TEvent>;
  private readonly mapper: AdapterMapper<TRequest, TResponse, TEvent>;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly resolveConversationIdBySessionId:
    | ((sessionId: string) => string | undefined)
    | undefined;
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly lifecycleGate = new LifecycleGate();
  private teardownRuntimeSubscription: (() => void) | undefined;
  private teardownRuntimeStateSubscription: (() => void) | undefined;
  private nextSubscriptionId = 1;
  private lifecycleState: AdapterLifecycleState = "idle";

  public constructor(options: RuntimeBackedAdapterOptions<TRequest, TResponse, TEvent>) {
    this.id = options.id;
    this.kind = options.kind;
    this.runtimePort = options.runtimePort;
    this.mapper = options.mapper;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? createOpaqueId;
    this.resolveConversationIdBySessionId =
      options.resolveConversationIdBySessionId;
  }

  public getLifecycleState(): AdapterLifecycleState {
    return this.lifecycleState;
  }

  public async initialize(config: AgentAdapterRuntimeConfig = {}): Promise<void> {
    if (this.lifecycleState === "ready") {
      return;
    }

    await this.lifecycleGate.start(async () => {
      if (this.lifecycleState === "ready") {
        return;
      }

      this.lifecycleState = "starting";
      this.teardownRuntimeStateSubscription ??= this.runtimePort.subscribeState(
        (state) => {
          this.applyRuntimeLifecycleState(state);
        }
      );
      try {
        await this.runtimePort.start({
          cwd: config.cwd,
          env: config.env,
          auth: config.auth,
          metadata: config.metadata
        });
        this.teardownRuntimeSubscription ??= this.runtimePort.subscribe((event) => {
          this.publishRuntimeEvent(event);
        });
        this.lifecycleState = "ready";
      } catch (error) {
        this.lifecycleState = "error";
        throw error;
      }
    });
  }

  public async executeCommand(
    envelope: CommandEnvelope
  ): Promise<AdapterCommandResult> {
    if (this.lifecycleState !== "ready") {
      throw new Error(
        `Adapter ${this.id} is not ready. Current state: ${this.lifecycleState}`
      );
    }

    const context = this.createMapperContext();
    const runtimeRequest = this.mapper.mapCommand(envelope, context);
    const runtimeResponse = await this.runtimePort.request(runtimeRequest);
    return this.mapper.mapCommandResult(runtimeResponse, envelope, context);
  }

  public subscribe(
    listener: AdapterEventListener,
    filter: AdapterEventFilter = {}
  ): () => void {
    const subscriptionId = this.nextSubscriptionId++;
    this.subscriptions.set(subscriptionId, { listener, filter });
    return () => {
      this.subscriptions.delete(subscriptionId);
    };
  }

  public async dispose(): Promise<void> {
    await this.lifecycleGate.stop(async () => {
      if (this.teardownRuntimeSubscription) {
        this.teardownRuntimeSubscription();
        this.teardownRuntimeSubscription = undefined;
      }
      if (this.teardownRuntimeStateSubscription) {
        this.teardownRuntimeStateSubscription();
        this.teardownRuntimeStateSubscription = undefined;
      }
      this.subscriptions.clear();
      await this.runtimePort.stop();
      this.lifecycleState = "stopped";
    });
  }

  private publishRuntimeEvent(event: TEvent): void {
    const context = this.createMapperContext();
    const mappedEnvelopes = this.mapper.mapRuntimeEvent(event, context);
    for (const envelope of mappedEnvelopes) {
      const parsedEnvelope = parseEventEnvelope(envelope);
      for (const { listener, filter } of this.subscriptions.values()) {
        if (
          shouldDeliver(
            filter,
            parsedEnvelope,
            this.resolveConversationIdBySessionId
          )
        ) {
          listener(parsedEnvelope);
        }
      }
    }
  }

  private createMapperContext() {
    return {
      adapterId: this.id,
      now: this.now,
      createId: this.createId
    };
  }

  private applyRuntimeLifecycleState(state: RuntimeLifecycleState): void {
    switch (state) {
      case "starting":
        this.lifecycleState = "starting";
        break;
      case "ready":
        this.lifecycleState = "ready";
        break;
      case "stopping":
      case "stopped":
        this.lifecycleState = "stopped";
        break;
      case "failed":
        this.lifecycleState = "error";
        break;
    }
  }
}
