import { describe, expect, it } from "vitest";
import { prioritizeWorkspaceIdsForReconciliation } from "../src/ui/chat-shell/workspace-reconciliation.js";

describe("prioritizeWorkspaceIdsForReconciliation", () => {
  it("prioritizes the active workspace and keeps the remaining order stable", () => {
    const ordered = prioritizeWorkspaceIdsForReconciliation(
      [
        {
          workspaceId: "workspace-a",
          label: "A",
          absolutePath: "I:\\a"
        },
        {
          workspaceId: "workspace-b",
          label: "B",
          absolutePath: "I:\\b"
        },
        {
          workspaceId: "workspace-c",
          label: "C",
          absolutePath: "I:\\c"
        }
      ],
      "workspace-b"
    );

    expect(ordered).toEqual(["workspace-b", "workspace-a", "workspace-c"]);
  });

  it("falls back to registry order when there is no active workspace", () => {
    const ordered = prioritizeWorkspaceIdsForReconciliation([
      {
        workspaceId: "workspace-a",
        label: "A",
        absolutePath: "I:\\a"
      },
      {
        workspaceId: "workspace-b",
        label: "B",
        absolutePath: "I:\\b"
      }
    ]);

    expect(ordered).toEqual(["workspace-a", "workspace-b"]);
  });
});
