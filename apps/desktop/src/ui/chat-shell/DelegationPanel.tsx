import { useMemo, type CSSProperties, type ReactElement } from "react";
import type { DelegationSnapshotRpc } from "@another-workbench/shared";

export type DelegationPanelProps = {
  delegation?: DelegationSnapshotRpc;
  loading?: boolean;
  error?: string;
};

type DelegationRow = {
  node: DelegationSnapshotRpc["nodes"][number];
  depth: number;
  isCurrent: boolean;
};

const compareNodeOrder = (
  left: DelegationSnapshotRpc["nodes"][number],
  right: DelegationSnapshotRpc["nodes"][number]
): number => left.label.localeCompare(right.label);

const buildRows = (
  delegation: DelegationSnapshotRpc | undefined
): DelegationRow[] => {
  const nodes = delegation?.nodes ?? [];
  if (nodes.length === 0) {
    return [];
  }
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node] as const));
  const childrenByParent = new Map<string, DelegationSnapshotRpc["nodes"]>();
  const roots: DelegationSnapshotRpc["nodes"] = [];

  for (const node of nodes) {
    if (node.parentNodeId && nodesById.has(node.parentNodeId)) {
      const children = childrenByParent.get(node.parentNodeId) ?? [];
      children.push(node);
      childrenByParent.set(node.parentNodeId, children);
      continue;
    }
    roots.push(node);
  }

  for (const children of childrenByParent.values()) {
    children.sort(compareNodeOrder);
  }
  roots.sort(compareNodeOrder);

  const rows: DelegationRow[] = [];
  const visit = (
    node: DelegationSnapshotRpc["nodes"][number],
    depth: number
  ): void => {
    rows.push({
      node,
      depth,
      isCurrent: delegation?.currentActiveNodeId === node.nodeId
    });
    for (const child of childrenByParent.get(node.nodeId) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }

  return rows;
};

const formatStatus = (
  status: DelegationSnapshotRpc["nodes"][number]["status"]
): string => {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Pending";
  }
};

export const DelegationPanel = ({
  delegation,
  loading = false,
  error
}: DelegationPanelProps): ReactElement => {
  const rows = useMemo(() => buildRows(delegation), [delegation]);

  if (loading) {
    return <p className="awb-detail__empty">Loading delegation…</p>;
  }

  if (error) {
    return <p className="awb-detail__empty">{error}</p>;
  }

  if (!delegation) {
    return <p className="awb-detail__empty">Select a session to inspect delegation.</p>;
  }

  if (!delegation.supported || delegation.nodes.length === 0) {
    return (
      <div className="awb-detail-card">
        <strong>Delegation unavailable</strong>
        <p>This agent or session does not currently expose delegation data.</p>
      </div>
    );
  }

  return (
    <div className="awb-delegation">
      <div className="awb-delegation__header">
        <strong>Delegation</strong>
        <span>{delegation.supportsControl ? "Interactive" : "Read only"}</span>
      </div>
      <ol className="awb-delegation__list">
        {rows.map((row) => (
          <li
            key={row.node.nodeId}
            className={`awb-delegation__item${row.isCurrent ? " is-current" : ""}`}
            style={
              {
                "--awb-delegation-depth": String(row.depth)
              } as CSSProperties
            }
          >
            <div className="awb-delegation__line">
              <span className="awb-delegation__title">{row.node.label}</span>
              <span
                className={`awb-delegation__status awb-delegation__status--${row.node.status}`}
              >
                {formatStatus(row.node.status)}
              </span>
            </div>
            {row.node.summary ? (
              <p className="awb-delegation__summary">{row.node.summary}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
};
