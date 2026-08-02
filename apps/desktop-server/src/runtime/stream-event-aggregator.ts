import {
  MAX_STREAM_EVENT_CHUNK_LENGTH,
  type EventEnvelope,
  type RuntimeEvent
} from "@another-workbench/shared";

type StreamEvent = Extract<
  RuntimeEvent,
  { type: "message.delta" | "terminal.output" }
>;

type StreamEnvelope = EventEnvelope & {
  event: StreamEvent;
};

type PendingAggregate = {
  envelope: StreamEnvelope;
  fragments: string[];
  length: number;
};

type EmitEnvelope = (envelope: EventEnvelope) => void;

const FLUSH_DELAY_MS = 12;

const streamText = (event: StreamEvent): string =>
  event.type === "message.delta" ? event.delta : event.chunk;

const withStreamText = (
  event: StreamEvent,
  text: string
): StreamEvent =>
  event.type === "message.delta"
    ? { ...event, delta: text }
    : { ...event, chunk: text };

const streamTargetKey = (event: StreamEvent): string =>
  event.type === "message.delta"
    ? JSON.stringify([
        event.type,
        event.sessionId,
        event.turnId,
        event.messageId,
        event.engineId,
        event.participantId,
        event.phase
      ])
    : JSON.stringify([
        event.type,
        event.sessionId,
        event.turnId,
        event.terminalId,
        event.engineId,
        event.participantId
      ]);

const safePrefixLength = (value: string, requestedLength: number): number => {
  let length = Math.min(requestedLength, value.length);
  if (
    length > 0 &&
    length < value.length &&
    /[\uD800-\uDBFF]/.test(value[length - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(value[length] ?? "")
  ) {
    length -= 1;
  }
  return length;
};

export class StreamEventAggregator {
  private readonly pendingByKey = new Map<string, PendingAggregate>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  public constructor(private readonly emit: EmitEnvelope) {}

  public push(envelope: EventEnvelope): void {
    if (this.closed) {
      return;
    }
    if (
      envelope.event.type !== "message.delta" &&
      envelope.event.type !== "terminal.output"
    ) {
      this.flush();
      this.emit(envelope);
      return;
    }

    this.pushStreamEnvelope(envelope as StreamEnvelope);
    if (this.pendingByKey.size > 0) {
      this.scheduleFlush();
    }
  }

  public flush(): void {
    this.clearTimer();
    for (const key of [...this.pendingByKey.keys()]) {
      this.flushAggregate(key);
    }
  }

  public dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.flush();
  }

  private pushStreamEnvelope(envelope: StreamEnvelope): void {
    const key = streamTargetKey(envelope.event);
    let remaining = streamText(envelope.event);
    while (remaining.length > 0) {
      let aggregate = this.pendingByKey.get(key);
      if (!aggregate) {
        aggregate = {
          envelope,
          fragments: [],
          length: 0
        };
        this.pendingByKey.set(key, aggregate);
      }

      const available = MAX_STREAM_EVENT_CHUNK_LENGTH - aggregate.length;
      const prefixLength = safePrefixLength(remaining, available);
      if (prefixLength === 0) {
        this.flushAggregate(key);
        continue;
      }
      const fragment = remaining.slice(0, prefixLength);
      aggregate.fragments.push(fragment);
      aggregate.length += fragment.length;
      aggregate.envelope = envelope;
      remaining = remaining.slice(prefixLength);

      if (aggregate.length >= MAX_STREAM_EVENT_CHUNK_LENGTH) {
        this.flush();
      }
    }
  }

  private scheduleFlush(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flushAggregate(key: string): void {
    const aggregate = this.pendingByKey.get(key);
    if (!aggregate) {
      return;
    }
    this.pendingByKey.delete(key);
    this.emit({
      ...aggregate.envelope,
      event: withStreamText(aggregate.envelope.event, aggregate.fragments.join(""))
    });
  }
}
