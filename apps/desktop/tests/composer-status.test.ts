import { describe, expect, it } from "vitest";
import { resolveComposerStatus } from "../src/ui/chat-shell/composer-status.js";

describe("resolveComposerStatus", () => {
  it("prefers pending approval state over generic session readiness", () => {
    expect(
      resolveComposerStatus({
        transportAvailable: true,
        selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          agentId: "codex",
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
      })
    ).toBe("Approval requested for 0");
  });

  it("falls back to active-session readiness after approval is resolved", () => {
    expect(
      resolveComposerStatus({
        transportAvailable: true,
        selectedEngineId: "codex",
        activeSession: {
          sessionId: "session-1",
          conversationId: "conversation-1",
          agentId: "codex",
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
    ).toBe("Ready in session-1");
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
});
