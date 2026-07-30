import type {
  ApprovalRequest,
  ExtractedFileReference,
  MessageBlock,
  RuntimeInteraction
} from "@another-workbench/shared";
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
      blocks: MessageBlock[];
    }
  | {
      kind: "activity";
      id: string;
      startedAt?: string;
      entry: ProcessActivityEntry;
    }
  | {
      kind: "approval";
      id: string;
      startedAt: string;
      approval: ApprovalRequest;
    }
  | {
      kind: "interaction";
      id: string;
      startedAt: string;
      interaction: RuntimeInteraction;
    };

const buildHiddenMessageItems = (
  hiddenRows: TurnTranscriptRow[]
): TurnHistoryItem[] => {
  const messageGroups = new Map<
    string,
    { blocks: MessageBlock[]; fallbackStartedAt?: string }
  >();

  for (const hiddenRow of hiddenRows) {
    for (const block of hiddenRow.blocks) {
      const current = messageGroups.get(block.messageId);
      if (current) {
        current.blocks.push(block);
        continue;
      }
      messageGroups.set(block.messageId, {
        blocks: [block],
        fallbackStartedAt: hiddenRow.startedAt
      });
    }
  }

  return [...messageGroups.entries()].map(([messageId, group]) => ({
    kind: "message" as const,
    id: `message:${messageId}`,
    startedAt:
      group.blocks.find((block) => block.startedAt)?.startedAt ??
      group.fallbackStartedAt,
    blocks: group.blocks
  }));
};

const buildTurnHistoryItems = (
  row: TurnTranscriptRow,
  hiddenRows: TurnTranscriptRow[]
): TurnHistoryItem[] =>
  [
    ...buildHiddenMessageItems(hiddenRows),
    ...buildProcessActivityEntries(row.toolCalls, row.terminalStreams).map((entry) => ({
      kind: "activity" as const,
      id: `activity:${entry.id}`,
      startedAt: entry.startedAt,
      entry
    })),
    ...row.approvals.map((approval) => ({
      kind: "approval" as const,
      id: `approval:${approval.requestId}`,
      startedAt: approval.requestedAt,
      approval
    })),
    ...(row.interactions ?? []).map((interaction) => ({
      kind: "interaction" as const,
      id: `interaction:${interaction.requestId}`,
      startedAt: interaction.requestedAt,
      interaction
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
            {historyItems.map((item) => {
              if (item.kind === "activity") {
                return (
                  <ProcessActivityItemView
                    key={item.id}
                    entry={item.entry}
                    onPreviewImage={onPreviewImage}
                  />
                );
              }
              if (item.kind === "approval") {
                return (
                  <ApprovalFlowView
                    key={item.id}
                    approvals={[item.approval]}
                    participantDirectory={participantDirectory}
                    onRespond={onRespondApproval}
                  />
                );
              }
              if (item.kind === "interaction") {
                return (
                  <InteractionFlowView
                    key={item.id}
                    interactions={[item.interaction]}
                    participantDirectory={participantDirectory}
                    onRespond={onRespondInteraction}
                  />
                );
              }
              return (
                <Fragment key={item.id}>
                  {item.blocks.map((block) => (
                    <MessageMarkdownView
                      key={block.blockId}
                      block={block}
                      onActivateResourceLink={onActivateResourceLink}
                      onPreviewImage={onPreviewImage}
                    />
                  ))}
                </Fragment>
              );
            })}
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

      {renderStandaloneActivity && row.approvals.length > 0 && (
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

      {renderStandaloneActivity && interactions.length > 0 && (
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
