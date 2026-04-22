import { describe, expect, it } from "vitest";
import {
  resolveComposerStatus,
  resolveComposerStatusModel
} from "../src/ui/chat-shell/composer-status.js";

describe("resolveComposerStatus", () => {
  it("prefers pending approval state over generic session readiness", () => {
    const status = resolveComposerStatusModel({
      transportAvailable: true,
      selectedEngineId: "codex",
      activeSession: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        status: "awaiting_approval",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z"
      },
      approvals: [
        {
          requestId: "0",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalKind: "command",
          status: "pending",
          title: "Approve command execution",
          requestedAt: "2026-04-18T00:00:00.000Z"
        }
      ]
    });

    expect(status).toEqual({
      kind: "awaiting_approval",
      label: "Awaiting approval",
      detail: "Approval requested for 0"
    });
    expect(resolveComposerStatus({
      transportAvailable: true,
      selectedEngineId: "codex",
      activeSession: {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engineId: "codex",
        status: "awaiting_approval",
        createdAt: "2026-04-18T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z"
      },
      approvals: [
        {
          requestId: "0",
          sessionId: "session-1",
          turnId: "turn-1",
          approvalKind: "command",
          status: "pending",
          title: "Approve command execution",
          requestedAt: "2026-04-18T00:00:00.000Z"
        }
      ]
    })).toBe("Awaiting approval: Approval requested for 0");
  });

  it("falls back to active-session readiness after approval is resolved", () => {
    expect(
      resolveComposerStatus({
        transportAvailable: true,
        selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        },
        approvals: [
          {
            requestId: "0",
            sessionId: "session-1",
            turnId: "turn-1",
            approvalKind: "command",
            status: "approved",
            title: "Approve command execution",
            requestedAt: "2026-04-18T00:00:00.000Z",
            resolvedAt: "2026-04-18T00:00:05.000Z"
          }
        ]
      })
    ).toBe("Ready: In session-1");
  });

  it("lets explicit notices override the derived baseline", () => {
    expect(
      resolveComposerStatus({
        transportAvailable: true,
        selectedEngineId: "codex",
        notice: {
          message: "Message sent.",
          source: "send"
        }
      })
    ).toBe("Message sent.");
  });

  it("surfaces queued follow-ups when the session is otherwise idle", () => {
    expect(
      resolveComposerStatusModel({
        transportAvailable: true,
        selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "idle",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        },
        queuedCount: 2
      })
    ).toEqual({
      kind: "queue_pending",
      label: "2 queued",
      detail: "Will auto-send when idle"
    });
  });

  it("describes steer capability while a session is running", () => {
    expect(
      resolveComposerStatusModel({
        transportAvailable: true,
        selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          engineId: "codex",
          status: "running",
          createdAt: "2026-04-18T00:00:00.000Z",
          updatedAt: "2026-04-18T00:00:00.000Z"
        },
        supportsSteer: true
      })
    ).toEqual({
      kind: "running",
      label: "Running",
      detail: "Steer supported"
    });
  });
});
