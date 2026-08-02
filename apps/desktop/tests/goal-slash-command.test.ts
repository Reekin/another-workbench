import { describe, expect, it } from "vitest";
import {
  goalCommandBlockedReason,
  parseGoalSlashCommand
} from "../src/ui/chat-shell/use-composer-controller.js";

const existingGoal = {
  sessionId: "session-1",
  threadId: "thread-1",
  objective: "Existing long-running goal",
  status: "active" as const,
  tokensUsed: 1,
  timeUsedSeconds: 1,
  createdAt: 1700000000000,
  updatedAt: 1700000001000
};

describe("parseGoalSlashCommand", () => {
  it("maps goal control subcommands without treating them as objectives", () => {
    expect(parseGoalSlashCommand("/goal clear")).toEqual({ kind: "clear" });
    expect(parseGoalSlashCommand("/goal pause")).toEqual({ kind: "pause" });
    expect(parseGoalSlashCommand("/goal resume")).toEqual({ kind: "resume" });
    expect(parseGoalSlashCommand("/goal edit")).toEqual({ kind: "edit" });
  });

  it("keeps arbitrary goal text as the objective", () => {
    expect(parseGoalSlashCommand("/goal ship the protocol bridge")).toEqual({
      kind: "set",
      objective: "ship the protocol bridge"
    });
    expect(parseGoalSlashCommand("/goal clear the flaky tests")).toEqual({
      kind: "set",
      objective: "clear the flaky tests"
    });
  });

  it("distinguishes empty and non-goal text", () => {
    expect(parseGoalSlashCommand("/goal")).toEqual({ kind: "empty" });
    expect(parseGoalSlashCommand("please /goal clear")).toBeUndefined();
  });

  it("blocks replacing an existing goal without an explicit clear", () => {
    const command = parseGoalSlashCommand("/goal replace the current plan");

    expect(
      goalCommandBlockedReason(command, existingGoal)
    ).toBe("A goal is already set. Use /goal clear before setting a new goal.");
    expect(goalCommandBlockedReason(command, undefined)).toBeUndefined();
    expect(
      goalCommandBlockedReason(parseGoalSlashCommand("/goal pause"), existingGoal)
    ).toBeUndefined();
  });

  it("keeps edit as a non-mutating command until an editor exists", () => {
    expect(goalCommandBlockedReason(parseGoalSlashCommand("/goal edit"))).toBe(
      "Goal editing is not available here yet. Use /goal clear before setting a new goal."
    );
  });
});
