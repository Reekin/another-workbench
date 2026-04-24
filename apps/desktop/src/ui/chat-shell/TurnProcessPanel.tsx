import type { ExtractedFileReference } from "@another-workbench/shared";
import type { ReactElement } from "react";
import type { ImageLightboxState } from "./ImageLightbox.js";
import { MessageMarkdownView } from "./MessageMarkdownView.js";
import type { ParticipantDirectory } from "./participant-directory.js";
import { ParticipantIdentityBadge } from "./ParticipantIdentityBadge.js";
import type { TurnTranscriptRow } from "./transcript-view-model.js";
import { ApprovalFlowView, type ApprovalAction } from "./ApprovalFlowView.js";
import { TerminalStreamView } from "./TerminalStreamView.js";
import { ToolTimelineView } from "./ToolTimelineView.js";

export type TurnProcessPanelProps = {
  row: TurnTranscriptRow;
  hiddenRows?: TurnTranscriptRow[];
  participantDirectory: ParticipantDirectory;
  onActivateResourceLink: (reference: ExtractedFileReference) => void;
  onPreviewImage?: (input: ImageLightboxState) => void;
  onRespondApproval?: (input: {
    sessionId: string;
    requestId: string;
    action: ApprovalAction;
  }) => Promise<void>;
};

export const TurnProcessPanel = ({
  row,
  hiddenRows = [],
  participantDirectory,
  onActivateResourceLink,
  onPreviewImage,
  onRespondApproval
}: TurnProcessPanelProps): ReactElement => (
  <div className="awb-turn-process">
    {hiddenRows.length > 0 && (
      <section className="awb-turn-process__section">
        <header className="awb-turn-process__section-header">
          <h4>Earlier in this turn</h4>
          <span>{hiddenRows.length}</span>
        </header>
        <div className="awb-turn-process__history">
          {hiddenRows.map((hiddenRow) => (
            <article
              key={hiddenRow.rowId}
              className={`awb-turn-process__history-entry ${
                hiddenRow.messageRole === "user" ? "is-user" : "is-assistant"
              }`}
            >
              <header className="awb-turn-process__history-identity">
                <ParticipantIdentityBadge identity={hiddenRow.turnIdentity} compact />
              </header>
              <div className="awb-turn-process__history-messages">
                {hiddenRow.blocks.map((block) => (
                  <MessageMarkdownView
                    key={block.blockId}
                    block={block}
                    onActivateResourceLink={onActivateResourceLink}
                    onPreviewImage={onPreviewImage}
                  />
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
    )}

    {row.toolCalls.length > 0 && (
      <section className="awb-turn-process__section">
        <header className="awb-turn-process__section-header">
          <h4>Tool activity</h4>
          <span>{row.toolCalls.length}</span>
        </header>
        <ToolTimelineView
          toolCalls={row.toolCalls}
          participantDirectory={participantDirectory}
        />
      </section>
    )}

    {row.terminalStreams.length > 0 && (
      <section className="awb-turn-process__section">
        <header className="awb-turn-process__section-header">
          <h4>Terminal streams</h4>
          <span>{row.terminalStreams.length}</span>
        </header>
        <TerminalStreamView
          terminalStreams={row.terminalStreams}
          participantDirectory={participantDirectory}
        />
      </section>
    )}

    {row.approvals.length > 0 && (
      <section className="awb-turn-process__section">
        <header className="awb-turn-process__section-header">
          <h4>Approval requests</h4>
          <span>{row.approvals.length}</span>
        </header>
        <ApprovalFlowView
          approvals={row.approvals}
          participantDirectory={participantDirectory}
          onRespond={onRespondApproval}
        />
      </section>
    )}
  </div>
);
