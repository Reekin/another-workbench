import type {
  AgentParticipant,
  ApprovalRequest,
  ChatSession,
  Conversation,
  DomainSnapshot,
  MessageBlock,
  SessionRelation,
  TerminalStream,
  ToolCall,
  Turn
} from "@another-workbench/shared";

export type SessionWindowSnapshot = {
  snapshot: DomainSnapshot;
  sessionId: string;
  windowStartTurnId?: string;
  windowEndTurnId?: string;
  hasOlder: boolean;
  hasNewer: boolean;
};

type BuildSessionWindowInput = {
  sessionId: string;
  conversation: Conversation;
  session: ChatSession;
  turns: Turn[];
  messageBlocks: MessageBlock[];
  toolCalls: ToolCall[];
  terminalStreams: TerminalStream[];
  approvalRequests: ApprovalRequest[];
  participants: AgentParticipant[];
  sessionRelations: SessionRelation[];
  limit: number;
  beforeTurnId?: string;
  anchorTurnId?: string;
};

const compareIsoAsc = (left?: string, right?: string): number => {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  return left.localeCompare(right);
};

const sortTurnsAsc = (turns: Turn[]): Turn[] =>
  [...turns].sort((left, right) => {
    const leftIso = left.startedAt ?? left.completedAt;
    const rightIso = right.startedAt ?? right.completedAt;
    const byIso = compareIsoAsc(leftIso, rightIso);
    if (byIso !== 0) {
      return byIso;
    }
    return left.turnId.localeCompare(right.turnId);
  });

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const buildSessionWindowSnapshot = (
  input: BuildSessionWindowInput
): SessionWindowSnapshot => {
  const sortedTurns = sortTurnsAsc(input.turns);
  if (sortedTurns.length === 0) {
    return {
      sessionId: input.sessionId,
      snapshot: {
        conversations: [input.conversation],
        sessions: [input.session],
        turns: [],
        messageBlocks: [],
        toolCalls: [],
        terminalStreams: [],
        approvalRequests: [],
        participants: input.participants,
        sessionRelations: input.sessionRelations
      },
      hasOlder: false,
      hasNewer: false
    };
  }

  let startIndex = 0;
  let endIndex = sortedTurns.length - 1;
  const anchorIndex = input.anchorTurnId
    ? sortedTurns.findIndex((turn) => turn.turnId === input.anchorTurnId)
    : -1;

  if (input.anchorTurnId) {
    const resolvedEndIndex =
      anchorIndex >= 0 ? anchorIndex : sortedTurns.length - 1;
    endIndex = clamp(resolvedEndIndex, 0, sortedTurns.length - 1);
    startIndex = clamp(endIndex - input.limit + 1, 0, endIndex);
  } else if (input.beforeTurnId) {
    const beforeIndex = sortedTurns.findIndex(
      (turn) => turn.turnId === input.beforeTurnId
    );
    const resolvedEndIndex =
      beforeIndex > 0 ? beforeIndex - 1 : sortedTurns.length - 1;
    endIndex = clamp(resolvedEndIndex, 0, sortedTurns.length - 1);
    startIndex = clamp(endIndex - input.limit + 1, 0, endIndex);
  } else {
    endIndex = sortedTurns.length - 1;
    startIndex = clamp(endIndex - input.limit + 1, 0, endIndex);
  }

  const windowTurns = sortedTurns.slice(startIndex, endIndex + 1);
  const turnIds = new Set(windowTurns.map((turn) => turn.turnId));
  const messageIds = new Set(windowTurns.flatMap((turn) => turn.messageIds));
  const toolCallIds = new Set(windowTurns.flatMap((turn) => turn.toolCallIds));
  const terminalIds = new Set(windowTurns.flatMap((turn) => turn.terminalIds));
  const approvalRequestIds = new Set(
    windowTurns.flatMap((turn) => turn.approvalRequestIds)
  );

  return {
    sessionId: input.sessionId,
    windowStartTurnId: windowTurns[0]?.turnId,
    windowEndTurnId: windowTurns.at(-1)?.turnId,
    hasOlder: startIndex > 0,
    hasNewer: endIndex < sortedTurns.length - 1,
    snapshot: {
      conversations: [input.conversation],
      sessions: [input.session],
      turns: windowTurns,
      messageBlocks: input.messageBlocks.filter(
        (block) => turnIds.has(block.turnId) || messageIds.has(block.messageId)
      ),
      toolCalls: input.toolCalls.filter(
        (toolCall) => turnIds.has(toolCall.turnId) || toolCallIds.has(toolCall.toolCallId)
      ),
      terminalStreams: input.terminalStreams.filter(
        (terminal) =>
          turnIds.has(terminal.turnId) || terminalIds.has(terminal.terminalId)
      ),
      approvalRequests: input.approvalRequests.filter(
        (approval) =>
          turnIds.has(approval.turnId) || approvalRequestIds.has(approval.requestId)
      ),
      participants: input.participants,
      sessionRelations: input.sessionRelations
    }
  };
};
