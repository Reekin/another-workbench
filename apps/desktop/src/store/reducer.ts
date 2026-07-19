import type {
  ActorRef,
  EventEnvelope,
  MessageBlock,
  RuntimeEvent
} from "@another-workbench/shared";
import { appendLimitedStreamText } from "@another-workbench/shared";
import type { RendererStoreAction, RendererStoreState } from "./types.js";
import {
  createEmptyIndexes,
  createInitialRendererStoreState,
  deleteThreadGoal,
  upsertApprovalRequest,
  upsertConversation,
  upsertMessageBlock,
  upsertParticipant,
  upsertRuntimeInteraction,
  upsertSession,
  upsertSessionRelation,
  upsertTerminalStream,
  upsertThreadGoal,
  upsertToolCall,
  upsertTurn
} from "./state.js";
import { advanceRendererRefreshSignals } from "./refresh-signals.js";

const nowIso = (): string => new Date().toISOString();
const unknownAgentId = "unknown-agent";
const unknownToolName = "unknown-tool";
const markdownBlockSuffix = ":md";
const maxSeenEventIds = 2_048;

type ActorFields = { participantId?: string; engineId?: string };

const splitComparableCursor = (
  cursor: string
): { prefix: string; sequence: bigint } | undefined => {
  const match = /^(.*?)(\d+)$/.exec(cursor);
  if (!match) {
    return undefined;
  }
  return {
    prefix: match[1] ?? "",
    sequence: BigInt(match[2]!)
  };
};

const compareCursorPosition = (
  left: string | undefined,
  right: string | undefined
): number | undefined => {
  if (!left || !right) {
    return undefined;
  }
  if (left === right) {
    return 0;
  }
  const parsedLeft = splitComparableCursor(left);
  const parsedRight = splitComparableCursor(right);
  if (!parsedLeft || !parsedRight || parsedLeft.prefix !== parsedRight.prefix) {
    return undefined;
  }
  if (parsedLeft.sequence < parsedRight.sequence) {
    return -1;
  }
  if (parsedLeft.sequence > parsedRight.sequence) {
    return 1;
  }
  return 0;
};

const isEnvelopeCoveredByCursor = (
  envelope: EventEnvelope,
  cursor: string | undefined
): boolean => {
  if (!cursor) {
    return false;
  }
  const comparison = compareCursorPosition(envelope.cursor, cursor);
  return comparison !== undefined && comparison <= 0;
};

const runtimeEventSessionId = (event: RuntimeEvent): string | undefined =>
  "sessionId" in event && typeof event.sessionId === "string"
    ? event.sessionId
    : undefined;

const isEnvelopeCoveredByBarrier = (
  state: RendererStoreState,
  envelope: EventEnvelope
): boolean => {
  if (isEnvelopeCoveredByCursor(envelope, state.eventStream.cursorBarrier)) {
    return true;
  }
  const sessionId = runtimeEventSessionId(envelope.event);
  if (!sessionId) {
    return false;
  }
  return isEnvelopeCoveredByCursor(
    envelope,
    state.eventStream.cursorBarrierBySessionId?.[sessionId]
  );
};

const runtimeErrorMessageId = (turnId: string): string => `runtime-error:${turnId}`;

const participantIdFor = (conversationId: string, engineId: string): string =>
  `participant-${conversationId}-${engineId}`;

const formatRuntimeErrorText = (
  event: Extract<RuntimeEvent, { type: "runtime.error" }>
): string =>
  event.code ? `Runtime error (${event.code}): ${event.message}` : `Runtime error: ${event.message}`;

const buildActorRef = (event: ActorFields) =>
  event.participantId || event.engineId
    ? {
        participantId: event.participantId,
        engineId: event.engineId
      }
    : undefined;

const addUnique = (items: string[], value: string): string[] =>
  items.includes(value) ? items : [...items, value];

type TurnCollectionKey =
  | "messageIds"
  | "toolCallIds"
  | "terminalIds"
  | "approvalRequestIds"
  | "interactionRequestIds";

const withEventType = (
  state: RendererStoreState,
  event: RuntimeEvent
): RendererStoreState => ({
  ...state,
  lastEventType: event.type,
  refreshSignals: advanceRendererRefreshSignals(state.refreshSignals, event)
});

const ensureConversationSessionLink = (
  state: RendererStoreState,
  conversationId: string,
  sessionId: string,
  timestamp: string,
  engineId?: string,
  activateSession = true
): RendererStoreState => {
  const existing = state.entities.conversations[conversationId];
  const existingEngineIds = existing?.participantEngineIds ?? [];
  const participantEngineIds =
    engineId && engineId !== unknownAgentId
      ? addUnique(existingEngineIds, engineId)
      : existingEngineIds;
  return upsertConversation(state, {
    conversationId,
    workspaceId: existing?.workspaceId,
    participantEngineIds,
    activeSessionId: activateSession ? sessionId : existing?.activeSessionId,
    sessionIds: addUnique(existing?.sessionIds ?? [], sessionId),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    archivedAt: existing?.archivedAt,
    metadata: existing?.metadata
  });
};

const ensureConversationParticipant = (
  state: RendererStoreState,
  conversationId: string,
  engineId: string,
  timestamp: string
): RendererStoreState => {
  const existing = state.entities.conversations[conversationId];
  return upsertConversation(state, {
    conversationId,
    workspaceId: existing?.workspaceId,
    participantEngineIds: addUnique(existing?.participantEngineIds ?? [], engineId),
    activeSessionId: existing?.activeSessionId,
    sessionIds: existing?.sessionIds ?? [],
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    archivedAt: existing?.archivedAt,
    metadata: existing?.metadata
  });
};

const getActiveSessionIdsForParticipant = (
  state: RendererStoreState,
  conversationId: string,
  engineId: string
): string[] =>
  Object.values(state.entities.sessions)
    .filter(
      (session) =>
        session.conversationId === conversationId &&
        session.engineId === engineId &&
        !session.archivedAt
    )
    .sort((left, right) => {
      const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
      if (byUpdatedAt !== 0) {
        return byUpdatedAt;
      }
      return left.sessionId.localeCompare(right.sessionId);
    })
    .map((session) => session.sessionId);

const syncParticipantState = (
  state: RendererStoreState,
  conversationId: string,
  engineId: string
): RendererStoreState => {
  const conversation = state.entities.conversations[conversationId];
  if (!conversation) {
    return state;
  }

  const participantId = participantIdFor(conversationId, engineId);
  const existing = state.entities.participants[participantId];
  return upsertParticipant(state, {
    participantId,
    conversationId,
    engineId,
    role:
      existing?.role ??
      (conversation.participantEngineIds[0] === engineId ? "primary" : "secondary"),
    capabilities: existing?.capabilities ?? [],
    activeSessionIds: getActiveSessionIdsForParticipant(state, conversationId, engineId),
    metadata: existing?.metadata
  });
};

const ensureTurnExists = (
  state: RendererStoreState,
  turnId: string,
  sessionId: string,
  timestamp: string,
  actor?: ActorRef
): RendererStoreState => {
  const existing = state.entities.turns[turnId];
  if (existing) {
    if (actor && !existing.actor) {
      return upsertTurn(state, {
        ...existing,
        actor
      });
    }
    return state;
  }
  return upsertTurn(state, {
    turnId,
    sessionId,
    status: "streaming",
    startedAt: timestamp,
    actor,
    finalMessageId: undefined,
    messageIds: [],
    toolCallIds: [],
    terminalIds: [],
    approvalRequestIds: [],
    interactionRequestIds: []
  });
};

const appendTurnCollection = (
  state: RendererStoreState,
  turnId: string,
  sessionId: string,
  key: TurnCollectionKey,
  valueId: string,
  timestamp: string,
  actor?: ActorRef
): RendererStoreState => {
  const ensured = ensureTurnExists(state, turnId, sessionId, timestamp, actor);
  const turn = ensured.entities.turns[turnId];
  const currentIds = turn?.[key] ?? [];
  if (!turn) {
    return ensured;
  }
  const nextIds = currentIds.includes(valueId) ? currentIds : [...currentIds, valueId];
  const nextActor = turn.actor ?? actor;
  if (nextIds === currentIds && nextActor === turn.actor) {
    return ensured;
  }
  return upsertTurn(ensured, {
    ...turn,
    actor: nextActor,
    [key]: nextIds
  });
};

const selectFinalAssistantMessageId = (
  state: RendererStoreState,
  messageIds: readonly string[]
): string | undefined => {
  for (let index = messageIds.length - 1; index >= 0; index -= 1) {
    const candidateMessageId = messageIds[index];
    if (!candidateMessageId) {
      continue;
    }
    const assistantBlocks = Object.values(state.entities.messageBlocks).filter(
      (block) => block.messageId === candidateMessageId && block.role === "assistant"
    );
    const hasPhaseAwareBlocks = assistantBlocks.some((block) => block.phase);
    const hasFallbackEligibleBlocks = assistantBlocks.some(
      (block) => block.phase === "final_answer" || (!hasPhaseAwareBlocks && !block.phase)
    );
    if (hasFallbackEligibleBlocks) {
      return candidateMessageId;
    }
  }
  return undefined;
};

const setSessionStatus = (
  state: RendererStoreState,
  sessionId: string,
  status: "idle" | "running" | "awaiting_approval" | "error" | "completed",
  timestamp: string,
  lastTurnId?: string
): RendererStoreState => {
  const existing = state.entities.sessions[sessionId];
  if (!existing) {
    return state;
  }
  const withSession = upsertSession(state, {
    ...existing,
    status,
    updatedAt: timestamp,
    lastTurnId: lastTurnId ?? existing.lastTurnId
  });
  const conversation = withSession.entities.conversations[existing.conversationId];
  if (!conversation) {
    return withSession;
  }
  return upsertConversation(withSession, {
    ...conversation,
    activeSessionId:
      status === "running" || status === "awaiting_approval"
        ? sessionId
        : conversation.activeSessionId,
    updatedAt: timestamp
  });
};

const buildMessageDeltaBlock = (
  event: Extract<RuntimeEvent, { type: "message.delta" }>,
  timestamp: string
): MessageBlock => {
  return {
    blockId: `${event.messageId}${markdownBlockSuffix}`,
    messageId: event.messageId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    role: "assistant",
    kind: "markdown",
    text: "",
    actor: buildActorRef(event),
    startedAt: timestamp
  };
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

const sortByIsoAsc = <T>(
  values: readonly T[],
  selectIso: (item: T) => string | undefined,
  selectId: (item: T) => string
): T[] =>
  [...values].sort((left, right) => {
    const byIso = compareIsoAsc(selectIso(left), selectIso(right));
    if (byIso !== 0) {
      return byIso;
    }
    return selectId(left).localeCompare(selectId(right));
  });

const rebuildIndexesFromEntities = (
  entities: RendererStoreState["entities"]
): RendererStoreState["indexes"] => {
  let state: RendererStoreState = {
    ...createInitialRendererStoreState(),
    entities,
    indexes: createEmptyIndexes()
  };

  for (const conversation of Object.values(entities.conversations)) {
    state = upsertConversation(state, conversation);
  }
  for (const session of Object.values(entities.sessions)) {
    state = upsertSession(state, session);
  }
  for (const turn of Object.values(entities.turns)) {
    state = upsertTurn(state, turn);
  }
  for (const block of Object.values(entities.messageBlocks)) {
    state = upsertMessageBlock(state, block);
  }
  for (const toolCall of Object.values(entities.toolCalls)) {
    state = upsertToolCall(state, toolCall);
  }
  for (const terminal of Object.values(entities.terminalStreams)) {
    state = upsertTerminalStream(state, terminal);
  }
  for (const approval of Object.values(entities.approvalRequests)) {
    state = upsertApprovalRequest(state, approval);
  }
  for (const interaction of Object.values(entities.runtimeInteractions)) {
    state = upsertRuntimeInteraction(state, interaction);
  }
  for (const participant of Object.values(entities.participants)) {
    state = upsertParticipant(state, participant);
  }
  for (const relation of Object.values(entities.sessionRelations)) {
    state = upsertSessionRelation(state, relation);
  }

  return state.indexes;
};

const disposeSessionState = (
  state: RendererStoreState,
  sessionId: string
): RendererStoreState => {
  const removedSession = state.entities.sessions[sessionId];
  if (!removedSession) {
    return state;
  }

  const nextSessions = Object.fromEntries(
    Object.entries(state.entities.sessions).filter(([id]) => id !== sessionId)
  );
  const remainingSessionIds = new Set(Object.keys(nextSessions));

  const nextTurns = Object.fromEntries(
    Object.entries(state.entities.turns).filter(([, turn]) => turn.sessionId !== sessionId)
  );
  const nextMessageBlocks = Object.fromEntries(
    Object.entries(state.entities.messageBlocks).filter(
      ([, block]) => block.sessionId !== sessionId
    )
  );
  const nextToolCalls = Object.fromEntries(
    Object.entries(state.entities.toolCalls).filter(
      ([, toolCall]) => toolCall.sessionId !== sessionId
    )
  );
  const nextTerminalStreams = Object.fromEntries(
    Object.entries(state.entities.terminalStreams).filter(
      ([, terminal]) => terminal.sessionId !== sessionId
    )
  );
  const nextApprovalRequests = Object.fromEntries(
    Object.entries(state.entities.approvalRequests).filter(
      ([, approval]) => approval.sessionId !== sessionId
    )
  );
  const nextRuntimeInteractions = Object.fromEntries(
    Object.entries(state.entities.runtimeInteractions).filter(
      ([, interaction]) => interaction.sessionId !== sessionId
    )
  );
  const nextThreadGoals = Object.fromEntries(
    Object.entries(state.entities.threadGoals).filter(
      ([goalSessionId]) => goalSessionId !== sessionId
    )
  );
  const nextSessionRelations = Object.fromEntries(
    Object.entries(state.entities.sessionRelations).filter(
      ([, relation]) =>
        relation.parentSessionId !== sessionId && relation.childSessionId !== sessionId
    )
  );

  const nextConversations: RendererStoreState["entities"]["conversations"] = {};
  for (const [conversationId, conversation] of Object.entries(
    state.entities.conversations
  )) {
    const sessionIds = conversation.sessionIds.filter(
      (candidate) => candidate !== sessionId && remainingSessionIds.has(candidate)
    );
    if (sessionIds.length === 0) {
      continue;
    }
    nextConversations[conversationId] = {
      ...conversation,
      sessionIds,
      activeSessionId: sessionIds.includes(conversation.activeSessionId ?? "")
        ? conversation.activeSessionId
        : sessionIds[0]
    };
  }

  const remainingConversationIds = new Set(Object.keys(nextConversations));
  const nextParticipants: RendererStoreState["entities"]["participants"] = {};
  for (const [participantId, participant] of Object.entries(state.entities.participants)) {
    if (!remainingConversationIds.has(participant.conversationId)) {
      continue;
    }
    nextParticipants[participantId] = {
      ...participant,
      activeSessionIds: participant.activeSessionIds.filter((candidate) =>
        remainingSessionIds.has(candidate)
      )
    };
  }

  const nextEntities: RendererStoreState["entities"] = {
    conversations: nextConversations,
    sessions: nextSessions,
    turns: nextTurns,
    messageBlocks: nextMessageBlocks,
    toolCalls: nextToolCalls,
    terminalStreams: nextTerminalStreams,
    approvalRequests: nextApprovalRequests,
    runtimeInteractions: nextRuntimeInteractions,
    participants: nextParticipants,
    threadGoals: nextThreadGoals,
    sessionRelations: nextSessionRelations
  };

  const nextActiveConversationId =
    state.activeConversationId &&
    remainingConversationIds.has(state.activeConversationId)
      ? state.activeConversationId
      : Object.keys(nextConversations)[0];
  const nextActiveSessionId =
    state.activeSessionId && remainingSessionIds.has(state.activeSessionId)
      ? state.activeSessionId
      : nextActiveConversationId
        ? nextConversations[nextActiveConversationId]?.activeSessionId
        : Object.keys(nextSessions)[0];

  return {
    ...state,
    entities: nextEntities,
    indexes: rebuildIndexesFromEntities(nextEntities),
    activeConversationId: nextActiveConversationId,
    activeSessionId: nextActiveSessionId
  };
};

const applyRuntimeEvent = (
  state: RendererStoreState,
  event: RuntimeEvent,
  occurredAt?: string
): RendererStoreState => {
  const timestamp = occurredAt ?? nowIso();
  switch (event.type) {
    case "conversation.updated": {
      const existing = state.entities.conversations[event.conversationId];
      const participantEngineIds = [
        ...(existing?.participantEngineIds ?? []),
        ...event.participantIds
          .map((participantId) => state.entities.participants[participantId]?.engineId)
          .filter((engineId): engineId is string => Boolean(engineId))
      ].reduce<string[]>((acc, value) => addUnique(acc, value), []);
      const sessionIds = event.activeSessionId
        ? addUnique(existing?.sessionIds ?? [], event.activeSessionId)
        : existing?.sessionIds ?? [];
      return upsertConversation(withEventType(state, event), {
        conversationId: event.conversationId,
        workspaceId: event.workspaceId ?? existing?.workspaceId,
        participantEngineIds,
        activeSessionId: event.activeSessionId ?? existing?.activeSessionId,
        sessionIds,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        archivedAt: existing?.archivedAt,
        metadata: existing?.metadata
      });
    }
    case "session.created": {
      const withSession = upsertSession(withEventType(state, event), {
        sessionId: event.sessionId,
        conversationId: event.conversationId,
        engineId: event.engineId,
        status: event.status,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const withConversation = ensureConversationSessionLink(
        withSession,
        event.conversationId,
        event.sessionId,
        timestamp,
        event.engineId
      );
      const withRelation = event.relation
        ? upsertSessionRelation(withConversation, event.relation)
        : withConversation;
      return syncParticipantState(withRelation, event.conversationId, event.engineId);
    }
    case "session.updated": {
      const existing = state.entities.sessions[event.sessionId];
      const engineId = existing?.engineId ?? unknownAgentId;
      const withSession = upsertSession(withEventType(state, event), {
        sessionId: event.sessionId,
        conversationId: event.conversationId,
        engineId,
        status: event.status,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        archivedAt: existing?.archivedAt,
        lastTurnId: existing?.lastTurnId,
        title: event.title ?? existing?.title,
        contextUsage: existing?.contextUsage,
        metadata: event.metadata ?? existing?.metadata
      });
      const withConversation = ensureConversationSessionLink(
        withSession,
        event.conversationId,
        event.sessionId,
        timestamp,
        engineId,
        event.status === "running" || event.status === "awaiting_approval"
      );
      return syncParticipantState(
        withConversation,
        event.conversationId,
        engineId
      );
    }
    case "session.context.updated": {
      const existing = state.entities.sessions[event.sessionId];
      if (!existing) {
        return withEventType(state, event);
      }
      return upsertSession(withEventType(state, event), {
        ...existing,
        contextUsage: event.contextUsage,
        updatedAt: timestamp
      });
    }
    case "session.archived": {
      const existing = state.entities.sessions[event.sessionId];
      if (!existing) {
        return withEventType(state, event);
      }
      const withSession = upsertSession(
        withEventType(state, event),
        {
          ...existing,
          archivedAt: event.archivedAt,
          updatedAt: timestamp
        }
      );
      return syncParticipantState(
        withSession,
        existing.conversationId,
        existing.engineId
      );
    }
    case "session.disposed": {
      if (!state.entities.sessions[event.sessionId]) {
        return withEventType(state, event);
      }
      return withEventType(disposeSessionState(state, event.sessionId), event);
    }
    case "turn.started": {
      const existing = state.entities.turns[event.turnId];
      const withTurn = upsertTurn(
        withEventType(state, event),
        {
          turnId: event.turnId,
          sessionId: event.sessionId,
          status: existing?.status ?? "started",
          finishReason: existing?.finishReason,
          startedAt: existing?.startedAt ?? timestamp,
          completedAt: existing?.completedAt,
          actor: existing?.actor,
          finalMessageId: existing?.finalMessageId,
          messageIds: existing?.messageIds ?? [],
          toolCallIds: existing?.toolCallIds ?? [],
          terminalIds: existing?.terminalIds ?? [],
          approvalRequestIds: existing?.approvalRequestIds ?? [],
          interactionRequestIds: existing?.interactionRequestIds ?? []
        }
      );
      return existing?.status === "completed"
        ? withTurn
        : setSessionStatus(withTurn, event.sessionId, "running", timestamp, event.turnId);
    }
    case "turn.completed": {
      const existing = state.entities.turns[event.turnId];
      const finalMessageId =
        existing?.finalMessageId ??
        selectFinalAssistantMessageId(state, existing?.messageIds ?? []);
      const withTurn = upsertTurn(
        withEventType(state, event),
        {
          turnId: event.turnId,
          sessionId: event.sessionId,
          status: "completed",
          finishReason: event.finishReason,
          startedAt: existing?.startedAt ?? timestamp,
          completedAt: timestamp,
          actor: existing?.actor,
          finalMessageId,
          messageIds: existing?.messageIds ?? [],
          toolCallIds: existing?.toolCallIds ?? [],
          terminalIds: existing?.terminalIds ?? [],
          approvalRequestIds: existing?.approvalRequestIds ?? [],
          interactionRequestIds: existing?.interactionRequestIds ?? []
        }
      );
      return setSessionStatus(
        withTurn,
        event.sessionId,
        event.finishReason === "failed" ? "error" : "idle",
        timestamp,
        event.turnId
      );
    }
    case "message.started": {
      const current = state.entities.messageBlocks[`${event.messageId}${markdownBlockSuffix}`];
      const withBlock = upsertMessageBlock(
        withEventType(state, event),
        {
          blockId: `${event.messageId}${markdownBlockSuffix}`,
          messageId: event.messageId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          role: current?.role ?? event.role,
          phase: event.phase ?? current?.phase,
          kind: "markdown",
          text: current?.text ?? "",
          actor: current?.actor ?? buildActorRef(event),
          startedAt: current?.startedAt ?? timestamp,
          completedAt: current?.completedAt
        }
      );
      return appendTurnCollection(
        withBlock,
        event.turnId,
        event.sessionId,
        "messageIds",
        event.messageId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "message.delta": {
      const current = state.entities.messageBlocks[`${event.messageId}${markdownBlockSuffix}`];
      const base = current ?? buildMessageDeltaBlock(event, timestamp);
      const withBlock = upsertMessageBlock(
        withEventType(state, event),
        {
          ...base,
          phase: event.phase ?? base.phase,
          text: appendLimitedStreamText(base.text, event.delta)
        }
      );
      return appendTurnCollection(
        withBlock,
        event.turnId,
        event.sessionId,
        "messageIds",
        event.messageId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "message.completed": {
      const current = state.entities.messageBlocks[`${event.messageId}${markdownBlockSuffix}`];
      const base =
        current ??
        ({
          blockId: `${event.messageId}${markdownBlockSuffix}`,
          messageId: event.messageId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          role: "assistant",
          phase: event.phase,
          kind: "markdown",
          text: "",
          actor: buildActorRef(event),
          startedAt: timestamp
        } satisfies MessageBlock);
      const withBlock = upsertMessageBlock(
        withEventType(state, event),
        {
          ...base,
          phase: event.phase ?? base.phase,
          text:
            event.finalText !== undefined
              ? appendLimitedStreamText(undefined, event.finalText)
              : base.text ?? "",
          actor: base.actor ?? buildActorRef(event),
          completedAt: timestamp
        }
      );
      const withTurnCollection = appendTurnCollection(
        withBlock,
        event.turnId,
        event.sessionId,
        "messageIds",
        event.messageId,
        timestamp,
        buildActorRef(event)
      );
      if (event.isFinalForTurn === true) {
        const turn = withTurnCollection.entities.turns[event.turnId];
        if (!turn) {
          return withTurnCollection;
        }
        return upsertTurn(withTurnCollection, {
          ...turn,
          finalMessageId: event.messageId
        });
      }
      return withTurnCollection;
    }
    case "tool.started": {
      const current = state.entities.toolCalls[event.toolCallId];
      const withTool = upsertToolCall(
        withEventType(state, event),
        {
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolName: event.toolName,
          status: current?.completedAt ? current.status : "running",
          inputSummary: event.inputSummary ?? current?.inputSummary,
          outputSummary: current?.outputSummary,
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              engineId: event.engineId
            },
          startedAt: current?.startedAt ?? timestamp,
          completedAt: current?.completedAt
        }
      );
      return appendTurnCollection(
        withTool,
        event.turnId,
        event.sessionId,
        "toolCallIds",
        event.toolCallId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "tool.delta": {
      const current = state.entities.toolCalls[event.toolCallId];
      const withTool = upsertToolCall(
        withEventType(state, event),
        {
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolName: current?.toolName ?? unknownToolName,
          status: current?.status ?? "running",
          inputSummary: current?.inputSummary,
          outputSummary: appendLimitedStreamText(current?.outputSummary, event.delta),
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              engineId: event.engineId
            },
          startedAt: current?.startedAt ?? timestamp,
          completedAt: current?.completedAt
        }
      );
      return appendTurnCollection(
        withTool,
        event.turnId,
        event.sessionId,
        "toolCallIds",
        event.toolCallId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "tool.completed": {
      const current = state.entities.toolCalls[event.toolCallId];
      const withTool = upsertToolCall(
        withEventType(state, event),
        {
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolName: current?.toolName ?? unknownToolName,
          status: event.status,
          outputSummary:
            event.outputSummary != null
              ? appendLimitedStreamText(undefined, event.outputSummary)
              : current?.outputSummary,
          inputSummary: current?.inputSummary,
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              engineId: event.engineId
            },
          startedAt: current?.startedAt ?? timestamp,
          completedAt: timestamp
        }
      );
      return appendTurnCollection(
        withTool,
        event.turnId,
        event.sessionId,
        "toolCallIds",
        event.toolCallId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "terminal.started": {
      const current = state.entities.terminalStreams[event.terminalId];
      const withTerminal = upsertTerminalStream(
        withEventType(state, event),
        {
          terminalId: event.terminalId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolCallId: event.toolCallId ?? current?.toolCallId,
          status: current?.completedAt ? current.status : "running",
          outputText: current?.outputText ?? "",
          exitCode: current?.exitCode,
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              engineId: event.engineId
            },
          startedAt: current?.startedAt ?? timestamp,
          completedAt: current?.completedAt
        }
      );
      return appendTurnCollection(
        withTerminal,
        event.turnId,
        event.sessionId,
        "terminalIds",
        event.terminalId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "terminal.output": {
      const current = state.entities.terminalStreams[event.terminalId];
      const withTerminal = upsertTerminalStream(
        withEventType(state, event),
        {
          terminalId: event.terminalId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolCallId: current?.toolCallId,
          status: current?.status ?? "running",
          outputText: appendLimitedStreamText(current?.outputText, event.chunk),
          exitCode: current?.exitCode,
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              engineId: event.engineId
            },
          startedAt: current?.startedAt ?? timestamp,
          completedAt: current?.completedAt
        }
      );
      return appendTurnCollection(
        withTerminal,
        event.turnId,
        event.sessionId,
        "terminalIds",
        event.terminalId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "terminal.completed": {
      const current = state.entities.terminalStreams[event.terminalId];
      const status =
        typeof event.exitCode === "number" && event.exitCode !== 0 ? "failed" : "completed";
      const withTerminal = upsertTerminalStream(
        withEventType(state, event),
        {
          terminalId: event.terminalId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolCallId: current?.toolCallId,
          status,
          outputText: current?.outputText ?? "",
          exitCode: event.exitCode,
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              engineId: event.engineId
            },
          startedAt: current?.startedAt ?? timestamp,
          completedAt: timestamp
        }
      );
      return appendTurnCollection(
        withTerminal,
        event.turnId,
        event.sessionId,
        "terminalIds",
        event.terminalId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "approval.requested": {
      const withApproval = upsertApprovalRequest(
        withEventType(state, event),
        {
          requestId: event.requestId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          approvalKind: event.approvalKind,
          status: "pending",
          title: event.title,
          details: event.details,
          availableActions: event.availableActions,
          metadata: event.metadata,
          actor: {
            participantId: event.participantId,
            engineId: event.engineId
          },
          requestedAt: timestamp
        }
      );
      return setSessionStatus(
        appendTurnCollection(
          withApproval,
          event.turnId,
          event.sessionId,
          "approvalRequestIds",
          event.requestId,
          timestamp,
          buildActorRef(event)
        ),
        event.sessionId,
        "awaiting_approval",
        timestamp,
        event.turnId
      );
    }
    case "approval.resolved": {
      const current = state.entities.approvalRequests[event.requestId];
      if (!current) {
        return appendTurnCollection(
          withEventType(state, event),
          event.turnId,
          event.sessionId,
          "approvalRequestIds",
          event.requestId,
          timestamp,
          buildActorRef(event)
        );
      }
      const withApproval = upsertApprovalRequest(
        withEventType(state, event),
        {
          ...current,
          status:
            event.action === "approve"
              ? "approved"
              : event.action === "deny"
                ? "denied"
                : "deferred",
          resolvedAt: timestamp
        }
      );
      return appendTurnCollection(
        withApproval,
        event.turnId,
        event.sessionId,
        "approvalRequestIds",
        event.requestId,
        timestamp,
        buildActorRef(event)
      );
    }
    case "interaction.requested": {
      const withInteraction = upsertRuntimeInteraction(
        withEventType(state, event),
        {
          requestId: event.requestId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          interactionKind: event.interactionKind,
          status: "pending",
          title: event.title,
          details: event.details,
          payload: event.payload,
          actor: {
            participantId: event.participantId,
            engineId: event.engineId
          },
          requestedAt: timestamp
        }
      );
      return event.turnId
        ? appendTurnCollection(
            withInteraction,
            event.turnId,
            event.sessionId,
            "interactionRequestIds",
            event.requestId,
            timestamp,
            buildActorRef(event)
          )
        : withInteraction;
    }
    case "interaction.resolved": {
      const current = state.entities.runtimeInteractions[event.requestId];
      const status =
        event.action === "accept"
          ? "accepted"
          : event.action === "submit"
            ? "submitted"
            : event.action === "decline"
              ? "declined"
              : event.action === "cancel"
                ? "cancelled"
                : "deferred";
      const withInteraction = upsertRuntimeInteraction(
        withEventType(state, event),
        {
          requestId: event.requestId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          interactionKind: current?.interactionKind ?? "tool_user_input",
          status,
          title: current?.title ?? "Input requested",
          details: current?.details,
          payload: current?.payload ?? {},
          response: event.response,
          actor: current?.actor ?? {
            participantId: event.participantId,
            engineId: event.engineId
          },
          requestedAt: current?.requestedAt ?? timestamp,
          resolvedAt: timestamp
        }
      );
      return event.turnId
        ? appendTurnCollection(
            withInteraction,
            event.turnId,
            event.sessionId,
            "interactionRequestIds",
            event.requestId,
            timestamp,
            buildActorRef(event)
          )
        : withInteraction;
    }
    case "participant.updated": {
      const withParticipant = upsertParticipant(
        withEventType(state, event),
        {
          participantId: event.participantId,
          conversationId: event.conversationId,
          engineId: event.engineId,
          role: event.role,
          capabilities: event.capabilities,
          activeSessionIds: getActiveSessionIdsForParticipant(
            state,
            event.conversationId,
            event.engineId
          )
        }
      );
      return ensureConversationParticipant(
        withParticipant,
        event.conversationId,
        event.engineId,
        timestamp
      );
    }
    case "conversationGraph.updated": {
      return withEventType(state, event);
    }
    case "thread.goal.updated": {
      return upsertThreadGoal(withEventType(state, event), event.goal);
    }
    case "thread.goal.cleared": {
      return deleteThreadGoal(withEventType(state, event), event.sessionId);
    }
    case "engineExtension.updated": {
      return withEventType(state, event);
    }
    case "runtime.error": {
      const withError = {
        ...withEventType(state, event),
        lastError: {
          code: event.code,
          message: event.message,
          recoverable: event.recoverable
        }
      };
      if (event.recoverable) {
        return withError;
      }
      if (!event.sessionId || !event.turnId) {
        return withError;
      }

      const existingTurn = withError.entities.turns[event.turnId];
      const messageId =
        existingTurn?.messageIds.find((candidateMessageId) => {
          const block = withError.entities.messageBlocks[`${candidateMessageId}${markdownBlockSuffix}`];
          return block !== undefined && (block.text ?? "").trim().length === 0;
        }) ?? runtimeErrorMessageId(event.turnId);
      const blockId = `${messageId}${markdownBlockSuffix}`;
      const existingBlock = withError.entities.messageBlocks[blockId];
      const withBlock = upsertMessageBlock(withError, {
        blockId,
        messageId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        role: "system",
        kind: "markdown",
        text: formatRuntimeErrorText(event),
        actor: existingBlock?.actor,
        startedAt: existingBlock?.startedAt ?? timestamp,
        completedAt: timestamp
      });
      const withTurnCollection = appendTurnCollection(
        withBlock,
        event.turnId,
        event.sessionId,
        "messageIds",
        messageId,
        timestamp
      );
      const turn = withTurnCollection.entities.turns[event.turnId];
      const withTurn = upsertTurn(withTurnCollection, {
        turnId: event.turnId,
        sessionId: event.sessionId,
        status: "completed",
        finishReason: "failed",
        startedAt: turn?.startedAt ?? timestamp,
        completedAt: timestamp,
        actor: turn?.actor,
        finalMessageId: turn?.finalMessageId,
        messageIds: turn?.messageIds ?? [messageId],
        toolCallIds: turn?.toolCallIds ?? [],
        terminalIds: turn?.terminalIds ?? [],
        approvalRequestIds: turn?.approvalRequestIds ?? [],
        interactionRequestIds: turn?.interactionRequestIds ?? []
      });
      const existingSession = withTurn.entities.sessions[event.sessionId];
      if (!existingSession) {
        return withTurn;
      }
      const withSession = upsertSession(withTurn, {
        ...existingSession,
        status: "error",
        lastTurnId: event.turnId,
        updatedAt: timestamp
      });
      const conversation = withSession.entities.conversations[existingSession.conversationId];
      return conversation
        ? upsertConversation(withSession, {
            ...conversation,
            updatedAt: timestamp
          })
        : withSession;
    }
    default: {
      return state;
    }
  }
};

const markEnvelopeInEventStream = (
  state: RendererStoreState,
  envelope: EventEnvelope
): RendererStoreState => {
  return markEnvelopesInEventStream(state, [envelope]);
};

const markGlobalCursorBarrier = (
  state: RendererStoreState,
  cursor: string | undefined
): RendererStoreState => {
  if (!cursor) {
    return state;
  }
  const barrierComparison = compareCursorPosition(
    cursor,
    state.eventStream.cursorBarrier
  );
  if (barrierComparison !== undefined && barrierComparison <= 0) {
    return state;
  }
  const lastCursorComparison = compareCursorPosition(
    cursor,
    state.eventStream.lastCursor
  );
  const lastCursor =
    lastCursorComparison !== undefined && lastCursorComparison <= 0
      ? state.eventStream.lastCursor
      : cursor;
  return {
    ...state,
    eventStream: {
      ...state.eventStream,
      lastCursor,
      cursorBarrier: cursor
    }
  };
};

const markSessionCursorBarrier = (
  state: RendererStoreState,
  sessionId: string,
  cursor: string | undefined
): RendererStoreState => {
  if (!cursor) {
    return state;
  }
  const currentBarrier = state.eventStream.cursorBarrierBySessionId?.[sessionId];
  const comparison = compareCursorPosition(cursor, currentBarrier);
  if (comparison !== undefined && comparison <= 0) {
    return state;
  }
  return {
    ...state,
    eventStream: {
      ...state.eventStream,
      cursorBarrierBySessionId: {
        ...(state.eventStream.cursorBarrierBySessionId ?? {}),
        [sessionId]: cursor
      }
    }
  };
};

const markEnvelopesInEventStream = (
  state: RendererStoreState,
  envelopes: EventEnvelope[]
): RendererStoreState => {
  if (envelopes.length === 0) {
    return state;
  }
  const recentEventIds = [
    ...(state.eventStream.recentEventIds ?? []),
    ...envelopes.map((envelope) => envelope.eventId)
  ];
  const overflow = Math.max(0, recentEventIds.length - maxSeenEventIds);
  const trimmedRecentEventIds =
    overflow > 0 ? recentEventIds.slice(overflow) : recentEventIds;
  const seenEventIds = trimmedRecentEventIds.reduce<Record<string, true>>(
    (acc, eventId) => {
      acc[eventId] = true;
      return acc;
    },
    {}
  );

  const lastEnvelope = envelopes[envelopes.length - 1]!;
  return {
    ...state,
    eventStream: {
      lastEventId: lastEnvelope.eventId,
      lastCursor: lastEnvelope.cursor,
      cursorBarrier: state.eventStream.cursorBarrier,
      cursorBarrierBySessionId: state.eventStream.cursorBarrierBySessionId,
      lastOccurredAt: lastEnvelope.occurredAt,
      recentEventIds: trimmedRecentEventIds,
      seenEventIds
    }
  };
};

const sameOptional = (left: unknown, right: unknown): boolean => left === right;

const mergeRuntimeEvents = (
  previous: RuntimeEvent,
  next: RuntimeEvent
): RuntimeEvent | undefined => {
  if (previous.type !== next.type) {
    return undefined;
  }
  switch (next.type) {
    case "message.delta":
      if (
        previous.type === "message.delta" &&
        previous.sessionId === next.sessionId &&
        previous.turnId === next.turnId &&
        previous.messageId === next.messageId &&
        sameOptional(previous.engineId, next.engineId) &&
        sameOptional(previous.participantId, next.participantId) &&
        sameOptional(previous.phase, next.phase)
      ) {
        return {
          ...next,
          delta: appendLimitedStreamText(previous.delta, next.delta)
        };
      }
      return undefined;
    case "tool.delta":
      if (
        previous.type === "tool.delta" &&
        previous.sessionId === next.sessionId &&
        previous.turnId === next.turnId &&
        previous.toolCallId === next.toolCallId &&
        sameOptional(previous.engineId, next.engineId) &&
        sameOptional(previous.participantId, next.participantId)
      ) {
        return {
          ...next,
          delta: appendLimitedStreamText(previous.delta, next.delta)
        };
      }
      return undefined;
    case "terminal.output":
      if (
        previous.type === "terminal.output" &&
        previous.sessionId === next.sessionId &&
        previous.turnId === next.turnId &&
        previous.terminalId === next.terminalId &&
        sameOptional(previous.engineId, next.engineId) &&
        sameOptional(previous.participantId, next.participantId)
      ) {
        return {
          ...next,
          chunk: appendLimitedStreamText(previous.chunk, next.chunk)
        };
      }
      return undefined;
    default:
      return undefined;
  }
};

const coalesceEnvelopesForIngestion = (
  envelopes: EventEnvelope[]
): EventEnvelope[] => {
  const coalesced: EventEnvelope[] = [];
  for (const envelope of envelopes) {
    const previous = coalesced[coalesced.length - 1];
    if (!previous) {
      coalesced.push(envelope);
      continue;
    }
    const mergedEvent = mergeRuntimeEvents(previous.event, envelope.event);
    if (!mergedEvent) {
      coalesced.push(envelope);
      continue;
    }
    coalesced[coalesced.length - 1] = {
      ...envelope,
      event: mergedEvent
    };
  }
  return coalesced;
};

const ingestEnvelope = (
  state: RendererStoreState,
  envelope: EventEnvelope
): RendererStoreState => {
  if (
    state.eventStream.seenEventIds[envelope.eventId] ||
    isEnvelopeCoveredByBarrier(state, envelope)
  ) {
    return state;
  }
  const next = applyRuntimeEvent(state, envelope.event, envelope.occurredAt);
  return markEnvelopeInEventStream(next, envelope);
};

const ingestEnvelopeBatch = (
  state: RendererStoreState,
  envelopes: EventEnvelope[]
): RendererStoreState => {
  const pending: EventEnvelope[] = [];
  const seenInBatch = new Set<string>();
  for (const envelope of envelopes) {
    if (
      state.eventStream.seenEventIds[envelope.eventId] ||
      seenInBatch.has(envelope.eventId) ||
      isEnvelopeCoveredByBarrier(state, envelope)
    ) {
      continue;
    }
    seenInBatch.add(envelope.eventId);
    pending.push(envelope);
  }
  if (pending.length === 0) {
    return state;
  }
  let nextState = state;
  for (const envelope of coalesceEnvelopesForIngestion(pending)) {
    nextState = applyRuntimeEvent(nextState, envelope.event, envelope.occurredAt);
  }
  return markEnvelopesInEventStream(nextState, pending);
};

const applyRendererMetaEvent = (
  state: RendererStoreState,
  event: RuntimeEvent
): RendererStoreState => {
  const next = withEventType(state, event);
  if (event.type === "session.disposed" && state.activeSessionId === event.sessionId) {
    return {
      ...next,
      activeSessionId: undefined
    };
  }
  if (event.type !== "runtime.error") {
    return next;
  }
  return {
    ...next,
    lastError: {
      code: event.code ?? "runtime_error",
      message: event.message,
      recoverable: event.recoverable
    }
  };
};

export const rendererStoreReducer = (
  state: RendererStoreState = createInitialRendererStoreState(),
  action: RendererStoreAction
): RendererStoreState => {
  switch (action.type) {
    case "store/hydrateSnapshot":
      return markGlobalCursorBarrier(
        {
          ...state,
          activeConversationId:
            state.activeConversationId ??
            action.snapshot.conversations.at(0)?.conversationId,
          activeSessionId:
            state.activeSessionId ?? action.snapshot.sessions.at(0)?.sessionId
        },
        action.cursor
      );
    case "store/hydrateSessionWindow": {
      const shouldPreserveActiveSession =
        action.mode !== "prepend" && state.activeSessionId === action.sessionId;
      const nextState =
        action.mode === "prepend"
          ? state
          : markSessionCursorBarrier(
              state,
              action.sessionId,
              action.cursor
            );
      if (!shouldPreserveActiveSession) {
        return nextState;
      }
      const restoredSession =
        action.snapshot.sessions.find(
          (session) => session.sessionId === action.sessionId
        ) ?? state.entities.sessions[action.sessionId];
      if (!restoredSession) {
        return nextState;
      }
      return {
        ...nextState,
        activeConversationId: restoredSession.conversationId,
        activeSessionId: action.sessionId
      };
    }
    case "store/disposeSession":
      return disposeSessionState(state, action.sessionId);
    case "store/ingestEvent":
      return applyRuntimeEvent(state, action.event);
    case "store/ingestEnvelope":
      return ingestEnvelope(state, action.envelope);
    case "store/ingestEnvelopes":
      return ingestEnvelopeBatch(state, action.envelopes);
    case "store/setActiveConversation":
      return {
        ...state,
        activeConversationId: action.conversationId
      };
    case "store/setActiveSession":
      return {
        ...state,
        activeSessionId: action.sessionId
      };
    default:
      return state;
  }
};

const ingestMetaEnvelope = (
  state: RendererStoreState,
  envelope: EventEnvelope
): RendererStoreState => {
  if (
    state.eventStream.seenEventIds[envelope.eventId] ||
    isEnvelopeCoveredByBarrier(state, envelope)
  ) {
    return state;
  }
  return markEnvelopeInEventStream(
    applyRendererMetaEvent(state, envelope.event),
    envelope
  );
};

const ingestMetaEnvelopeBatch = (
  state: RendererStoreState,
  envelopes: EventEnvelope[]
): RendererStoreState => {
  const pending: EventEnvelope[] = [];
  const seenInBatch = new Set<string>();
  for (const envelope of envelopes) {
    if (
      state.eventStream.seenEventIds[envelope.eventId] ||
      seenInBatch.has(envelope.eventId) ||
      isEnvelopeCoveredByBarrier(state, envelope)
    ) {
      continue;
    }
    seenInBatch.add(envelope.eventId);
    pending.push(envelope);
  }
  if (pending.length === 0) {
    return state;
  }
  let nextState = state;
  for (const envelope of coalesceEnvelopesForIngestion(pending)) {
    nextState = applyRendererMetaEvent(nextState, envelope.event);
  }
  return markEnvelopesInEventStream(nextState, pending);
};

export const rendererMetaReducer = (
  state: RendererStoreState = createInitialRendererStoreState(),
  action: RendererStoreAction
): RendererStoreState => {
  switch (action.type) {
    case "store/hydrateSnapshot":
      return markGlobalCursorBarrier(
        {
          ...state,
          activeConversationId:
            state.activeConversationId ??
            action.snapshot.conversations.at(0)?.conversationId,
          activeSessionId:
            state.activeSessionId ?? action.snapshot.sessions.at(0)?.sessionId
        },
        action.cursor
      );
    case "store/hydrateSessionWindow": {
      const nextState =
        action.mode === "prepend"
          ? state
          : markSessionCursorBarrier(state, action.sessionId, action.cursor);
      if (action.mode === "prepend" || state.activeSessionId !== action.sessionId) {
        return nextState;
      }
      const restoredSession = action.snapshot.sessions.find(
        (session) => session.sessionId === action.sessionId
      );
      return restoredSession
        ? {
            ...nextState,
            activeConversationId: restoredSession.conversationId,
            activeSessionId: action.sessionId
          }
        : nextState;
    }
    case "store/disposeSession":
      return state.activeSessionId === action.sessionId
        ? { ...state, activeSessionId: undefined }
        : state;
    case "store/ingestEvent":
      return applyRendererMetaEvent(state, action.event);
    case "store/ingestEnvelope":
      return ingestMetaEnvelope(state, action.envelope);
    case "store/ingestEnvelopes":
      return ingestMetaEnvelopeBatch(state, action.envelopes);
    case "store/setActiveConversation":
      return { ...state, activeConversationId: action.conversationId };
    case "store/setActiveSession":
      return { ...state, activeSessionId: action.sessionId };
    default:
      return state;
  }
};
