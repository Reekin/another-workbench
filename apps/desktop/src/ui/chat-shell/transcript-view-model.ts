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

type ProcessTranscriptEntry =
  | {
      kind: "tool";
      id: string;
      startedAt?: string;
      toolCall: ToolCall;
      terminalStreams: TerminalStream[];
    }
  | {
      kind: "terminal";
      id: string;
      startedAt?: string;
      terminalStream: TerminalStream;
    }
  | {
      kind: "approval";
      id: string;
      startedAt?: string;
      approval: ApprovalRequest;
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

const splitBlocksByMessage = (
  blocks: MessageBlock[]
): Array<{ role: MessageRole; blocks: MessageBlock[] }> =>
  splitBlocksByMessageId(blocks)
    .map((messageBlocks) => {
      const firstBlock = messageBlocks[0];
      return firstBlock
        ? {
            role: firstBlock.role,
            blocks: messageBlocks
          }
        : undefined;
    })
    .filter((group): group is { role: MessageRole; blocks: MessageBlock[] } =>
      Boolean(group)
    );

const buildProcessTranscriptEntries = (
  toolCalls: ToolCall[],
  terminalStreams: TerminalStream[],
  approvals: ApprovalRequest[]
): ProcessTranscriptEntry[] => {
  const terminalStreamsByToolCallId = new Map<string, TerminalStream[]>();
  const unlinkedTerminalStreams: TerminalStream[] = [];

  for (const terminalStream of terminalStreams) {
    if (terminalStream.toolCallId) {
      const group = terminalStreamsByToolCallId.get(terminalStream.toolCallId) ?? [];
      group.push(terminalStream);
      terminalStreamsByToolCallId.set(terminalStream.toolCallId, group);
      continue;
    }
    unlinkedTerminalStreams.push(terminalStream);
  }

  const toolEntries = toolCalls.map((toolCall) => ({
    kind: "tool" as const,
    id: `tool:${toolCall.toolCallId}`,
    startedAt: toolCall.startedAt,
    toolCall,
    terminalStreams: sortByStartTime(
      terminalStreamsByToolCallId.get(toolCall.toolCallId) ?? [],
      (terminalStream) => terminalStream.terminalId
    )
  }));
  const linkedToolIds = new Set(toolCalls.map((toolCall) => toolCall.toolCallId));
  const terminalEntries = [
    ...unlinkedTerminalStreams,
    ...Array.from(terminalStreamsByToolCallId.entries())
      .filter(([toolCallId]) => !linkedToolIds.has(toolCallId))
      .flatMap(([, streams]) => streams)
  ].map((terminalStream) => ({
    kind: "terminal" as const,
    id: `terminal:${terminalStream.terminalId}`,
    startedAt: terminalStream.startedAt,
    terminalStream
  }));
  const approvalEntries = approvals.map((approval) => ({
    kind: "approval" as const,
    id: `approval:${approval.requestId}`,
    startedAt: approval.requestedAt,
    approval
  }));

  return [...toolEntries, ...terminalEntries, ...approvalEntries].sort((left, right) => {
    const byDate = compareIsoDateAsc(left.startedAt, right.startedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.id.localeCompare(right.id);
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
  rowKind: "message" | "process";
  startedAt?: string;
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

const buildRunningTurnRows = (
  turn: Turn,
  blocks: MessageBlock[],
  toolCalls: ToolCall[],
  terminalStreams: TerminalStream[],
  approvals: ApprovalRequest[],
  participantDirectory: ParticipantDirectory,
  hasProcessDetails: boolean
): TurnTranscriptRow[] => {
  const messageEntries = splitBlocksByMessage(blocks).map((group, index) => ({
    kind: "message" as const,
    id: `message:${index}:${group.blocks[0]?.blockId ?? index}`,
    startedAt: group.blocks[0]?.startedAt,
    group,
    index
  }));
  const processEntries = buildProcessTranscriptEntries(
    toolCalls,
    terminalStreams,
    approvals
  ).map((entry, index) => ({
    ...entry,
    index
  }));
  const entries = [...messageEntries, ...processEntries].sort((left, right) => {
    const byDate = compareIsoDateAsc(left.startedAt, right.startedAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.id.localeCompare(right.id);
  });

  if (entries.length === 0) {
    return [
      {
        rowId: `${turn.turnId}:assistant:0`,
        rowKind: "message",
        startedAt: turn.startedAt,
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
        messageRole: "assistant",
        isFinalResponseRow: false,
        blocks,
        toolCalls,
        terminalStreams,
        approvals,
        hasProcessDetails,
        defaultProcessExpanded: true
      }
    ];
  }

  return entries.map((entry, index) => {
    if (entry.kind === "message") {
      const isAssistantLike = entry.group.role !== "user";
      return {
        rowId: `${turn.turnId}:${entry.group.role}:${entry.index}`,
        rowKind: "message" as const,
        startedAt: entry.startedAt,
        turn,
        turnIdentity: resolveTurnIdentity(
          participantDirectory,
          entry.group.role,
          turn,
          entry.group.blocks,
          isAssistantLike ? toolCalls : [],
          isAssistantLike ? terminalStreams : [],
          isAssistantLike ? approvals : []
        ),
        messageRole: entry.group.role,
        isFinalResponseRow: false,
        blocks: entry.group.blocks,
        toolCalls: [],
        terminalStreams: [],
        approvals: [],
        hasProcessDetails: false,
        defaultProcessExpanded: false
      };
    }

    const processBlocks: MessageBlock[] = [];
    const processToolCalls = entry.kind === "tool" ? [entry.toolCall] : [];
    const processTerminalStreams =
      entry.kind === "tool"
        ? entry.terminalStreams
        : entry.kind === "terminal"
          ? [entry.terminalStream]
          : [];
    const processApprovals = entry.kind === "approval" ? [entry.approval] : [];
    return {
      rowId: `${turn.turnId}:process:${index}:${entry.id}`,
      rowKind: "process" as const,
      startedAt: entry.startedAt,
      turn,
      turnIdentity: resolveTurnIdentity(
        participantDirectory,
        "assistant",
        turn,
        processBlocks,
        processToolCalls,
        processTerminalStreams,
        processApprovals
      ),
      messageRole: "assistant" as const,
      isFinalResponseRow: false,
      blocks: processBlocks,
      toolCalls: processToolCalls,
      terminalStreams: processTerminalStreams,
      approvals: processApprovals,
      hasProcessDetails: true,
      defaultProcessExpanded: true
    };
  });
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

    if (turn.status !== "completed") {
      return buildRunningTurnRows(
        turn,
        blocks,
        toolCalls,
        terminalStreams,
        approvals,
        participantDirectory,
        hasProcessDetails
      );
    }

    if (blockGroups.length === 0) {
      return [
        {
          rowId: `${turn.turnId}:assistant:0`,
          rowKind: "message",
          startedAt: turn.startedAt,
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
        rowKind: "message",
        startedAt: group.blocks[0]?.startedAt ?? turn.startedAt,
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
