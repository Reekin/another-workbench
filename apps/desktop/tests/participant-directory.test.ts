import { describe, expect, it } from "vitest";
import {
  buildParticipantDirectory,
  resolveParticipantIdentity,
  summarizeParticipant
} from "../src/ui/chat-shell/participant-directory.js";

describe("participant directory", () => {
  it("resolves actor identities from participant.updated-backed entities", () => {
    const directory = buildParticipantDirectory([
      {
        participantId: "participant-1",
        conversationId: "conv-1",
        engineId: "agent-codex",
        role: "primary",
        capabilities: ["chat", "terminal"],
        activeSessionIds: ["session-1"]
      }
    ]);

    expect(
      resolveParticipantIdentity(directory, {
        participantId: "participant-1",
        engineId: "agent-codex"
      })
    ).toMatchObject({
      label: "agent-codex",
      participantId: "participant-1",
      role: "primary",
      kind: "participant"
    });

    expect(
      resolveParticipantIdentity(directory, {
        engineId: "agent-codex"
      })
    ).toMatchObject({
      label: "agent-codex",
      kind: "participant"
    });

    expect(
      resolveParticipantIdentity(directory, undefined, "assistant")
    ).toMatchObject({
      label: "assistant",
      kind: "role"
    });

    expect(
      summarizeParticipant({
        participantId: "participant-1",
        conversationId: "conv-1",
        engineId: "agent-codex",
        role: "primary",
        capabilities: ["chat", "terminal"],
        activeSessionIds: ["session-1"]
      })
    ).toMatchObject({
      label: "agent-codex",
      role: "primary"
    });
  });
});
