import { hierarchy, tree } from "d3-hierarchy";
import type { ChatTreeSnapshotRpc } from "@another-workbench/shared";

const DEPTH_GAP = 74;
const NODE_GAP = 34;
const GRAPH_PADDING_X = 26;
const GRAPH_PADDING_Y = 20;

type ChatTreeNode = ChatTreeSnapshotRpc["nodes"][number];

type LayoutDatum = {
  node?: ChatTreeNode;
  children: LayoutDatum[];
};

export type ChatTreeGraphNode = {
  node: ChatTreeNode;
  x: number;
  y: number;
  depth: number;
  isCurrent: boolean;
};

export type ChatTreeGraphEdge = {
  fromNodeId: string;
  toNodeId: string;
};

export type ChatTreeGraphLayout = {
  nodes: ChatTreeGraphNode[];
  edges: ChatTreeGraphEdge[];
  width: number;
  height: number;
};

const compareByOrder = (left: ChatTreeNode, right: ChatTreeNode): number => {
  const orderDelta = left.order - right.order;
  return orderDelta !== 0 ? orderDelta : left.nodeId.localeCompare(right.nodeId);
};

export const buildChatTreeGraphLayout = (
  chatTree: ChatTreeSnapshotRpc | undefined
): ChatTreeGraphLayout => {
  const orderedNodes = [...(chatTree?.nodes ?? [])].sort(compareByOrder);
  if (orderedNodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      width: GRAPH_PADDING_X * 2,
      height: GRAPH_PADDING_Y * 2
    };
  }

  const nodeById = new Map(orderedNodes.map((node) => [node.nodeId, node] as const));
  const childrenByParent = new Map<string, ChatTreeNode[]>();
  const roots: ChatTreeNode[] = [];

  for (const node of orderedNodes) {
    if (node.parentNodeId && nodeById.has(node.parentNodeId)) {
      const siblings = childrenByParent.get(node.parentNodeId) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parentNodeId, siblings);
    } else {
      roots.push(node);
    }
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareByOrder);
  }
  roots.sort(compareByOrder);

  const toLayoutDatum = (node: ChatTreeNode): LayoutDatum => ({
    node,
    children: (childrenByParent.get(node.nodeId) ?? []).map(toLayoutDatum)
  });
  const syntheticRoot: LayoutDatum = {
    children: roots.map(toLayoutDatum)
  };
  const hierarchyRoot = hierarchy(
    syntheticRoot,
    (datum) => datum.children
  );
  const positionedRoot = tree<LayoutDatum>()
    .nodeSize([NODE_GAP, DEPTH_GAP])
    .separation(() => 1)(hierarchyRoot);

  const positionedNodes = positionedRoot
    .descendants()
    .filter((entry) => entry.data.node !== undefined);
  const minX = Math.min(...positionedNodes.map((entry) => entry.x));
  const maxX = Math.max(...positionedNodes.map((entry) => entry.x));
  let maxDepth = 0;

  const nodes = positionedNodes.map((entry): ChatTreeGraphNode => {
    const node = entry.data.node!;
    const depth = entry.depth - 1;
    maxDepth = Math.max(maxDepth, depth);
    return {
      node,
      x: GRAPH_PADDING_X + entry.x - minX,
      y: GRAPH_PADDING_Y + depth * DEPTH_GAP,
      depth,
      isCurrent: chatTree?.currentNodeId === node.nodeId
    };
  });
  const edges = positionedNodes.flatMap((entry): ChatTreeGraphEdge[] => {
    const node = entry.data.node!;
    const parentNode = entry.parent?.data.node;
    return parentNode
      ? [{ fromNodeId: parentNode.nodeId, toNodeId: node.nodeId }]
      : [];
  });

  nodes.sort((left, right) => {
    const depthDelta = left.depth - right.depth;
    if (depthDelta !== 0) {
      return depthDelta;
    }
    const xDelta = left.x - right.x;
    return xDelta !== 0 ? xDelta : compareByOrder(left.node, right.node);
  });

  return {
    nodes,
    edges,
    width: GRAPH_PADDING_X * 2 + maxX - minX,
    height: GRAPH_PADDING_Y * 2 + maxDepth * DEPTH_GAP
  };
};
