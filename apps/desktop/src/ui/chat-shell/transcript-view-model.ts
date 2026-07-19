import type {
  ApprovalRequest,
  MessageBlock,
  MessageRole,
  RuntimeInteraction,
  TerminalStream,
  ToolCall,
  Turn
} from "@another-workbench/shared";
import type { DomainReadModel } from "@another-workbench/core";
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

const collectIndexedEntitiesByTurn = <T extends { turnId?: string }>(
  turnIds: Iterable<string>,
  idsByTurn: Record<string, string[]>,
  entities: Record<string, T | undefined>
): Record<string, T[]> => {
  const result: Record<string, T[]> = {};
  for (const turnId of turnIds) {
    const items: T[] = [];
    for (const id of idsByTurn[turnId] ?? []) {
      const item = entities[id];
      if (item && item.turnId === turnId) {
        items.push(item);
      }
    }
    if (items.length > 0) {
      result[turnId] = items;
    }
  }
  return result;
};

type TranscriptEntityIndexes = {
  messageBlocksByTurnId: Record<string, MessageBlock[]>;
  toolCallsByTurnId: Record<string, ToolCall[]>;
  terminalStreamsByTurnId: Record<string, TerminalStream[]>;
  approvalRequestsByTurnId: Record<string, ApprovalRequest[]>;
  runtimeInteractionsByTurnId: Record<string, RuntimeInteraction[]>;
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
    }
  | {
      kind: "interaction";
      id: string;
      startedAt?: string;
      interaction: RuntimeInteraction;
};

const buildTranscriptEntityIndexes = (
  state: RendererStoreState,
  turns: Turn[]
): TranscriptEntityIndexes => {
  const turnIds = turns.map((turn) => turn.turnId);
  return {
    messageBlocksByTurnId: collectIndexedEntitiesByTurn(
      turnIds,
      state.indexes.messageBlockIdsByTurn,
      state.entities.messageBlocks
    ),
    toolCallsByTurnId: collectIndexedEntitiesByTurn(
      turnIds,
      state.indexes.toolCallIdsByTurn,
      state.entities.toolCalls
    ),
    terminalStreamsByTurnId: collectIndexedEntitiesByTurn(
      turnIds,
      state.indexes.terminalIdsByTurn,
      state.entities.terminalStreams
    ),
    approvalRequestsByTurnId: collectIndexedEntitiesByTurn(
      turnIds,
      state.indexes.approvalRequestIdsByTurn,
      state.entities.approvalRequests
    ),
    runtimeInteractionsByTurnId: collectIndexedEntitiesByTurn(
      turnIds,
      state.indexes.runtimeInteractionIdsByTurn,
      state.entities.runtimeInteractions
    )
  };
};

const selectMessageBlocksForTurn = (
  state: RendererStoreState,
  turn: Turn,
  indexes: TranscriptEntityIndexes
): MessageBlock[] => {
  const fromMessageRefs = turn.messageIds.flatMap((messageId) =>
    selectMessageBlocksForMessage(state, messageId)
  ).filter((block) => block.turnId === turn.turnId);
  const referencedBlockIds = new Set(fromMessageRefs.map((block) => block.blockId));
  const fromTurnScan = indexes.messageBlocksByTurnId[turn.turnId] ?? [];
  const fallback = fromTurnScan.filter(
    (block) => !referencedBlockIds.has(block.blockId)
  );

  return uniqueById(
    [...fromMessageRefs, ...sortByStartTime(fallback, (block) => block.blockId)],
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
    .filter(
      (item): item is ToolCall => Boolean(item) && item.turnId === turn.turnId
    );
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
    .filter(
      (item): item is TerminalStream =>
        Boolean(item) && item.turnId === turn.turnId
    );
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
    .filter(
      (item): item is ApprovalRequest =>
        Boolean(item) && item.turnId === turn.turnId
    );
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

const selectRuntimeInteractionsForTurn = (
  state: RendererStoreState,
  turn: Turn,
  indexes: TranscriptEntityIndexes
): RuntimeInteraction[] => {
  const requestIds = turn.interactionRequestIds ?? [];
  const byTurnOrder = requestIds
    .map((requestId) => state.entities.runtimeInteractions[requestId])
    .filter(
      (item): item is RuntimeInteraction =>
        Boolean(item) && item.turnId === turn.turnId
    );
  const orderedIds = new Set(requestIds);
  const fallback = (indexes.runtimeInteractionsByTurnId[turn.turnId] ?? []).filter(
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
  approvals: ApprovalRequest[],
  interactions: RuntimeInteraction[]
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
  const interactionEntries = interactions.map((interaction) => ({
    kind: "interaction" as const,
    id: `interaction:${interaction.requestId}`,
    startedAt: interaction.requestedAt,
    interaction
  }));

  return [...toolEntries, ...terminalEntries, ...approvalEntries, ...interactionEntries].sort((left, right) => {
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
  approvals: ApprovalRequest[],
  interactions: RuntimeInteraction[]
): ParticipantIdentity => {
  const actor =
    turn.actor ??
    blocks.find((block) => block.actor)?.actor ??
    toolCalls.find((toolCall) => toolCall.actor)?.actor ??
    terminalStreams.find((stream) => stream.actor)?.actor ??
    approvals.find((approval) => approval.actor)?.actor ??
    interactions.find((interaction) => interaction.actor)?.actor;

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
  canDisplayAsFinalResponse: boolean;
  blocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  approvals: ApprovalRequest[];
  interactions: RuntimeInteraction[];
  hasProcessDetails: boolean;
  defaultProcessExpanded: boolean;
};

const isRendererStoreState = (
  source: DomainReadModel | RendererStoreState
): source is RendererStoreState => "entities" in source;

const buildRunningTurnRows = (
  turn: Turn,
  blocks: MessageBlock[],
  toolCalls: ToolCall[],
  terminalStreams: TerminalStream[],
  approvals: ApprovalRequest[],
  interactions: RuntimeInteraction[],
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
    approvals,
    interactions
  ).map((entry, index) => ({
    ...entry,
    index
  }));
  const initialPromptMessageId = turn.messageIds.find((messageId) =>
    messageEntries.some(
      (entry) =>
        entry.group.role === "user" &&
        entry.group.blocks[0]?.messageId === messageId
    )
  );
  const entries = [...messageEntries, ...processEntries].sort((left, right) => {
    const leftPhase =
      left.kind === "message" &&
      left.group.role === "user" &&
      left.group.blocks[0]?.messageId === initialPromptMessageId
        ? 0
        : 1;
    const rightPhase =
      right.kind === "message" &&
      right.group.role === "user" &&
      right.group.blocks[0]?.messageId === initialPromptMessageId
        ? 0
        : 1;
    if (leftPhase !== rightPhase) {
      return leftPhase - rightPhase;
    }
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
          approvals,
          interactions
        ),
        messageRole: "assistant",
        isFinalResponseRow: false,
        canDisplayAsFinalResponse: false,
        blocks,
        toolCalls,
        terminalStreams,
        approvals,
        interactions,
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
          isAssistantLike ? approvals : [],
          isAssistantLike ? interactions : []
        ),
        messageRole: entry.group.role,
        isFinalResponseRow: false,
        canDisplayAsFinalResponse: false,
        blocks: entry.group.blocks,
        toolCalls: [],
        terminalStreams: [],
        approvals: [],
        interactions: [],
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
    const processInteractions = entry.kind === "interaction" ? [entry.interaction] : [];
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
        processApprovals,
        processInteractions
      ),
      messageRole: "assistant" as const,
      isFinalResponseRow: false,
      canDisplayAsFinalResponse: false,
      blocks: processBlocks,
      toolCalls: processToolCalls,
      terminalStreams: processTerminalStreams,
      approvals: processApprovals,
      interactions: processInteractions,
      hasProcessDetails: true,
      defaultProcessExpanded: true
    };
  });
};

export const buildTurnTranscriptRows = (
  source: DomainReadModel | RendererStoreState,
  turns: Turn[],
  participantDirectory = buildParticipantDirectory([])
): TurnTranscriptRow[] => {
  let legacyState: RendererStoreState | undefined;
  let domain: DomainReadModel | undefined;
  if (isRendererStoreState(source)) {
    legacyState = source;
  } else {
    domain = source;
  }
  const legacyIndexes = legacyState
    ? buildTranscriptEntityIndexes(legacyState, turns)
    : undefined;
  return sortTurnsForTranscript(turns).flatMap((turn) => {
    const blocks = domain
      ? (() => {
          const referenced = turn.messageIds
            .flatMap((messageId) => domain.listMessageBlocks({ messageId }))
            .filter((block) => block.turnId === turn.turnId);
          const referencedIds = new Set(referenced.map((block) => block.blockId));
          const fallback = domain
            .listMessageBlocks({ turnId: turn.turnId })
            .filter((block) => !referencedIds.has(block.blockId));
          return uniqueById(
            [...referenced, ...sortByStartTime(fallback, (block) => block.blockId)],
            (block) => block.blockId
          );
        })()
      : selectMessageBlocksForTurn(legacyState!, turn, legacyIndexes!);
    const toolCalls = domain
      ? domain.listToolCalls({ turnId: turn.turnId })
      : selectToolCallsForTurn(legacyState!, turn, legacyIndexes!);
    const terminalStreams = domain
      ? domain.listTerminalStreams({ turnId: turn.turnId })
      : selectTerminalStreamsForTurn(legacyState!, turn, legacyIndexes!);
    const approvals = domain
      ? domain.listApprovalRequests({ turnId: turn.turnId })
      : selectApprovalRequestsForTurn(legacyState!, turn, legacyIndexes!);
    const interactions = domain
      ? domain.listRuntimeInteractions({ sessionId: turn.sessionId })
          .filter((interaction) => interaction.turnId === turn.turnId)
      : selectRuntimeInteractionsForTurn(legacyState!, turn, legacyIndexes!);

    const blockGroups = splitBlocksByRole(blocks, turn.finalMessageId);
    const hasProcessDetails =
      toolCalls.length > 0 ||
      terminalStreams.length > 0 ||
      approvals.length > 0 ||
      interactions.length > 0;

    if (turn.status !== "completed") {
      return buildRunningTurnRows(
        turn,
        blocks,
        toolCalls,
        terminalStreams,
        approvals,
        interactions,
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
            approvals,
            interactions
          ),
          messageRole: "assistant" as const,
          isFinalResponseRow: false,
          canDisplayAsFinalResponse: false,
          blocks,
          toolCalls,
          terminalStreams,
          approvals,
          interactions,
          hasProcessDetails,
          defaultProcessExpanded: turn.status !== "completed"
        }
      ];
    }

    const hasPhaseAwareAssistantBlocks = blocks.some(
      (block) => block.role === "assistant" && block.phase
    );
    const rows: TurnTranscriptRow[] = blockGroups.map((group, index) => {
      const isAssistantLike = group.role !== "user";
      const isFinalResponseRow =
        group.role === "assistant" &&
        typeof turn.finalMessageId === "string" &&
        group.blocks.some((block) => block.messageId === turn.finalMessageId);
      const canDisplayAsFinalResponse =
        isFinalResponseRow ||
        (group.role === "assistant" &&
          group.blocks.some(
            (block) =>
              block.phase === "final_answer" ||
              (!hasPhaseAwareAssistantBlocks && !block.phase)
          ));
      return {
        rowId: `${turn.turnId}:${group.role}:${index}`,
        rowKind: "message" as const,
        startedAt: group.blocks[0]?.startedAt ?? turn.startedAt,
        turn,
        turnIdentity: resolveTurnIdentity(
          participantDirectory,
          group.role,
          turn,
          group.blocks,
          isAssistantLike ? toolCalls : [],
          isAssistantLike ? terminalStreams : [],
          isAssistantLike ? approvals : [],
          isAssistantLike ? interactions : []
        ),
        messageRole: group.role,
        isFinalResponseRow,
        canDisplayAsFinalResponse,
        blocks: group.blocks,
        toolCalls: isAssistantLike ? toolCalls : [],
        terminalStreams: isAssistantLike ? terminalStreams : [],
        approvals: isAssistantLike ? approvals : [],
        interactions: isAssistantLike ? interactions : [],
        hasProcessDetails: isAssistantLike && hasProcessDetails,
        defaultProcessExpanded: isAssistantLike && turn.status !== "completed"
      };
    });

    if (
      rows.some((row) => row.canDisplayAsFinalResponse) ||
      !hasPhaseAwareAssistantBlocks
    ) {
      return rows;
    }

    return [
      ...rows,
      {
        rowId: `${turn.turnId}:assistant:pending-final`,
        rowKind: "message" as const,
        startedAt: turn.completedAt ?? turn.startedAt,
        turn,
        turnIdentity: resolveTurnIdentity(
          participantDirectory,
          "assistant",
          turn,
          [],
          toolCalls,
          terminalStreams,
          approvals,
          interactions
        ),
        messageRole: "assistant" as const,
        isFinalResponseRow: false,
        canDisplayAsFinalResponse: true,
        blocks: [],
        toolCalls,
        terminalStreams,
        approvals,
        interactions,
        hasProcessDetails,
        defaultProcessExpanded: false
      }
    ];
  });
};
