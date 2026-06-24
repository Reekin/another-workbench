import type { EventType, RuntimeEvent } from "@another-workbench/shared";
import {
  appendLimitedStreamText,
  limitSingleStreamChunk,
  parseRuntimeEvent
} from "@another-workbench/shared";

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

export type RuntimeEventListenerError = {
  error: unknown;
  envelope: RuntimeEventEnvelope;
  subscriptionId?: number;
  phase: "live" | "replay";
};

export type RuntimeEventReplayPort = {
  onEventPublished?: (envelope: RuntimeEventEnvelope) => void;
  readSinceCursor?: (cursor: string) => RuntimeEventReplayPortResult;
  replay?: (input: RuntimeEventReplayInput) => RuntimeEventReplayPortResult;
};

export type RuntimeEventReplayInput = {
  fromCursor?: string;
  toCursor?: string;
  filter?: RuntimeEventFilter;
  limit?: number;
};

export type RuntimeEventReplayGapReason = "cursor_not_found";

export type RuntimeEventReplayOkResult = {
  status: "ok";
  replayed: number;
  fromCursor?: string;
  toCursor?: string;
  envelopes: RuntimeEventEnvelope[];
};

export type RuntimeEventReplayGapResult = {
  status: "gap";
  reason: RuntimeEventReplayGapReason;
  replayed: 0;
  fromCursor: string;
  toCursor?: string;
  envelopes: [];
};

export type RuntimeEventReplayResult =
  | RuntimeEventReplayOkResult
  | RuntimeEventReplayGapResult;

export type RuntimeEventReplayPortResult =
  | RuntimeEventEnvelope[]
  | RuntimeEventReplayResult;

type RuntimeEventBusOptions = {
  now?: () => string;
  createId?: () => string;
  replayPort?: RuntimeEventReplayPort;
  onListenerError?: (error: RuntimeEventListenerError) => void;
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

const limitRuntimeEventPayload = (event: RuntimeEvent): RuntimeEvent => {
  switch (event.type) {
    case "message.delta":
      return {
        ...event,
        delta: limitSingleStreamChunk(event.delta)
      };
    case "message.completed":
      return {
        ...event,
        finalText:
          event.finalText != null
            ? appendLimitedStreamText(undefined, event.finalText)
            : undefined
      };
    case "tool.delta":
      return {
        ...event,
        delta: limitSingleStreamChunk(event.delta)
      };
    case "tool.completed":
      return {
        ...event,
        outputSummary:
          event.outputSummary != null
            ? appendLimitedStreamText(undefined, event.outputSummary)
            : undefined
      };
    case "terminal.output":
      return {
        ...event,
        chunk: limitSingleStreamChunk(event.chunk)
      };
    default:
      return event;
  }
};

const limitRuntimeEventEnvelopePayload = (
  envelope: RuntimeEventEnvelope
): RuntimeEventEnvelope => {
  const limitedEvent = limitRuntimeEventPayload(envelope.event);
  if (limitedEvent === envelope.event) {
    return envelope;
  }
  return {
    ...envelope,
    event: limitedEvent
  };
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
  private readonly onListenerError?: (error: RuntimeEventListenerError) => void;
  private sequence = 0;
  private nextSubscriptionId = 1;

  public constructor(options: RuntimeEventBusOptions = {}) {
    this.replayPort = options.replayPort;
    this.resolveConversationIdBySessionId =
      options.resolveConversationIdBySessionId;
    this.maxReplayEnvelopes = Math.max(1, options.maxReplayEnvelopes ?? 2_000);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? createOpaqueId;
    this.onListenerError = options.onListenerError;
  }

  public publish(event: RuntimeEvent | unknown): RuntimeEventEnvelope {
    return this.publishBatch([event])[0];
  }

  public publishBatch(events: readonly (RuntimeEvent | unknown)[]): RuntimeEventEnvelope[] {
    const parsedEvents = events.map((event) =>
      limitRuntimeEventPayload(parseRuntimeEvent(event))
    );
    const envelopes = parsedEvents.map((event) => this.createEnvelope(event));

    for (const envelope of envelopes) {
      this.appendReplayEnvelope(envelope);
      this.replayPort?.onEventPublished?.(envelope);
    }
    for (const envelope of envelopes) {
      this.deliverEnvelope(envelope);
    }

    return envelopes;
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
      this.deliverToListener({
        listener,
        envelope,
        phase: "replay"
      });
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
    return this.readSinceCursorResult(cursor, filter).envelopes;
  }

  public readSinceCursorResult(
    cursor: string,
    filter: RuntimeEventFilter = {}
  ): RuntimeEventReplayResult {
    return this.replayResult({
      fromCursor: cursor,
      filter
    });
  }

  public replay(input: RuntimeEventReplayInput = {}): RuntimeEventEnvelope[] {
    return this.replayResult(input).envelopes;
  }

  public replayResult(
    input: RuntimeEventReplayInput = {}
  ): RuntimeEventReplayResult {
    const source = this.readReplaySource(input);
    if (source.result.status === "gap") {
      return source.result;
    }

    const sliced = this.sliceByCursor(
      source.result.envelopes,
      source.fromCursorAlreadyApplied ? undefined : input.fromCursor,
      input.toCursor
    );
    if (sliced.status === "gap") {
      return sliced;
    }

    const filtered = sliced.envelopes.filter((envelope) =>
      shouldDeliver(
        input.filter ?? {},
        envelope,
        this.resolveConversationIdBySessionId
      )
    );
    const normalized = filtered.map(limitRuntimeEventEnvelopePayload);

    if (typeof input.limit !== "number") {
      return this.createReplayOkResult(input, normalized);
    }
    const limit = Math.max(0, Math.floor(input.limit));
    if (limit >= normalized.length) {
      return this.createReplayOkResult(input, normalized);
    }
    return this.createReplayOkResult(input, normalized.slice(0, limit));
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

  private createEnvelope(event: RuntimeEvent): RuntimeEventEnvelope {
    return {
      eventId: this.createId(),
      cursor: String(++this.sequence),
      occurredAt: this.now(),
      event
    };
  }

  private deliverEnvelope(envelope: RuntimeEventEnvelope): void {
    for (const [subscriptionId, subscription] of this.subscriptions.entries()) {
      if (
        shouldDeliver(
          subscription.filter,
          envelope,
          this.resolveConversationIdBySessionId
        )
      ) {
        this.deliverToListener({
          listener: subscription.listener,
          envelope,
          subscriptionId,
          phase: "live"
        });
      }
    }
  }

  private deliverToListener(input: {
    listener: RuntimeEventListener;
    envelope: RuntimeEventEnvelope;
    subscriptionId?: number;
    phase: RuntimeEventListenerError["phase"];
  }): void {
    try {
      input.listener(input.envelope);
    } catch (error) {
      this.reportListenerError({
        error,
        envelope: input.envelope,
        subscriptionId: input.subscriptionId,
        phase: input.phase
      });
    }
  }

  private reportListenerError(error: RuntimeEventListenerError): void {
    try {
      this.onListenerError?.(error);
    } catch {
      // Error diagnostics must never become another publish failure.
    }
  }

  private readReplaySource(input: RuntimeEventReplayInput): {
    result: RuntimeEventReplayResult;
    fromCursorAlreadyApplied: boolean;
  } {
    if (this.replayPort?.replay) {
      const replayPortResult = this.replayPort.replay(input);
      return {
        result: this.normalizeReplayPortResult(replayPortResult, input),
        fromCursorAlreadyApplied: !Array.isArray(replayPortResult)
      };
    }

    if (input.fromCursor && this.replayPort?.readSinceCursor) {
      return {
        result: this.normalizeReplayPortResult(
          this.replayPort.readSinceCursor(input.fromCursor),
          input
        ),
        fromCursorAlreadyApplied: true
      };
    }

    return {
      result: this.createReplayOkResult(input, [...this.replayBuffer]),
      fromCursorAlreadyApplied: false
    };
  }

  private normalizeReplayPortResult(
    result: RuntimeEventReplayPortResult,
    input: RuntimeEventReplayInput
  ): RuntimeEventReplayResult {
    if (Array.isArray(result)) {
      return this.createReplayOkResult(input, result);
    }
    return result;
  }

  private sliceByCursor(
    envelopes: RuntimeEventEnvelope[],
    fromCursor?: string,
    toCursor?: string
  ): RuntimeEventReplayResult {
    const startIndex = this.findStartIndex(envelopes, fromCursor);
    if (startIndex === "missing") {
      return this.createReplayGapResult({
        fromCursor: fromCursor ?? "",
        toCursor
      });
    }
    const endIndex = this.findEndIndex(envelopes, toCursor);
    const sliced =
      startIndex >= endIndex ? [] : envelopes.slice(startIndex, endIndex);
    return this.createReplayOkResult(
      {
        fromCursor,
        toCursor
      },
      sliced
    );
  }

  private createReplayOkResult(
    input: RuntimeEventReplayInput,
    envelopes: RuntimeEventEnvelope[]
  ): RuntimeEventReplayOkResult {
    return {
      status: "ok",
      replayed: envelopes.length,
      fromCursor: input.fromCursor,
      toCursor: input.toCursor,
      envelopes
    };
  }

  private createReplayGapResult(input: {
    fromCursor: string;
    toCursor?: string;
  }): RuntimeEventReplayGapResult {
    return {
      status: "gap",
      reason: "cursor_not_found",
      replayed: 0,
      fromCursor: input.fromCursor,
      toCursor: input.toCursor,
      envelopes: []
    };
  }

  private findStartIndex(
    envelopes: RuntimeEventEnvelope[],
    fromCursor?: string
  ): number | "missing" {
    if (!fromCursor) {
      return 0;
    }
    const index = envelopes.findIndex((envelope) => envelope.cursor === fromCursor);
    if (index === -1) {
      return "missing";
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
