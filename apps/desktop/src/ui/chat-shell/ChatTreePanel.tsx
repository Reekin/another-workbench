import { useMemo, type ReactElement } from "react";
import type { ChatTreeSnapshotRpc } from "@another-workbench/shared";

const DEPTH_GAP = 74;
const LANE_GAP = 58;
const GRAPH_PADDING_X = 26;
const GRAPH_PADDING_Y = 20;
const NODE_RADIUS = 7;
const CONNECTOR_CURVE_OFFSET = 24;

type GraphNode = {
  node: ChatTreeSnapshotRpc["nodes"][number];
  lane: number;
  depth: number;
  isCurrent: boolean;
};

type GraphEdge = {
  fromNodeId: string;
  toNodeId: string;
};

type GraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  laneCount: number;
  depthCount: number;
};

export type ChatTreePanelProps = {
  chatTree?: ChatTreeSnapshotRpc;
  loading?: boolean;
  error?: string;
  onJump?: (nodeId: string) => void;
};

const compareByOrder = (
  left: ChatTreeSnapshotRpc["nodes"][number],
  right: ChatTreeSnapshotRpc["nodes"][number]
): number => {
  const orderDelta = left.order - right.order;
  if (orderDelta !== 0) {
    return orderDelta;
  }
  return left.nodeId.localeCompare(right.nodeId);
};

const laneX = (lane: number): number => GRAPH_PADDING_X + lane * LANE_GAP;

const depthY = (depth: number): number => GRAPH_PADDING_Y + depth * DEPTH_GAP;

const shortLabel = (node: ChatTreeSnapshotRpc["nodes"][number]): string => {
  const value = node.label || node.turnId || node.nodeId;
  return value.length > 48 ? `${value.slice(0, 48)}...` : value;
};

const buildGraphLayout = (chatTree: ChatTreeSnapshotRpc | undefined): GraphLayout => {
  const orderedNodes = [...(chatTree?.nodes ?? [])].sort(compareByOrder);
  if (orderedNodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      laneCount: 0,
      depthCount: 0
    };
  }

  const nodeById = new Map(orderedNodes.map((node) => [node.nodeId, node] as const));
  const childrenByParent = new Map<string, ChatTreeSnapshotRpc["nodes"]>();
  const roots: ChatTreeSnapshotRpc["nodes"] = [];

  for (const node of orderedNodes) {
    if (node.parentNodeId && nodeById.has(node.parentNodeId)) {
      const siblings = childrenByParent.get(node.parentNodeId) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parentNodeId, siblings);
      continue;
    }
    roots.push(node);
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareByOrder);
  }
  roots.sort(compareByOrder);

  const subtreeWidthById = new Map<string, number>();
  const measureWidth = (nodeId: string): number => {
    const cached = subtreeWidthById.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    const children = childrenByParent.get(nodeId) ?? [];
    const width =
      children.length === 0
        ? 1
        : children.reduce((total, child) => total + measureWidth(child.nodeId), 0);
    subtreeWidthById.set(nodeId, width);
    return width;
  };

  const graphNodeById = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let maxDepth = 0;
  let laneCursor = 0;

  const assignNode = (
    node: ChatTreeSnapshotRpc["nodes"][number],
    startLane: number,
    depth: number
  ): void => {
    const children = childrenByParent.get(node.nodeId) ?? [];
    maxDepth = Math.max(maxDepth, depth);

    let lane = startLane;
    if (children.length > 0) {
      let childLaneStart = startLane;
      const childCenters: number[] = [];
      for (const child of children) {
        assignNode(child, childLaneStart, depth + 1);
        const childGraphNode = graphNodeById.get(child.nodeId);
        if (childGraphNode) {
          childCenters.push(childGraphNode.lane);
        }
        childLaneStart += measureWidth(child.nodeId);
        edges.push({
          fromNodeId: node.nodeId,
          toNodeId: child.nodeId
        });
      }
      if (childCenters.length > 0) {
        lane = (childCenters[0]! + childCenters[childCenters.length - 1]!) / 2;
      }
    }

    graphNodeById.set(node.nodeId, {
      node,
      lane,
      depth,
      isCurrent: chatTree?.currentNodeId === node.nodeId
    });
  };

  for (const root of roots) {
    assignNode(root, laneCursor, 0);
    laneCursor += measureWidth(root.nodeId);
  }

  return {
    nodes: [...graphNodeById.values()].sort((left, right) => {
      const depthDelta = left.depth - right.depth;
      if (depthDelta !== 0) {
        return depthDelta;
      }
      const laneDelta = left.lane - right.lane;
      if (laneDelta !== 0) {
        return laneDelta;
      }
      return compareByOrder(left.node, right.node);
    }),
    edges,
    laneCount: Math.max(1, laneCursor),
    depthCount: maxDepth + 1
  };
};

export const ChatTreePanel = ({
  chatTree,
  loading = false,
  error,
  onJump
}: ChatTreePanelProps): ReactElement => {
  const graph = useMemo(() => buildGraphLayout(chatTree), [chatTree]);
  const graphNodeById = useMemo(
    () => new Map(graph.nodes.map((entry) => [entry.node.nodeId, entry] as const)),
    [graph.nodes]
  );
  const graphWidth =
    graph.laneCount > 0
      ? GRAPH_PADDING_X * 2 + Math.max(0, graph.laneCount - 1) * LANE_GAP
      : GRAPH_PADDING_X * 2;
  const graphHeight =
    graph.depthCount > 0
      ? GRAPH_PADDING_Y * 2 + Math.max(0, graph.depthCount - 1) * DEPTH_GAP
      : GRAPH_PADDING_Y * 2;

  if (loading) {
    return <p className="awb-detail__empty">Loading chat tree…</p>;
  }

  if (error) {
    return <p className="awb-detail__empty">{error}</p>;
  }

  if (!chatTree) {
    return <p className="awb-detail__empty">Select a session to inspect its chat tree.</p>;
  }

  if (!chatTree.supportsJump || chatTree.nodes.length === 0) {
    return (
      <div className="awb-detail-card">
        <strong>Chat tree unavailable</strong>
        <p>This agent or session does not currently expose chat-tree data.</p>
      </div>
    );
  }

  return (
    <div className="awb-chat-tree">
      <div className="awb-chat-tree__graph-shell">
        <div
          className="awb-chat-tree__graph-canvas"
          style={{
            minWidth: `${graphWidth}px`,
            minHeight: `${graphHeight}px`
          }}
        >
          <svg
            className="awb-chat-tree__graph-svg"
            width={graphWidth}
            height={graphHeight}
            viewBox={`0 0 ${graphWidth} ${graphHeight}`}
            aria-hidden="true"
          >
            {graph.edges.map((edge) => {
              const fromNode = graphNodeById.get(edge.fromNodeId);
              const toNode = graphNodeById.get(edge.toNodeId);
              if (!fromNode || !toNode) {
                return null;
              }

              const fromX = laneX(fromNode.lane);
              const fromY = depthY(fromNode.depth);
              const toX = laneX(toNode.lane);
              const toY = depthY(toNode.depth);
              const verticalGap = toY - fromY;
              const splitY = fromY + Math.min(verticalGap * 0.5, CONNECTOR_CURVE_OFFSET);
              const path =
                Math.abs(fromX - toX) < 0.5
                  ? `M ${fromX} ${fromY + NODE_RADIUS} L ${toX} ${toY - NODE_RADIUS}`
                  : `M ${fromX} ${fromY + NODE_RADIUS} C ${fromX} ${splitY} ${toX} ${splitY} ${toX} ${toY - NODE_RADIUS}`;

              return (
                <path
                  key={`${edge.fromNodeId}->${edge.toNodeId}`}
                  className="awb-chat-tree__graph-connector"
                  d={path}
                />
              );
            })}
          </svg>
          {graph.nodes.map((entry) => (
            <button
              key={entry.node.nodeId}
              type="button"
              className={`awb-chat-tree__graph-node${entry.isCurrent ? " is-current" : ""}`}
              style={{
                left: `${laneX(entry.lane)}px`,
                top: `${depthY(entry.depth)}px`
              }}
              onDoubleClick={() => onJump?.(entry.node.nodeId)}
              title={`${shortLabel(entry.node)}${
                entry.isCurrent ? "\nCurrent branch." : "\nDouble-click to switch."
              }`}
              aria-label={shortLabel(entry.node)}
            >
              <span className="awb-chat-tree__graph-node-dot" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
