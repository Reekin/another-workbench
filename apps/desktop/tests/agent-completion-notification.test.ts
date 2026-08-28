import { describe, expect, it, vi } from "vitest";
import type {
  EventEnvelope,
  SessionBrowserPathRpc,
  WorkbenchEventPush,
  WorkbenchEventPushBatch
} from "@another-workbench/shared";
import {
  createAgentCompletionNotifier,
  findMainSessionInPath
} from "../src/electron/agent-completion-notification.js";

const completionEnvelope = (
  eventId: string,
  finishReason: "completed" | "interrupted" | "failed" = "completed"
): EventEnvelope => ({
  eventId,
  cursor: `cursor-${eventId}`,
  occurredAt: "2026-08-23T00:00:00.000Z",
  event: {
    type: "turn.completed",
    sessionId: "session-1",
    turnId: "turn-1",
    finishReason
  }
});

const push = (envelope: EventEnvelope): WorkbenchEventPush => ({
  channel: "workbench.events",
  subscriptionId: "subscription-1",
  envelope
});

describe("agent completion notifications", () => {
  it("allows root sessions and rejects subagent or unknown sessions", () => {
    const root = {
      workspaceId: "workspace-1",
      revision: "revision-1",
      items: [{
        sessionId: "session-root",
        engineId: "codex",
        title: "Root",
        statusDot: "none",
        isActive: true,
        isExpanded: false,
        childCount: 1
      }]
    } satisfies SessionBrowserPathRpc;
    const child = {
      ...root,
      items: [
        root.items[0],
        {
          sessionId: "session-child",
          parentSessionId: "session-root",
          engineId: "codex",
          title: "Child",
          statusDot: "none",
          isActive: false,
          isExpanded: false,
          childCount: 0
        }
      ]
    } satisfies SessionBrowserPathRpc;

    expect(findMainSessionInPath(root)?.title).toBe("Root");
    expect(findMainSessionInPath(child)).toBeUndefined();
  });

  it("notifies once for a successfully completed turn", () => {
    const notify = vi.fn();
    const notifier = createAgentCompletionNotifier({ notify });
    const completed = push(completionEnvelope("event-1"));

    notifier.handlePush(completed);
    notifier.handlePush(completed);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      eventId: "event-1",
      sessionId: "session-1",
      turnId: "turn-1"
    });
  });

  it("ignores interrupted and failed turns", () => {
    const notify = vi.fn();
    const notifier = createAgentCompletionNotifier({ notify });

    notifier.handlePush(push(completionEnvelope("event-1", "interrupted")));
    notifier.handlePush(push(completionEnvelope("event-2", "failed")));

    expect(notify).not.toHaveBeenCalled();
  });

  it("handles batched pushes and ignores unrelated events", () => {
    const notify = vi.fn();
    const notifier = createAgentCompletionNotifier({ notify });
    const batch: WorkbenchEventPushBatch = {
      channel: "workbench.events.batch",
      pushes: [
        push({
          eventId: "event-message",
          cursor: "cursor-message",
          occurredAt: "2026-08-23T00:00:00.000Z",
          event: {
            type: "message.completed",
            sessionId: "session-1",
            turnId: "turn-1",
            messageId: "message-1"
          }
        }),
        push(completionEnvelope("event-completed"))
      ]
    };

    notifier.handleBatch(batch);

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
