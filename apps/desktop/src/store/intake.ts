import {
  parseDomainSnapshot,
  parseEventEnvelope,
  parseRuntimeEvent,
  safeParseEventEnvelope,
  safeParseRuntimeEvent,
  type DomainSnapshot,
  type EventEnvelope,
  type RuntimeEvent
} from "@another-workbench/shared";
import type { RendererStoreAction } from "./types.js";

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown };

const safeParseWith = <T>(parse: (payload: unknown) => T, payload: unknown): SafeParseResult<T> => {
  try {
    return {
      success: true,
      data: parse(payload)
    };
  } catch (error) {
    return {
      success: false,
      error
    };
  }
};

export const createHydrateSnapshotAction = (
  snapshot: DomainSnapshot
): RendererStoreAction => ({
  type: "store/hydrateSnapshot",
  snapshot
});

export const createIngestEventAction = (event: RuntimeEvent): RendererStoreAction => ({
  type: "store/ingestEvent",
  event
});

export const createIngestEnvelopeAction = (
  envelope: EventEnvelope
): RendererStoreAction => ({
  type: "store/ingestEnvelope",
  envelope
});

export const parseHydrateSnapshotAction = (
  payload: unknown
): RendererStoreAction => ({
  type: "store/hydrateSnapshot",
  snapshot: parseDomainSnapshot(payload)
});

export const parseIngestEventAction = (payload: unknown): RendererStoreAction => ({
  type: "store/ingestEvent",
  event: parseRuntimeEvent(payload)
});

export const parseIngestEnvelopeAction = (payload: unknown): RendererStoreAction => {
  const envelope = parseEventEnvelope(payload);
  return createIngestEnvelopeAction(envelope);
};

export const safeParseHydrateSnapshotAction = (payload: unknown) => {
  const parsed = safeParseWith(parseDomainSnapshot, payload);
  if (!parsed.success) {
    return parsed;
  }
  return {
    success: true as const,
    data: createHydrateSnapshotAction(parsed.data)
  };
};

export const safeParseIngestEventAction = (payload: unknown) => {
  const parsed = safeParseRuntimeEvent(payload);
  if (!parsed.success) {
    return parsed;
  }
  return {
    success: true as const,
    data: createIngestEventAction(parsed.data)
  };
};

export const safeParseIngestEnvelopeAction = (payload: unknown) => {
  const parsed = safeParseEventEnvelope(payload);
  if (!parsed.success) {
    return parsed;
  }
  return {
    success: true as const,
    data: createIngestEnvelopeAction(parsed.data)
  };
};

export const eventFromEnvelope = (envelope: EventEnvelope): RuntimeEvent =>
  envelope.event;
