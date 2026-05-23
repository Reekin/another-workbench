import type { ExtractedFileReference } from "@another-workbench/shared";
import { Fragment, type ReactElement } from "react";
import type { ImageLightboxState } from "./ImageLightbox.js";
import { MessageMarkdownView } from "./MessageMarkdownView.js";
import type { ParticipantDirectory } from "./participant-directory.js";
import type { TurnTranscriptRow } from "./transcript-view-model.js";
import { ApprovalFlowView, type ApprovalAction } from "./ApprovalFlowView.js";
import {
  InteractionFlowView,
  type InteractionResponseInput
} from "./InteractionFlowView.js";
import {
  buildProcessActivityEntries,
  ProcessActivityItemView,
  ProcessActivityView,
  type ProcessActivityEntry
} from "./ProcessActivityView.js";

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
    decision?: string | Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  onRespondInteraction?: (input: InteractionResponseInput) => Promise<void>;
};

const compareIsoDateAsc = (left?: string, right?: string): number => {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (Number.isNaN(leftDate) || Number.isNaN(rightDate)) {
    return left.localeCompare(right);
  }
  return leftDate - rightDate;
};

type TurnHistoryItem =
  | {
      kind: "message";
      id: string;
      startedAt?: string;
      row: TurnTranscriptRow;
    }
  | {
      kind: "activity";
      id: string;
      startedAt?: string;
      entry: ProcessActivityEntry;
    };

const buildTurnHistoryItems = (
  row: TurnTranscriptRow,
  hiddenRows: TurnTranscriptRow[]
): TurnHistoryItem[] =>
  [
    ...hiddenRows.map((hiddenRow) => ({
      kind: "message" as const,
      id: `message:${hiddenRow.rowId}`,
      startedAt: hiddenRow.startedAt,
      row: hiddenRow
    })),
    ...buildProcessActivityEntries(row.toolCalls, row.terminalStreams).map((entry) => ({
      kind: "activity" as const,
      id: `activity:${entry.id}`,
      startedAt: entry.startedAt,
      entry
    }))
  ].sort((left, right) => {
    const byDate = compareIsoDateAsc(left.startedAt, right.startedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.id.localeCompare(right.id);
  });

export const TurnProcessPanel = ({
  row,
  hiddenRows = [],
  participantDirectory,
  onActivateResourceLink,
  onPreviewImage,
  onRespondApproval,
  onRespondInteraction
}: TurnProcessPanelProps): ReactElement => {
  const interactions = row.interactions ?? [];
  const historyItems =
    hiddenRows.length > 0 ? buildTurnHistoryItems(row, hiddenRows) : [];
  const renderStandaloneActivity = historyItems.length === 0;

  return (
    <div className="awb-turn-process">
      {historyItems.length > 0 && (
        <section className="awb-turn-process__section awb-turn-process__section--plain">
          <header className="awb-turn-process__section-header">
            <h4>Earlier in this turn</h4>
            <span>{historyItems.length}</span>
          </header>
          <div className="awb-turn-process__history">
            {historyItems.map((item) =>
              item.kind === "activity" ? (
                <ProcessActivityItemView
                  key={item.id}
                  entry={item.entry}
                  onPreviewImage={onPreviewImage}
                />
              ) : (
                <Fragment key={item.row.rowId}>
                  {item.row.blocks.map((block) => (
                    <MessageMarkdownView
                      key={block.blockId}
                      block={block}
                      onActivateResourceLink={onActivateResourceLink}
                      onPreviewImage={onPreviewImage}
                    />
                  ))}
                </Fragment>
              )
            )}
          </div>
        </section>
      )}

      {renderStandaloneActivity &&
        (row.toolCalls.length > 0 || row.terminalStreams.length > 0) && (
          <ProcessActivityView
            toolCalls={row.toolCalls}
            terminalStreams={row.terminalStreams}
            onPreviewImage={onPreviewImage}
          />
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

      {interactions.length > 0 && (
        <section className="awb-turn-process__section">
          <header className="awb-turn-process__section-header">
            <h4>Interaction requests</h4>
            <span>{interactions.length}</span>
          </header>
          <InteractionFlowView
            interactions={interactions}
            participantDirectory={participantDirectory}
            onRespond={onRespondInteraction}
          />
        </section>
      )}
    </div>
  );
};
