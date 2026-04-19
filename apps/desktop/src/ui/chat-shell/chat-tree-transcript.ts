import type { ChatTreeSnapshotRpc } from "@another-workbench/shared";
import type { TurnTranscriptRow } from "./transcript-view-model.js";

const resolveVisibleTurnIds = (
  chatTree: ChatTreeSnapshotRpc | undefined
): Set<string> | undefined => {
  if (!chatTree?.supportsJump || !chatTree.currentNodeId || chatTree.nodes.length === 0) {
    return undefined;
  }

  const nodesById = new Map(chatTree.nodes.map((node) => [node.nodeId, node] as const));
  const visibleTurnIds = new Set<string>();
  let currentNodeId: string | undefined = chatTree.currentNodeId;

  while (currentNodeId) {
    const node = nodesById.get(currentNodeId);
    if (!node) {
      break;
    }
    if (node.turnId) {
      visibleTurnIds.add(node.turnId);
    }
    currentNodeId = node.parentNodeId;
  }

  return visibleTurnIds.size > 0 ? visibleTurnIds : undefined;
};

export const filterTranscriptRowsForChatTree = (
  rows: TurnTranscriptRow[],
  chatTree: ChatTreeSnapshotRpc | undefined
): TurnTranscriptRow[] => {
  const visibleTurnIds = resolveVisibleTurnIds(chatTree);
  if (!visibleTurnIds) {
    return rows;
  }

  const visibleIndexes = new Set<number>();
  rows.forEach((row, index) => {
    if (!visibleTurnIds.has(row.turn.turnId)) {
      return;
    }
    visibleIndexes.add(index);
    const previousRow = rows[index - 1];
    if (previousRow?.messageRole === "user") {
      visibleIndexes.add(index - 1);
    }
  });

  const filtered = rows.filter((_row, index) => visibleIndexes.has(index));
  return filtered.length > 0 ? filtered : rows;
};
