import type {
  ApprovalRequest,
  MessageBlock,
  MessageRole,
  TerminalStream,
  ToolCall,
  Turn
} from "@another-workbench/shared";
import { selectMessageBlocksForMessage } from "../../store/selectors.js";
import type { RendererStoreState } from "../../store/types.js";
import {
  buildParticipantDirectory,
  type ParticipantDirectory,
  type ParticipantIdentity,
  resolveParticipantIdentity
} from "./participant-directory.js";

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

const uniqueById = <T>(items: T[], getId: (item: T) => string): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = getId(item);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(item);
  }
  return result;
};

const sortByStartTime = <T extends { startedAt?: string }>(
  items: T[],
  getStableId: (item: T) => string
): T[] =>
  [...items].sort((left, right) => {
    const byDate = compareIsoDateAsc(left.startedAt, right.startedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return getStableId(left).localeCompare(getStableId(right));
  });

const selectMessageBlocksForTurn = (
  state: RendererStoreState,
  turn: Turn
): MessageBlock[] => {
  const fromMessageRefs = turn.messageIds.flatMap((messageId) =>
    selectMessageBlocksForMessage(state, messageId)
  );
  const fromTurnScan = Object.values(state.entities.messageBlocks).filter(
    (block) => block.turnId === turn.turnId
  );

  return sortByStartTime(
    uniqueById([...fromMessageRefs, ...fromTurnScan], (block) => block.blockId),
    (block) => block.blockId
  );
};

const selectToolCallsForTurn = (
  state: RendererStoreState,
  turn: Turn
): ToolCall[] => {
  const byTurnOrder = turn.toolCallIds
    .map((toolCallId) => state.entities.toolCalls[toolCallId])
    .filter((item): item is ToolCall => Boolean(item));
  const fallback = Object.values(state.entities.toolCalls).filter(
    (item) => item.turnId === turn.turnId && !turn.toolCallIds.includes(item.toolCallId)
  );
  return [...byTurnOrder, ...sortByStartTime(fallback, (item) => item.toolCallId)];
};

const selectTerminalStreamsForTurn = (
  state: RendererStoreState,
  turn: Turn
): TerminalStream[] => {
  const byTurnOrder = turn.terminalIds
    .map((terminalId) => state.entities.terminalStreams[terminalId])
    .filter((item): item is TerminalStream => Boolean(item));
  const fallback = Object.values(state.entities.terminalStreams).filter(
    (item) => item.turnId === turn.turnId && !turn.terminalIds.includes(item.terminalId)
  );
  return [...byTurnOrder, ...sortByStartTime(fallback, (item) => item.terminalId)];
};

const selectApprovalRequestsForTurn = (
  state: RendererStoreState,
  turn: Turn
): ApprovalRequest[] => {
  const byTurnOrder = turn.approvalRequestIds
    .map((requestId) => state.entities.approvalRequests[requestId])
    .filter((item): item is ApprovalRequest => Boolean(item));
  const fallback = Object.values(state.entities.approvalRequests).filter(
    (item) => item.turnId === turn.turnId && !turn.approvalRequestIds.includes(item.requestId)
  );
  const sortedFallback = [...fallback].sort((left, right) => {
    const byDate = compareIsoDateAsc(left.requestedAt, right.requestedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.requestId.localeCompare(right.requestId);
  });
  return [...byTurnOrder, ...sortedFallback];
};

const sortTurnsForTranscript = (turns: Turn[]): Turn[] =>
  [...turns].sort((left, right) => {
    const byDate = compareIsoDateAsc(left.startedAt, right.startedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.turnId.localeCompare(right.turnId);
  });

const splitBlocksByRole = (
  blocks: MessageBlock[]
): Array<{ role: MessageRole; blocks: MessageBlock[] }> => {
  const groups: Array<{ role: MessageRole; blocks: MessageBlock[] }> = [];

  for (const block of blocks) {
    const current = groups.at(-1);
    if (!current || current.role !== block.role) {
      groups.push({
        role: block.role,
        blocks: [block]
      });
      continue;
    }
    current.blocks.push(block);
  }

  return groups;
};

const resolveTurnIdentity = (
  participantDirectory: ParticipantDirectory,
  messageRole: MessageRole,
  turn: Turn,
  blocks: MessageBlock[],
  toolCalls: ToolCall[],
  terminalStreams: TerminalStream[],
  approvals: ApprovalRequest[]
): ParticipantIdentity => {
  const actor =
    turn.actor ??
    blocks.find((block) => block.actor)?.actor ??
    toolCalls.find((toolCall) => toolCall.actor)?.actor ??
    terminalStreams.find((stream) => stream.actor)?.actor ??
    approvals.find((approval) => approval.actor)?.actor;

  return resolveParticipantIdentity(participantDirectory, actor, messageRole);
};

export type TurnTranscriptRow = {
  rowId: string;
  turn: Turn;
  turnIdentity: ParticipantIdentity;
  messageRole: MessageRole;
  blocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  approvals: ApprovalRequest[];
  hasProcessDetails: boolean;
  defaultProcessExpanded: boolean;
};

export const buildTurnTranscriptRows = (
  state: RendererStoreState,
  turns: Turn[],
  participantDirectory = buildParticipantDirectory([])
): TurnTranscriptRow[] =>
  sortTurnsForTranscript(turns).flatMap((turn) => {
    const blocks = selectMessageBlocksForTurn(state, turn);
    const toolCalls = selectToolCallsForTurn(state, turn);
    const terminalStreams = selectTerminalStreamsForTurn(state, turn);
    const approvals = selectApprovalRequestsForTurn(state, turn);

    const blockGroups = splitBlocksByRole(blocks);
    const hasProcessDetails =
      toolCalls.length > 0 || terminalStreams.length > 0 || approvals.length > 0;

    if (blockGroups.length === 0) {
      return [
        {
          rowId: `${turn.turnId}:assistant:0`,
          turn,
          turnIdentity: resolveTurnIdentity(
            participantDirectory,
            "assistant",
            turn,
            blocks,
            toolCalls,
            terminalStreams,
            approvals
          ),
          messageRole: "assistant" as const,
          blocks,
          toolCalls,
          terminalStreams,
          approvals,
          hasProcessDetails,
          defaultProcessExpanded: turn.status !== "completed"
        }
      ];
    }

    return blockGroups.map((group, index) => {
      const isAssistantLike = group.role !== "user";
      return {
        rowId: `${turn.turnId}:${group.role}:${index}`,
        turn,
        turnIdentity: resolveTurnIdentity(
          participantDirectory,
          group.role,
          turn,
          group.blocks,
          isAssistantLike ? toolCalls : [],
          isAssistantLike ? terminalStreams : [],
          isAssistantLike ? approvals : []
        ),
        messageRole: group.role,
        blocks: group.blocks,
        toolCalls: isAssistantLike ? toolCalls : [],
        terminalStreams: isAssistantLike ? terminalStreams : [],
        approvals: isAssistantLike ? approvals : [],
        hasProcessDetails: isAssistantLike && hasProcessDetails,
        defaultProcessExpanded: isAssistantLike && turn.status !== "completed"
      };
    });
  });
