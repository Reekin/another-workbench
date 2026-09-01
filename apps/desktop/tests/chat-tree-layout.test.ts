import { describe, expect, it } from "vitest";
import type { ChatTreeSnapshotRpc } from "@another-workbench/shared";
import { buildChatTreeGraphLayout } from "../src/ui/chat-shell/chat-tree-layout.js";

const snapshot = (
  nodes: ChatTreeSnapshotRpc["nodes"]
): ChatTreeSnapshotRpc => ({
  sessionId: "session-tree-layout",
  engineId: "codex",
  supportsJump: true,
  nodes,
  fetchedAt: "2026-09-01T00:00:00Z"
});

describe("buildChatTreeGraphLayout", () => {
  it("keeps shallow siblings close when only one subtree branches deeply", () => {
    const graph = buildChatTreeGraphLayout(
      snapshot([
        { nodeId: "root", label: "root", order: 0, isCurrent: false },
        {
          nodeId: "short",
          parentNodeId: "root",
          label: "short",
          order: 1,
          isCurrent: false
        },
        {
          nodeId: "deep",
          parentNodeId: "root",
          label: "deep",
          order: 2,
          isCurrent: false
        },
        {
          nodeId: "trunk",
          parentNodeId: "deep",
          label: "trunk",
          order: 3,
          isCurrent: false
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          nodeId: `leaf-${index}`,
          parentNodeId: "trunk",
          label: `leaf ${index}`,
          order: index + 4,
          isCurrent: false
        }))
      ])
    );

    const byId = new Map(graph.nodes.map((entry) => [entry.node.nodeId, entry]));
    expect(Math.abs(byId.get("short")!.x - byId.get("deep")!.x)).toBe(34);
    expect(graph.width).toBeLessThan(8 * 58);
  });

  it("preserves order and keeps nodes separated at every shared depth", () => {
    const graph = buildChatTreeGraphLayout(
      snapshot([
        { nodeId: "root", label: "root", order: 0, isCurrent: false },
        ...Array.from({ length: 5 }, (_, index) => ({
          nodeId: `child-${index}`,
          parentNodeId: "root",
          label: `child ${index}`,
          order: index + 1,
          isCurrent: false
        }))
      ])
    );
    const children = graph.nodes
      .filter((entry) => entry.depth === 1)
      .sort((left, right) => left.x - right.x);

    expect(children.map((entry) => entry.node.nodeId)).toEqual([
      "child-0",
      "child-1",
      "child-2",
      "child-3",
      "child-4"
    ]);
    expect(
      children.slice(1).every((entry, index) => entry.x - children[index]!.x >= 34)
    ).toBe(true);
  });
});
