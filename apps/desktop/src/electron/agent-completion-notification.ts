import type {
  EventEnvelope,
  SessionBrowserPathRpc,
  WorkbenchEventPush,
  WorkbenchEventPushBatch
} from "@another-workbench/shared";

export type AgentCompletionNotification = {
  eventId: string;
  sessionId: string;
  turnId: string;
};

export type AgentCompletionNotifier = {
  handlePush: (push: WorkbenchEventPush) => void;
  handleBatch: (batch: WorkbenchEventPushBatch) => void;
};

export const findMainSessionInPath = (
  path: SessionBrowserPathRpc
): SessionBrowserPathRpc["items"][number] | undefined =>
  path.items.length === 1 && !path.items[0]?.parentSessionId
    ? path.items[0]
    : undefined;

export const createAgentCompletionNotifier = (input: {
  notify: (notification: AgentCompletionNotification) => void;
  maxRememberedEventIds?: number;
}): AgentCompletionNotifier => {
  const maxRememberedEventIds = Math.max(1, input.maxRememberedEventIds ?? 512);
  const seenEventIds = new Set<string>();

  const handleEnvelope = (envelope: EventEnvelope): void => {
    const event = envelope.event;
    if (
      event.type !== "turn.completed" ||
      event.finishReason !== "completed" ||
      seenEventIds.has(envelope.eventId)
    ) {
      return;
    }
    seenEventIds.add(envelope.eventId);
    if (seenEventIds.size > maxRememberedEventIds) {
      const oldest = seenEventIds.values().next().value;
      if (oldest) {
        seenEventIds.delete(oldest);
      }
    }
    input.notify({
      eventId: envelope.eventId,
      sessionId: event.sessionId,
      turnId: event.turnId
    });
  };

  return {
    handlePush: (push) => handleEnvelope(push.envelope),
    handleBatch: (batch) => {
      for (const push of batch.pushes) {
        handleEnvelope(push.envelope);
      }
    }
  };
};
