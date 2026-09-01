import { useMemo, type ReactElement } from "react";
import type { ChatTreeSnapshotRpc } from "@another-workbench/shared";
import { buildChatTreeGraphLayout } from "./chat-tree-layout.js";

const NODE_RADIUS = 7;
const CONNECTOR_CURVE_OFFSET = 24;

export type ChatTreePanelProps = {
  chatTree?: ChatTreeSnapshotRpc;
  loading?: boolean;
  error?: string;
  onJump?: (nodeId: string) => void;
};

const shortLabel = (node: ChatTreeSnapshotRpc["nodes"][number]): string => {
  const value = node.label || node.turnId || node.nodeId;
  return value.length > 48 ? `${value.slice(0, 48)}...` : value;
};

export const ChatTreePanel = ({
  chatTree,
  loading = false,
  error,
  onJump
}: ChatTreePanelProps): ReactElement => {
  const graph = useMemo(() => buildChatTreeGraphLayout(chatTree), [chatTree]);
  const graphNodeById = useMemo(
    () => new Map(graph.nodes.map((entry) => [entry.node.nodeId, entry] as const)),
    [graph.nodes]
  );

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
            minWidth: `${graph.width}px`,
            minHeight: `${graph.height}px`
          }}
        >
          <svg
            className="awb-chat-tree__graph-svg"
            width={graph.width}
            height={graph.height}
            viewBox={`0 0 ${graph.width} ${graph.height}`}
            aria-hidden="true"
          >
            {graph.edges.map((edge) => {
              const fromNode = graphNodeById.get(edge.fromNodeId);
              const toNode = graphNodeById.get(edge.toNodeId);
              if (!fromNode || !toNode) {
                return null;
              }

              const fromX = fromNode.x;
              const fromY = fromNode.y;
              const toX = toNode.x;
              const toY = toNode.y;
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
                left: `${entry.x}px`,
                top: `${entry.y}px`
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
