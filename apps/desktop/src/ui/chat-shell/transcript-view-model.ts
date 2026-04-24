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

const groupByTurnId = <T extends { turnId: string }>(
  items: Iterable<T>
): Record<string, T[]> => {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    (result[item.turnId] ??= []).push(item);
  }
  return result;
};

type TranscriptEntityIndexes = {
  messageBlocksByTurnId: Record<string, MessageBlock[]>;
  toolCallsByTurnId: Record<string, ToolCall[]>;
  terminalStreamsByTurnId: Record<string, TerminalStream[]>;
  approvalRequestsByTurnId: Record<string, ApprovalRequest[]>;
};

const buildTranscriptEntityIndexes = (
  state: RendererStoreState
): TranscriptEntityIndexes => ({
  messageBlocksByTurnId: groupByTurnId(Object.values(state.entities.messageBlocks)),
  toolCallsByTurnId: groupByTurnId(Object.values(state.entities.toolCalls)),
  terminalStreamsByTurnId: groupByTurnId(
    Object.values(state.entities.terminalStreams)
  ),
  approvalRequestsByTurnId: groupByTurnId(
    Object.values(state.entities.approvalRequests)
  )
});

const selectMessageBlocksForTurn = (
  state: RendererStoreState,
  turn: Turn,
  indexes: TranscriptEntityIndexes
): MessageBlock[] => {
  const fromMessageRefs = turn.messageIds.flatMap((messageId) =>
    selectMessageBlocksForMessage(state, messageId)
  );
  const fromTurnScan = indexes.messageBlocksByTurnId[turn.turnId] ?? [];

  return sortByStartTime(
    uniqueById([...fromMessageRefs, ...fromTurnScan], (block) => block.blockId),
    (block) => block.blockId
  );
};

const selectToolCallsForTurn = (
  state: RendererStoreState,
  turn: Turn,
  indexes: TranscriptEntityIndexes
): ToolCall[] => {
  const byTurnOrder = turn.toolCallIds
    .map((toolCallId) => state.entities.toolCalls[toolCallId])
    .filter((item): item is ToolCall => Boolean(item));
  const orderedIds = new Set(turn.toolCallIds);
  const fallback = (indexes.toolCallsByTurnId[turn.turnId] ?? []).filter(
    (item) => !orderedIds.has(item.toolCallId)
  );
  return [...byTurnOrder, ...sortByStartTime(fallback, (item) => item.toolCallId)];
};

const selectTerminalStreamsForTurn = (
  state: RendererStoreState,
  turn: Turn,
  indexes: TranscriptEntityIndexes
): TerminalStream[] => {
  const byTurnOrder = turn.terminalIds
    .map((terminalId) => state.entities.terminalStreams[terminalId])
    .filter((item): item is TerminalStream => Boolean(item));
  const orderedIds = new Set(turn.terminalIds);
  const fallback = (indexes.terminalStreamsByTurnId[turn.turnId] ?? []).filter(
    (item) => !orderedIds.has(item.terminalId)
  );
  return [...byTurnOrder, ...sortByStartTime(fallback, (item) => item.terminalId)];
};

const selectApprovalRequestsForTurn = (
  state: RendererStoreState,
  turn: Turn,
  indexes: TranscriptEntityIndexes
): ApprovalRequest[] => {
  const byTurnOrder = turn.approvalRequestIds
    .map((requestId) => state.entities.approvalRequests[requestId])
    .filter((item): item is ApprovalRequest => Boolean(item));
  const orderedIds = new Set(turn.approvalRequestIds);
  const fallback = (indexes.approvalRequestsByTurnId[turn.turnId] ?? []).filter(
    (item) => !orderedIds.has(item.requestId)
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

const splitBlocksByMessageId = (blocks: MessageBlock[]): MessageBlock[][] => {
  const groups: MessageBlock[][] = [];

  for (const block of blocks) {
    const current = groups.at(-1);
    const currentMessageId = current?.[0]?.messageId;
    if (!current || currentMessageId !== block.messageId) {
      groups.push([block]);
      continue;
    }
    current.push(block);
  }

  return groups;
};

const splitBlocksByRole = (
  blocks: MessageBlock[],
  finalMessageId?: string
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

  if (!finalMessageId) {
    return groups;
  }

  return groups.flatMap((group) => {
    if (group.role !== "assistant") {
      return [group];
    }
    const messageGroups = splitBlocksByMessageId(group.blocks);
    if (messageGroups.length <= 1) {
      return [group];
    }
    const containsFinalMessage = messageGroups.some(
      (messageGroup) => messageGroup[0]?.messageId === finalMessageId
    );
    if (!containsFinalMessage) {
      return [group];
    }
    return messageGroups.map((messageGroup) => ({
      role: group.role,
      blocks: messageGroup
    }));
  });
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
  isFinalResponseRow: boolean;
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
): TurnTranscriptRow[] => {
  const indexes = buildTranscriptEntityIndexes(state);
  return sortTurnsForTranscript(turns).flatMap((turn) => {
    const blocks = selectMessageBlocksForTurn(state, turn, indexes);
    const toolCalls = selectToolCallsForTurn(state, turn, indexes);
    const terminalStreams = selectTerminalStreamsForTurn(state, turn, indexes);
    const approvals = selectApprovalRequestsForTurn(state, turn, indexes);

    const blockGroups = splitBlocksByRole(blocks, turn.finalMessageId);
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
          isFinalResponseRow: false,
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
      const isFinalResponseRow =
        group.role === "assistant" &&
        typeof turn.finalMessageId === "string" &&
        group.blocks.some((block) => block.messageId === turn.finalMessageId);
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
        isFinalResponseRow,
        blocks: group.blocks,
        toolCalls: isAssistantLike ? toolCalls : [],
        terminalStreams: isAssistantLike ? terminalStreams : [],
        approvals: isAssistantLike ? approvals : [],
        hasProcessDetails: isAssistantLike && hasProcessDetails,
        defaultProcessExpanded: isAssistantLike && turn.status !== "completed"
      };
    });
  });
};
