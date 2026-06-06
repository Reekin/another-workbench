import type { DomainSnapshot, MessageBlock, Turn } from "@another-workbench/shared";

export type ReadSessionTranscriptTurn = {
  turnId: string;
  status: Turn["status"];
  startedAt: string;
  completedAt?: string;
  user: string[];
  agentFinal?: string;
};

export type ReadSessionTranscriptResult = {
  sessionId: string;
  conversationId: string;
  engineId: string;
  totalTurnCount: number;
  returnedTurnCount: number;
  turnCount: number;
  truncated: boolean;
  truncatedByTurns: boolean;
  truncatedByChars: boolean;
  maxTextChars: number;
  turns: ReadSessionTranscriptTurn[];
};

export type ReadSessionTranscriptInput = {
  snapshot: DomainSnapshot;
  sessionId: string;
  limit?: number;
  maxTextChars?: number;
};

export const defaultReadSessionTurnLimit = 50;
export const maxReadSessionTurnLimit = 200;
export const defaultReadSessionMaxTextChars = 60_000;
export const maxReadSessionMaxTextChars = 200_000;

const textBlockKinds = new Set<MessageBlock["kind"]>(["markdown", "plain_text"]);

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
    const byIso =
      compareIsoAsc(left.startedAt, right.startedAt) ||
      compareIsoAsc(left.completedAt, right.completedAt);
    if (byIso !== 0) {
      return byIso;
    }
    return left.turnId.localeCompare(right.turnId);
  });

const sortBlocksAsc = (blocks: MessageBlock[]): MessageBlock[] =>
  [...blocks].sort(
    (left, right) =>
      compareIsoAsc(left.startedAt, right.startedAt) ||
      compareIsoAsc(left.completedAt, right.completedAt) ||
      left.blockId.localeCompare(right.blockId)
  );

const isTextBlock = (
  block: MessageBlock
): block is MessageBlock & { text: string } =>
  textBlockKinds.has(block.kind) &&
  typeof block.text === "string" &&
  block.text.trim().length > 0;

const renderTextBlocks = (blocks: MessageBlock[]): string | undefined => {
  const text = sortBlocksAsc(blocks)
    .filter(isTextBlock)
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : undefined;
};

const userTextsForTurn = (blocks: MessageBlock[]): string[] =>
  sortBlocksAsc(blocks)
    .filter((block) => block.role === "user")
    .filter(isTextBlock)
    .map((block) => block.text.trim())
    .filter(Boolean);

const selectAgentFinalText = (
  turn: Turn,
  blocks: MessageBlock[]
): string | undefined => {
  const assistantBlocks = blocks.filter((block) => block.role === "assistant");

  if (turn.finalMessageId) {
    const finalMessageText = renderTextBlocks(
      assistantBlocks.filter((block) => block.messageId === turn.finalMessageId)
    );
    if (finalMessageText) {
      return finalMessageText;
    }
  }

  const phaseAwareAssistantBlocks = assistantBlocks.filter((block) => block.phase);
  const finalAnswerText = renderTextBlocks(
    assistantBlocks.filter((block) => block.phase === "final_answer")
  );
  if (finalAnswerText) {
    return finalAnswerText;
  }

  if (phaseAwareAssistantBlocks.length === 0) {
    return renderTextBlocks(assistantBlocks.filter((block) => !block.phase));
  }

  return undefined;
};

type TextBudget = {
  remaining: number;
  truncated: boolean;
};

const consumeTextBudget = (
  text: string | undefined,
  budget: TextBudget
): string | undefined => {
  if (!text) {
    return undefined;
  }
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return undefined;
  }
  if (text.length <= budget.remaining) {
    budget.remaining -= text.length;
    return text;
  }
  const sliced = text.slice(0, budget.remaining).trimEnd();
  budget.remaining = 0;
  budget.truncated = true;
  return sliced.length > 0 ? sliced : undefined;
};

const normalizeTurnLimit = (limit?: number): number => {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return defaultReadSessionTurnLimit;
  }
  return Math.min(
    maxReadSessionTurnLimit,
    Math.max(1, Math.floor(limit))
  );
};

const normalizeMaxTextChars = (maxTextChars?: number): number => {
  if (typeof maxTextChars !== "number" || !Number.isFinite(maxTextChars)) {
    return defaultReadSessionMaxTextChars;
  }
  return Math.min(
    maxReadSessionMaxTextChars,
    Math.max(1, Math.floor(maxTextChars))
  );
};

const selectBlocksForTurn = (
  turn: Turn,
  blocksByTurnId: Map<string, MessageBlock[]>,
  blocksByMessageId: Map<string, MessageBlock[]>
): MessageBlock[] => {
  const blocks = new Map<string, MessageBlock>();
  for (const block of blocksByTurnId.get(turn.turnId) ?? []) {
    blocks.set(block.blockId, block);
  }
  for (const messageId of turn.messageIds) {
    for (const block of blocksByMessageId.get(messageId) ?? []) {
      blocks.set(block.blockId, block);
    }
  }
  return [...blocks.values()];
};

export const buildReadSessionTranscript = (
  input: ReadSessionTranscriptInput
): ReadSessionTranscriptResult => {
  const session = input.snapshot.sessions.find(
    (candidate) => candidate.sessionId === input.sessionId
  );
  if (!session) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }

  const turns = sortTurnsAsc(
    input.snapshot.turns.filter((turn) => turn.sessionId === input.sessionId)
  );
  const limit = normalizeTurnLimit(input.limit);
  const maxTextChars = normalizeMaxTextChars(input.maxTextChars);
  const visibleTurns = limit >= turns.length ? turns : turns.slice(-limit);
  const blocksByTurnId = new Map<string, MessageBlock[]>();
  const blocksByMessageId = new Map<string, MessageBlock[]>();
  for (const block of input.snapshot.messageBlocks) {
    if (block.sessionId !== input.sessionId) {
      continue;
    }
    const existingTurnBlocks = blocksByTurnId.get(block.turnId) ?? [];
    existingTurnBlocks.push(block);
    blocksByTurnId.set(block.turnId, existingTurnBlocks);
    const existingMessageBlocks = blocksByMessageId.get(block.messageId) ?? [];
    existingMessageBlocks.push(block);
    blocksByMessageId.set(block.messageId, existingMessageBlocks);
  }
  const textBudget: TextBudget = {
    remaining: maxTextChars,
    truncated: false
  };
  const transcriptTurns = visibleTurns.map((turn) => {
    const blocks = selectBlocksForTurn(turn, blocksByTurnId, blocksByMessageId);
    const user = userTextsForTurn(blocks)
      .map((text) => consumeTextBudget(text, textBudget))
      .filter((text): text is string => Boolean(text));
    const agentFinal = consumeTextBudget(
      selectAgentFinalText(turn, blocks),
      textBudget
    );
    return {
      turnId: turn.turnId,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      user,
      agentFinal
    };
  });
  const truncatedByTurns = visibleTurns.length < turns.length;

  return {
    sessionId: session.sessionId,
    conversationId: session.conversationId,
    engineId: session.engineId,
    totalTurnCount: turns.length,
    returnedTurnCount: transcriptTurns.length,
    turnCount: transcriptTurns.length,
    truncated: truncatedByTurns || textBudget.truncated,
    truncatedByTurns,
    truncatedByChars: textBudget.truncated,
    maxTextChars,
    turns: transcriptTurns
  };
};

export const serializeReadSessionTranscript = (
  result: ReadSessionTranscriptResult
): string => JSON.stringify(result, null, 2);
