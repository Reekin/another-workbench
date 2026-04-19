import type { ReactElement } from "react";
import type { ParticipantDirectory } from "./participant-directory.js";
import type { TurnTranscriptRow } from "./transcript-view-model.js";
import { ApprovalFlowView, type ApprovalAction } from "./ApprovalFlowView.js";
import { TerminalStreamView } from "./TerminalStreamView.js";
import { ToolTimelineView } from "./ToolTimelineView.js";

export type TurnProcessPanelProps = {
  row: TurnTranscriptRow;
  participantDirectory: ParticipantDirectory;
  onRespondApproval?: (input: {
    sessionId: string;
    requestId: string;
    action: ApprovalAction;
  }) => Promise<void>;
};

export const TurnProcessPanel = ({
  row,
  participantDirectory,
  onRespondApproval
}: TurnProcessPanelProps): ReactElement => (
  <div className="awb-turn-process">
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
