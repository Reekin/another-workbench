import {
  parseEventEnvelope,
  parseRuntimeEvent,
  type CommandEnvelope,
  type EventEnvelope,
  type RuntimeEvent
} from "@another-workbench/shared";
import type { AdapterMapperContext } from "./mapper.js";
import type { AdapterCommandResult } from "./types.js";
import type { AdapterCommandOutcome } from "./types.js";

type AdapterError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

const actorScopedEventTypes = new Set<RuntimeEvent["type"]>([
  "message.started",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.delta",
  "tool.completed",
  "terminal.started",
  "terminal.output",
  "terminal.completed",
  "approval.requested",
  "approval.resolved"
]);

export const createEventEnvelope = (
  event: RuntimeEvent,
  context: AdapterMapperContext,
  meta: { eventId?: string; cursor?: string; occurredAt?: string } = {}
): EventEnvelope =>
  parseEventEnvelope({
    eventId: meta.eventId ?? context.createId(),
    cursor: meta.cursor,
    occurredAt: meta.occurredAt ?? context.now(),
    event
  });

export const normalizeRuntimeEvent = (
  eventType: RuntimeEvent["type"],
  payload: Record<string, unknown>,
  fallbackEngineId: string
): RuntimeEvent => {
  const normalized: Record<string, unknown> = {
    ...payload,
    type: eventType
  };

  if (
    actorScopedEventTypes.has(eventType) &&
    typeof normalized.participantId !== "string" &&
    typeof normalized.engineId !== "string"
  ) {
    normalized.engineId = fallbackEngineId;
  }

  return parseRuntimeEvent(normalized);
};

export const defaultCommandResultFromResponse = (
  envelope: CommandEnvelope,
  response: unknown,
  resolved: {
    accepted?: boolean;
    outcome?: AdapterCommandOutcome;
    error?: AdapterError;
  } = {}
): AdapterCommandResult => ({
  commandId: envelope.commandId,
  commandType: envelope.command.type,
  accepted: resolved.accepted ?? !resolved.error,
  outcome: resolved.outcome,
  raw: response,
  error: resolved.error
});
