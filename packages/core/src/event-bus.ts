import type { EventType, RuntimeEvent } from "@another-workbench/shared";
import { parseRuntimeEvent } from "@another-workbench/shared";

export type RuntimeEventEnvelope = {
  eventId: string;
  cursor: string;
  occurredAt: string;
  event: RuntimeEvent;
};

export type RuntimeEventFilter = {
  eventTypes?: EventType[];
  sessionId?: string;
  conversationId?: string;
};

export type RuntimeEventListener = (envelope: RuntimeEventEnvelope) => void;

export type RuntimeEventReplayPort = {
  onEventPublished?: (envelope: RuntimeEventEnvelope) => void;
  readSinceCursor?: (cursor: string) => RuntimeEventEnvelope[];
  replay?: (input: RuntimeEventReplayInput) => RuntimeEventEnvelope[];
};

export type RuntimeEventReplayInput = {
  fromCursor?: string;
  toCursor?: string;
  filter?: RuntimeEventFilter;
  limit?: number;
};

type RuntimeEventBusOptions = {
  now?: () => string;
  createId?: () => string;
  replayPort?: RuntimeEventReplayPort;
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined;
  maxReplayEnvelopes?: number;
};

type Subscription = {
  listener: RuntimeEventListener;
  filter: RuntimeEventFilter;
};

const createOpaqueId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const eventToSessionId = (event: RuntimeEvent): string | undefined =>
  "sessionId" in event ? event.sessionId : undefined;

const eventToConversationId = (
  event: RuntimeEvent,
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined
): string | undefined => {
  if ("conversationId" in event) {
    return event.conversationId;
  }

  const sessionId = eventToSessionId(event);
  if (!sessionId || !resolveConversationIdBySessionId) {
    return undefined;
  }

  return resolveConversationIdBySessionId(sessionId);
};

const shouldDeliver = (
  filter: RuntimeEventFilter,
  envelope: RuntimeEventEnvelope,
  resolveConversationIdBySessionId?: (sessionId: string) => string | undefined
): boolean => {
  if (filter.eventTypes && !filter.eventTypes.includes(envelope.event.type)) {
    return false;
  }

  if (
    filter.sessionId &&
    eventToSessionId(envelope.event) !== filter.sessionId
  ) {
    return false;
  }

  if (!filter.conversationId) {
    return true;
  }

  return (
    eventToConversationId(envelope.event, resolveConversationIdBySessionId) ===
    filter.conversationId
  );
};

export class RuntimeEventBus {
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly replayPort?: RuntimeEventReplayPort;
  private readonly resolveConversationIdBySessionId?: (
    sessionId: string
  ) => string | undefined;
  private readonly replayBuffer: RuntimeEventEnvelope[] = [];
  private readonly maxReplayEnvelopes: number;
  private readonly now: () => string;
  private readonly createId: () => string;
  private sequence = 0;
  private nextSubscriptionId = 1;

  public constructor(options: RuntimeEventBusOptions = {}) {
    this.replayPort = options.replayPort;
    this.resolveConversationIdBySessionId =
      options.resolveConversationIdBySessionId;
    this.maxReplayEnvelopes = Math.max(1, options.maxReplayEnvelopes ?? 2_000);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? createOpaqueId;
  }

  public publish(event: RuntimeEvent | unknown): RuntimeEventEnvelope {
    const parsedEvent = parseRuntimeEvent(event);
    const envelope: RuntimeEventEnvelope = {
      eventId: this.createId(),
      cursor: String(++this.sequence),
      occurredAt: this.now(),
      event: parsedEvent
    };

    this.appendReplayEnvelope(envelope);
    this.replayPort?.onEventPublished?.(envelope);
    for (const subscription of this.subscriptions.values()) {
      if (
        shouldDeliver(
          subscription.filter,
          envelope,
          this.resolveConversationIdBySessionId
        )
      ) {
        subscription.listener(envelope);
      }
    }

    return envelope;
  }

  public subscribe(
    listener: RuntimeEventListener,
    filter: RuntimeEventFilter = {}
  ): () => void {
    const subscriptionId = this.nextSubscriptionId++;
    this.subscriptions.set(subscriptionId, { listener, filter });
    return () => {
      this.subscriptions.delete(subscriptionId);
    };
  }

  public subscribeWithReplay(
    listener: RuntimeEventListener,
    input: RuntimeEventReplayInput = {}
  ): () => void {
    const upperCursor =
      input.toCursor ?? (this.sequence > 0 ? String(this.sequence) : undefined);
    const unsubscribe = this.subscribe(listener, input.filter);
    const replayed = this.replay({
      ...input,
      toCursor: upperCursor
    });

    for (const envelope of replayed) {
      listener(envelope);
    }

    return unsubscribe;
  }

  public getLatestCursor(): string | undefined {
    return this.sequence > 0 ? String(this.sequence) : undefined;
  }

  public readSinceCursor(
    cursor: string,
    filter: RuntimeEventFilter = {}
  ): RuntimeEventEnvelope[] {
    return this.replay({
      fromCursor: cursor,
      filter
    });
  }

  public replay(input: RuntimeEventReplayInput = {}): RuntimeEventEnvelope[] {
    const source = this.readReplaySource(input);
    const filtered = this.sliceByCursor(source, input.fromCursor, input.toCursor)
      .filter((envelope) =>
        shouldDeliver(
          input.filter ?? {},
          envelope,
          this.resolveConversationIdBySessionId
        )
      );

    if (typeof input.limit !== "number") {
      return filtered;
    }
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit >= filtered.length) {
      return filtered;
    }
    return filtered.slice(0, limit);
  }

  public getSubscriberCount(): number {
    return this.subscriptions.size;
  }

  private appendReplayEnvelope(envelope: RuntimeEventEnvelope): void {
    this.replayBuffer.push(envelope);
    const overflow = this.replayBuffer.length - this.maxReplayEnvelopes;
    if (overflow > 0) {
      this.replayBuffer.splice(0, overflow);
    }
  }

  private readReplaySource(input: RuntimeEventReplayInput): RuntimeEventEnvelope[] {
    if (this.replayPort?.replay) {
      return this.replayPort.replay(input);
    }

    if (input.fromCursor && this.replayPort?.readSinceCursor) {
      return this.replayPort.readSinceCursor(input.fromCursor);
    }

    return [...this.replayBuffer];
  }

  private sliceByCursor(
    envelopes: RuntimeEventEnvelope[],
    fromCursor?: string,
    toCursor?: string
  ): RuntimeEventEnvelope[] {
    const startIndex = this.findStartIndex(envelopes, fromCursor);
    const endIndex = this.findEndIndex(envelopes, toCursor);
    if (startIndex >= endIndex) {
      return [];
    }
    return envelopes.slice(startIndex, endIndex);
  }

  private findStartIndex(
    envelopes: RuntimeEventEnvelope[],
    fromCursor?: string
  ): number {
    if (!fromCursor) {
      return 0;
    }
    const index = envelopes.findIndex((envelope) => envelope.cursor === fromCursor);
    if (index === -1) {
      return 0;
    }
    return index + 1;
  }

  private findEndIndex(
    envelopes: RuntimeEventEnvelope[],
    toCursor?: string
  ): number {
    if (!toCursor) {
      return envelopes.length;
    }
    const index = envelopes.findIndex((envelope) => envelope.cursor === toCursor);
    if (index === -1) {
      return envelopes.length;
    }
    return index + 1;
  }
}
