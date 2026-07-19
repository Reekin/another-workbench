import type { ChatTreeSnapshotRpc, Turn } from "@another-workbench/shared";
import type { TurnTranscriptRow } from "./transcript-view-model.js";

const resolveVisibleTurnIds = (
  chatTree: ChatTreeSnapshotRpc | undefined
): Set<string> | undefined => {
  if (!chatTree?.supportsJump) {
    return undefined;
  }

  if (chatTree.visibleTurnIds && chatTree.visibleTurnIds.length > 0) {
    return new Set(chatTree.visibleTurnIds);
  }

  if (!chatTree.currentNodeId || chatTree.nodes.length === 0) {
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

const isTurnVisibleForChatTree = (
  turn: Pick<Turn, "turnId" | "status">,
  visibleTurnIds: Set<string>,
  knownTurnIds: Set<string>
): boolean =>
  visibleTurnIds.has(turn.turnId) ||
  (turn.status !== "completed" && !knownTurnIds.has(turn.turnId));

export const filterComposerTurnsForChatTree = (
  turns: Turn[],
  chatTree: ChatTreeSnapshotRpc | undefined
): Turn[] => {
  const visibleTurnIds = resolveVisibleTurnIds(chatTree);
  if (!visibleTurnIds) {
    return turns;
  }
  return turns.filter((turn) => visibleTurnIds.has(turn.turnId));
};

export const filterTranscriptRowsForChatTree = (
  rows: TurnTranscriptRow[],
  chatTree: ChatTreeSnapshotRpc | undefined
): TurnTranscriptRow[] => {
  const visibleTurnIds = resolveVisibleTurnIds(chatTree);
  if (!visibleTurnIds) {
    return rows;
  }

  const knownTurnIds = new Set(
    chatTree?.nodes.flatMap((node) => (node.turnId ? [node.turnId] : [])) ?? []
  );

  return rows.filter((row) =>
    isTurnVisibleForChatTree(row.turn, visibleTurnIds, knownTurnIds)
  );
};
