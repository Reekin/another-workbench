import type { ReactElement } from "react";
import type { ToolCall } from "@another-workbench/shared";
import { ParticipantIdentityBadge } from "./ParticipantIdentityBadge.js";
import {
  buildParticipantDirectory,
  type ParticipantDirectory,
  resolveParticipantIdentity
} from "./participant-directory.js";

export type ToolTimelineViewProps = {
  toolCalls: ToolCall[];
  participantDirectory?: ParticipantDirectory;
};

const defaultDirectory = buildParticipantDirectory([]);

const statusLabel = (status: ToolCall["status"]): string => {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
};

export const ToolTimelineView = ({
  toolCalls,
  participantDirectory = defaultDirectory
}: ToolTimelineViewProps): ReactElement => {
  if (toolCalls.length === 0) {
    return <p className="awb-detail__empty">No tool call in this turn.</p>;
  }

  return (
    <div className="awb-tool-timeline">
      {toolCalls.map((toolCall) => {
        const identity = resolveParticipantIdentity(
          participantDirectory,
          toolCall.actor,
          toolCall.toolName
        );
        return (
          <article key={toolCall.toolCallId} className="awb-timeline-item awb-tool-item">
            <header className="awb-timeline-item__header">
              <div className="awb-timeline-item__meta">
                <strong>{toolCall.toolName}</strong>
                <ParticipantIdentityBadge identity={identity} compact />
              </div>
              <span className={`awb-badge is-${toolCall.status}`}>
                {statusLabel(toolCall.status)}
              </span>
            </header>

            <details className="awb-timeline-item__detail" open={toolCall.status === "running"}>
              <summary>Input summary</summary>
              <pre>{toolCall.inputSummary?.trim() || "(no input summary)"}</pre>
            </details>

            <details className="awb-timeline-item__detail">
              <summary>Output summary</summary>
              <pre>{toolCall.outputSummary?.trim() || "(no output yet)"}</pre>
            </details>
          </article>
        );
      })}
    </div>
  );
};
