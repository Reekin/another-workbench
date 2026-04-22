import { describe, expect, it } from "vitest";
import { resolveSlashSuggestionItems } from "../src/ui/chat-shell/composer/composer-suggestions.js";

describe("resolveSlashSuggestionItems", () => {
  it("builds slash items from server-returned capabilities plus local session actions", () => {
    expect(
      resolveSlashSuggestionItems({
        capabilities: {
          supportsSteer: true,
          supportsAttachments: true,
          slashSuggestions: [
            {
              id: "status",
              label: "/status",
              detail: "Summarize the current session state",
              replacement:
                "Summarize the current session status and the next best action."
            },
            {
              id: "delegation",
              label: "/delegation",
              detail: "Explain the current delegation tree",
              replacement:
                "Summarize the current delegation tree and identify blocked or waiting nodes.",
              sourceCapability: "delegation"
            }
          ]
        },
        query: "",
        canCreateSession: true,
        canResumeSession: true,
        canInterrupt: true
      })
    ).toEqual([
      {
        id: "slash:resume-session",
        kind: "slash",
        label: "/resume",
        detail: "Reload the current thread window",
        action: "resume-session"
      },
      {
        id: "slash:create-session",
        kind: "slash",
        label: "/new",
        detail: "Create a new session in the active workspace",
        action: "create-session"
      },
      {
        id: "slash:status",
        kind: "slash",
        label: "/status",
        detail: "Summarize the current session state",
        replacement:
          "Summarize the current session status and the next best action."
      },
      {
        id: "slash:delegation",
        kind: "slash",
        label: "/delegation",
        detail: "Explain the current delegation tree",
        replacement:
          "Summarize the current delegation tree and identify blocked or waiting nodes."
      },
      {
        id: "slash:interrupt",
        kind: "slash",
        label: "/interrupt",
        detail: "Interrupt the active turn",
        action: "interrupt"
      }
    ]);
  });

  it("filters by slash query and deduplicates labels", () => {
    expect(
      resolveSlashSuggestionItems({
        capabilities: {
          supportsSteer: false,
          supportsAttachments: false,
          slashSuggestions: [
            {
              id: "status-primary",
              label: "/status",
              detail: "Primary status detail",
              replacement: "primary"
            },
            {
              id: "status-duplicate",
              label: "/status",
              detail: "Duplicate status detail",
              replacement: "duplicate"
            },
            {
              id: "worktree",
              label: "/worktree",
              detail: "Summarize branch and rollout context",
              replacement: "Summarize the current worktree, branch, and rollout context.",
              sourceCapability: "worktree"
            }
          ]
        },
        query: "wor",
        canCreateSession: false,
        canResumeSession: false,
        canInterrupt: false
      })
    ).toEqual([
      {
        id: "slash:worktree",
        kind: "slash",
        label: "/worktree",
        detail: "Summarize branch and rollout context",
        replacement: "Summarize the current worktree, branch, and rollout context."
      }
    ]);
  });
});
