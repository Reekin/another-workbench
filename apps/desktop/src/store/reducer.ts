import type {
  DomainSnapshot,
  EventEnvelope,
  MessageBlock,
  RuntimeEvent
} from "@another-workbench/shared";
import type { RendererStoreAction, RendererStoreState } from "./types.js";
import {
  createInitialRendererStoreState,
  upsertApprovalRequest,
  upsertConversation,
  upsertMessageBlock,
  upsertParticipant,
  upsertSession,
  upsertSessionRelation,
  upsertTerminalStream,
  upsertToolCall,
  upsertTurn
} from "./state.js";

const nowIso = (): string => new Date().toISOString();
const unknownAgentId = "unknown-agent";
const unknownToolName = "unknown-tool";
const markdownBlockSuffix = ":md";
const legacyStartBlockSuffix = ":start";
const maxSeenEventIds = 2_048;

type ActorFields = { participantId?: string; agentId?: string };

const buildActorRef = (event: ActorFields) =>
  event.participantId || event.agentId
    ? {
        participantId: event.participantId,
        agentId: event.agentId
      }
    : undefined;

const addUnique = (items: string[], value: string): string[] =>
  items.includes(value) ? items : [...items, value];

type TurnCollectionKey =
  | "messageIds"
  | "toolCallIds"
  | "terminalIds"
  | "approvalRequestIds";

const withEventType = (
  state: RendererStoreState,
  eventType: RuntimeEvent["type"]
): RendererStoreState => ({
  ...state,
  lastEventType: eventType
});

const ensureConversationSessionLink = (
  state: RendererStoreState,
  conversationId: string,
  sessionId: string,
  timestamp: string,
  agentId?: string
): RendererStoreState => {
  const existing = state.entities.conversations[conversationId];
  const existingAgentIds = existing?.participantAgentIds ?? [];
  const participantAgentIds =
    agentId && agentId !== unknownAgentId
      ? addUnique(existingAgentIds, agentId)
      : existingAgentIds;
  return upsertConversation(state, {
    conversationId,
    workspaceId: existing?.workspaceId,
    participantAgentIds,
    activeSessionId: existing?.activeSessionId ?? sessionId,
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
  agentId: string,
  timestamp: string
): RendererStoreState => {
  const existing = state.entities.conversations[conversationId];
  return upsertConversation(state, {
    conversationId,
    workspaceId: existing?.workspaceId,
    participantAgentIds: addUnique(existing?.participantAgentIds ?? [], agentId),
    activeSessionId: existing?.activeSessionId,
    sessionIds: existing?.sessionIds ?? [],
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    archivedAt: existing?.archivedAt,
    metadata: existing?.metadata
  });
};

const ensureTurnExists = (
  state: RendererStoreState,
  turnId: string,
  sessionId: string,
  timestamp: string
): RendererStoreState => {
  if (state.entities.turns[turnId]) {
    return state;
  }
  return upsertTurn(state, {
    turnId,
    sessionId,
    status: "streaming",
    startedAt: timestamp,
    messageIds: [],
    toolCallIds: [],
    terminalIds: [],
    approvalRequestIds: []
  });
};

const appendTurnCollection = (
  state: RendererStoreState,
  turnId: string,
  sessionId: string,
  key: TurnCollectionKey,
  valueId: string,
  timestamp: string
): RendererStoreState => {
  const ensured = ensureTurnExists(state, turnId, sessionId, timestamp);
  const turn = ensured.entities.turns[turnId];
  if (!turn || turn[key].includes(valueId)) {
    return ensured;
  }
  return upsertTurn(ensured, {
    ...turn,
    [key]: [...turn[key], valueId]
  });
};

const setSessionLastTurn = (
  state: RendererStoreState,
  sessionId: string,
  turnId: string,
  timestamp: string
): RendererStoreState => {
  const existing = state.entities.sessions[sessionId];
  if (!existing) {
    return state;
  }
  return upsertSession(state, {
    ...existing,
    lastTurnId: turnId,
    updatedAt: timestamp
  });
};

const hydrateFromSnapshot = (
  initialState: RendererStoreState,
  snapshot: DomainSnapshot
): RendererStoreState => {
  let state = createInitialRendererStoreState();

  for (const conversation of snapshot.conversations) {
    state = upsertConversation(state, conversation);
  }
  for (const session of snapshot.sessions) {
    state = upsertSession(state, session);
  }
  for (const turn of snapshot.turns) {
    state = upsertTurn(state, turn);
  }
  for (const block of normalizeSnapshotMessageBlocks(snapshot.messageBlocks)) {
    state = upsertMessageBlock(state, block);
  }
  for (const toolCall of snapshot.toolCalls) {
    state = upsertToolCall(state, toolCall);
  }
  for (const terminal of snapshot.terminalStreams) {
    state = upsertTerminalStream(state, terminal);
  }
  for (const approval of snapshot.approvalRequests) {
    state = upsertApprovalRequest(state, approval);
  }
  for (const participant of snapshot.participants) {
    state = upsertParticipant(state, participant);
  }
  for (const relation of snapshot.sessionRelations) {
    state = upsertSessionRelation(state, relation);
  }

  return {
    ...state,
    eventStream: initialState.eventStream,
    activeConversationId:
      initialState.activeConversationId ?? snapshot.conversations.at(0)?.conversationId,
    activeSessionId:
      initialState.activeSessionId ?? snapshot.sessions.at(0)?.sessionId,
    lastEventType: initialState.lastEventType,
    lastError: initialState.lastError
  };
};

const mergeSnapshotIntoState = (
  initialState: RendererStoreState,
  snapshot: DomainSnapshot
): RendererStoreState => {
  let state = initialState;

  for (const conversation of snapshot.conversations) {
    state = upsertConversation(state, conversation);
  }
  for (const session of snapshot.sessions) {
    state = upsertSession(state, session);
  }
  for (const turn of snapshot.turns) {
    state = upsertTurn(state, turn);
  }
  for (const block of normalizeSnapshotMessageBlocks(snapshot.messageBlocks)) {
    state = upsertMessageBlock(state, block);
  }
  for (const toolCall of snapshot.toolCalls) {
    state = upsertToolCall(state, toolCall);
  }
  for (const terminal of snapshot.terminalStreams) {
    state = upsertTerminalStream(state, terminal);
  }
  for (const approval of snapshot.approvalRequests) {
    state = upsertApprovalRequest(state, approval);
  }
  for (const participant of snapshot.participants) {
    state = upsertParticipant(state, participant);
  }
  for (const relation of snapshot.sessionRelations) {
    state = upsertSessionRelation(state, relation);
  }

  return state;
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

const normalizeSnapshotMessageBlocks = (blocks: MessageBlock[]): MessageBlock[] => {
  // Older snapshots produced two markdown blocks per message:
  // - `${messageId}:start` (empty placeholder)
  // - `${messageId}:md` (actual markdown stream)
  //
  // We normalize those into a single `${messageId}:md` block so the renderer
  // has a stable display unit and doesn't render a pseudo-empty message.
  const grouped = new Map<string, MessageBlock[]>();
  for (const block of blocks) {
    const bucket = grouped.get(block.messageId);
    if (bucket) {
      bucket.push(block);
    } else {
      grouped.set(block.messageId, [block]);
    }
  }

  const normalized: MessageBlock[] = [];
  for (const [messageId, group] of grouped.entries()) {
    const expectedStartId = `${messageId}${legacyStartBlockSuffix}`;
    const expectedMarkdownId = `${messageId}${markdownBlockSuffix}`;

    const startBlock = group.find((block) => block.blockId === expectedStartId);
    const markdownBlock = group.find((block) => block.blockId === expectedMarkdownId);

    if (markdownBlock) {
      const merged: MessageBlock = startBlock
        ? {
            ...markdownBlock,
            role: markdownBlock.role ?? startBlock.role,
            actor: markdownBlock.actor ?? startBlock.actor,
            startedAt:
              Date.parse(startBlock.startedAt) <= Date.parse(markdownBlock.startedAt)
                ? startBlock.startedAt
                : markdownBlock.startedAt
          }
        : markdownBlock;

      normalized.push(merged);
      for (const block of group) {
        if (block.blockId === expectedStartId || block.blockId === expectedMarkdownId) {
          continue;
        }
        normalized.push(block);
      }
      continue;
    }

    if (startBlock) {
      normalized.push({
        ...startBlock,
        blockId: expectedMarkdownId
      });
      for (const block of group) {
        if (block.blockId === expectedStartId) {
          continue;
        }
        normalized.push(block);
      }
      continue;
    }

    normalized.push(...group);
  }

  return normalized;
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

const buildSnapshotFromState = (
  state: RendererStoreState,
  options: {
    excludeSessionId?: string;
  } = {}
): DomainSnapshot => {
  const sessions = sortByIsoAsc(
    Object.values(state.entities.sessions).filter(
      (session) => session.sessionId !== options.excludeSessionId
    ),
    (session) => session.createdAt,
    (session) => session.sessionId
  );
  const sessionIds = new Set(sessions.map((session) => session.sessionId));
  const sessionsByConversationId = new Map<string, string[]>();

  for (const session of sessions) {
    const bucket = sessionsByConversationId.get(session.conversationId);
    if (bucket) {
      bucket.push(session.sessionId);
    } else {
      sessionsByConversationId.set(session.conversationId, [session.sessionId]);
    }
  }

  return {
    conversations: sortByIsoAsc(
      Object.values(state.entities.conversations).map((conversation) => {
        const nextSessionIds = sessionsByConversationId.get(conversation.conversationId) ?? [];
        const activeSessionId =
          conversation.activeSessionId && sessionIds.has(conversation.activeSessionId)
            ? conversation.activeSessionId
            : nextSessionIds[0];
        return {
          ...conversation,
          activeSessionId,
          sessionIds: nextSessionIds
        };
      }),
      (conversation) => conversation.createdAt,
      (conversation) => conversation.conversationId
    ),
    sessions,
    turns: sortByIsoAsc(
      Object.values(state.entities.turns).filter((turn) => sessionIds.has(turn.sessionId)),
      (turn) => turn.startedAt,
      (turn) => turn.turnId
    ),
    messageBlocks: normalizeSnapshotMessageBlocks(
      sortByIsoAsc(
        Object.values(state.entities.messageBlocks).filter((block) =>
          sessionIds.has(block.sessionId)
        ),
        (block) => block.startedAt,
        (block) => block.blockId
      )
    ),
    toolCalls: sortByIsoAsc(
      Object.values(state.entities.toolCalls).filter((toolCall) =>
        sessionIds.has(toolCall.sessionId)
      ),
      (toolCall) => toolCall.startedAt,
      (toolCall) => toolCall.toolCallId
    ),
    terminalStreams: sortByIsoAsc(
      Object.values(state.entities.terminalStreams).filter((terminalStream) =>
        sessionIds.has(terminalStream.sessionId)
      ),
      (terminalStream) => terminalStream.startedAt,
      (terminalStream) => terminalStream.terminalId
    ),
    approvalRequests: sortByIsoAsc(
      Object.values(state.entities.approvalRequests).filter((approvalRequest) =>
        sessionIds.has(approvalRequest.sessionId)
      ),
      (approvalRequest) => approvalRequest.requestedAt,
      (approvalRequest) => approvalRequest.requestId
    ),
    participants: Object.values(state.entities.participants)
      .map((participant) => ({
        ...participant,
        activeSessionIds: sessions
          .filter(
            (session) =>
              session.conversationId === participant.conversationId &&
              session.agentId === participant.agentId &&
              !session.archivedAt
          )
          .map((session) => session.sessionId)
      }))
      .sort((left, right) => left.participantId.localeCompare(right.participantId)),
    sessionRelations: sortByIsoAsc(
      Object.values(state.entities.sessionRelations).filter(
        (relation) =>
          sessionIds.has(relation.parentSessionId) && sessionIds.has(relation.childSessionId)
      ),
      (relation) => relation.createdAt,
      (relation) => relation.relationId
    )
  };
};

const buildSelectionFromSnapshot = (
  state: RendererStoreState,
  snapshot: DomainSnapshot
): Pick<RendererStoreState, "activeConversationId" | "activeSessionId"> => {
  const activeConversationId =
    state.activeConversationId &&
    snapshot.conversations.some(
      (conversation) => conversation.conversationId === state.activeConversationId
    )
      ? state.activeConversationId
      : snapshot.conversations[0]?.conversationId;
  const activeConversation = activeConversationId
    ? snapshot.conversations.find(
        (conversation) => conversation.conversationId === activeConversationId
      )
    : undefined;
  const activeSessionId =
    state.activeSessionId &&
    snapshot.sessions.some((session) => session.sessionId === state.activeSessionId)
      ? state.activeSessionId
      : activeConversation?.activeSessionId ?? snapshot.sessions[0]?.sessionId;

  return {
    activeConversationId,
    activeSessionId
  };
};

const disposeSessionState = (
  state: RendererStoreState,
  sessionId: string
): RendererStoreState => {
  const snapshot = buildSnapshotFromState(state, {
    excludeSessionId: sessionId
  });
  return hydrateFromSnapshot(
    {
      ...state,
      ...buildSelectionFromSnapshot(state, snapshot)
    },
    snapshot
  );
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
      const participantAgentIds = [
        ...(existing?.participantAgentIds ?? []),
        ...event.participantIds
          .map((participantId) => state.entities.participants[participantId]?.agentId)
          .filter((agentId): agentId is string => Boolean(agentId))
      ].reduce<string[]>((acc, value) => addUnique(acc, value), []);
      const sessionIds = event.activeSessionId
        ? addUnique(existing?.sessionIds ?? [], event.activeSessionId)
        : existing?.sessionIds ?? [];
      return upsertConversation(withEventType(state, event.type), {
        conversationId: event.conversationId,
        workspaceId: event.workspaceId ?? existing?.workspaceId,
        participantAgentIds,
        activeSessionId: event.activeSessionId ?? existing?.activeSessionId,
        sessionIds,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        archivedAt: existing?.archivedAt,
        metadata: existing?.metadata
      });
    }
    case "session.created": {
      const withSession = upsertSession(withEventType(state, event.type), {
        sessionId: event.sessionId,
        conversationId: event.conversationId,
        agentId: event.agentId,
        status: event.status,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const withConversation = ensureConversationSessionLink(
        withSession,
        event.conversationId,
        event.sessionId,
        timestamp,
        event.agentId
      );
      return event.relation
        ? upsertSessionRelation(withConversation, event.relation)
        : withConversation;
    }
    case "session.updated": {
      const existing = state.entities.sessions[event.sessionId];
      const withSession = upsertSession(withEventType(state, event.type), {
        sessionId: event.sessionId,
        conversationId: event.conversationId,
        agentId: existing?.agentId ?? unknownAgentId,
        status: event.status,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        archivedAt: existing?.archivedAt,
        lastTurnId: existing?.lastTurnId,
        title: existing?.title,
        metadata: event.metadata ?? existing?.metadata
      });
      return ensureConversationSessionLink(
        withSession,
        event.conversationId,
        event.sessionId,
        timestamp,
        existing?.agentId
      );
    }
    case "session.archived": {
      const existing = state.entities.sessions[event.sessionId];
      if (!existing) {
        return withEventType(state, event.type);
      }
      return upsertSession(
        withEventType(state, event.type),
        {
          ...existing,
          archivedAt: event.archivedAt,
          updatedAt: timestamp
        }
      );
    }
    case "session.disposed": {
      if (!state.entities.sessions[event.sessionId]) {
        return withEventType(state, event.type);
      }
      return withEventType(disposeSessionState(state, event.sessionId), event.type);
    }
    case "turn.started": {
      const withTurn = upsertTurn(
        withEventType(state, event.type),
        {
          turnId: event.turnId,
          sessionId: event.sessionId,
          status: "started",
          startedAt: timestamp,
          messageIds: [],
          toolCallIds: [],
          terminalIds: [],
          approvalRequestIds: []
        }
      );
      return setSessionLastTurn(withTurn, event.sessionId, event.turnId, timestamp);
    }
    case "turn.completed": {
      const existing = state.entities.turns[event.turnId];
      const withTurn = upsertTurn(
        withEventType(state, event.type),
        {
          turnId: event.turnId,
          sessionId: event.sessionId,
          status: "completed",
          finishReason: event.finishReason,
          startedAt: existing?.startedAt ?? timestamp,
          completedAt: timestamp,
          actor: existing?.actor,
          messageIds: existing?.messageIds ?? [],
          toolCallIds: existing?.toolCallIds ?? [],
          terminalIds: existing?.terminalIds ?? [],
          approvalRequestIds: existing?.approvalRequestIds ?? []
        }
      );
      return setSessionLastTurn(withTurn, event.sessionId, event.turnId, timestamp);
    }
    case "message.started": {
      const current = state.entities.messageBlocks[`${event.messageId}${markdownBlockSuffix}`];
      const withBlock = upsertMessageBlock(
        withEventType(state, event.type),
        {
          blockId: `${event.messageId}${markdownBlockSuffix}`,
          messageId: event.messageId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          role: current?.role ?? event.role,
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
        timestamp
      );
    }
    case "message.delta": {
      const current = state.entities.messageBlocks[`${event.messageId}${markdownBlockSuffix}`];
      const base = current ?? buildMessageDeltaBlock(event, timestamp);
      const withBlock = upsertMessageBlock(
        withEventType(state, event.type),
        {
          ...base,
          text: `${base.text ?? ""}${event.delta}`
        }
      );
      return appendTurnCollection(
        withBlock,
        event.turnId,
        event.sessionId,
        "messageIds",
        event.messageId,
        timestamp
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
          kind: "markdown",
          text: "",
          actor: buildActorRef(event),
          startedAt: timestamp
        } satisfies MessageBlock);
      const withBlock = upsertMessageBlock(
        withEventType(state, event.type),
        {
          ...base,
          text: event.finalText ?? base.text ?? "",
          actor: base.actor ?? buildActorRef(event),
          completedAt: timestamp
        }
      );
      return appendTurnCollection(
        withBlock,
        event.turnId,
        event.sessionId,
        "messageIds",
        event.messageId,
        timestamp
      );
    }
    case "tool.started": {
      const current = state.entities.toolCalls[event.toolCallId];
      const withTool = upsertToolCall(
        withEventType(state, event.type),
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
              agentId: event.agentId
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
        timestamp
      );
    }
    case "tool.delta": {
      const current = state.entities.toolCalls[event.toolCallId];
      const withTool = upsertToolCall(
        withEventType(state, event.type),
        {
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolName: current?.toolName ?? unknownToolName,
          status: current?.status ?? "running",
          inputSummary: current?.inputSummary,
          outputSummary: `${current?.outputSummary ?? ""}${event.delta}`,
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              agentId: event.agentId
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
        timestamp
      );
    }
    case "tool.completed": {
      const current = state.entities.toolCalls[event.toolCallId];
      const withTool = upsertToolCall(
        withEventType(state, event.type),
        {
          toolCallId: event.toolCallId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolName: current?.toolName ?? unknownToolName,
          status: event.status,
          outputSummary: event.outputSummary ?? current?.outputSummary,
          inputSummary: current?.inputSummary,
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              agentId: event.agentId
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
        timestamp
      );
    }
    case "terminal.started": {
      const current = state.entities.terminalStreams[event.terminalId];
      const withTerminal = upsertTerminalStream(
        withEventType(state, event.type),
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
              agentId: event.agentId
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
        timestamp
      );
    }
    case "terminal.output": {
      const current = state.entities.terminalStreams[event.terminalId];
      const withTerminal = upsertTerminalStream(
        withEventType(state, event.type),
        {
          terminalId: event.terminalId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolCallId: current?.toolCallId,
          status: current?.status ?? "running",
          outputText: `${current?.outputText ?? ""}${event.chunk}`,
          exitCode: current?.exitCode,
          actor:
            current?.actor ?? {
              participantId: event.participantId,
              agentId: event.agentId
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
        timestamp
      );
    }
    case "terminal.completed": {
      const current = state.entities.terminalStreams[event.terminalId];
      const status =
        typeof event.exitCode === "number" && event.exitCode !== 0 ? "failed" : "completed";
      const withTerminal = upsertTerminalStream(
        withEventType(state, event.type),
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
              agentId: event.agentId
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
        timestamp
      );
    }
    case "approval.requested": {
      const withApproval = upsertApprovalRequest(
        withEventType(state, event.type),
        {
          requestId: event.requestId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          approvalKind: event.approvalKind,
          status: "pending",
          title: event.title,
          details: event.details,
          actor: {
            participantId: event.participantId,
            agentId: event.agentId
          },
          requestedAt: timestamp
        }
      );
      return appendTurnCollection(
        withApproval,
        event.turnId,
        event.sessionId,
        "approvalRequestIds",
        event.requestId,
        timestamp
      );
    }
    case "approval.resolved": {
      const current = state.entities.approvalRequests[event.requestId];
      if (!current) {
        return appendTurnCollection(
          withEventType(state, event.type),
          event.turnId,
          event.sessionId,
          "approvalRequestIds",
          event.requestId,
          timestamp
        );
      }
      const withApproval = upsertApprovalRequest(
        withEventType(state, event.type),
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
        timestamp
      );
    }
    case "participant.updated": {
      const withParticipant = upsertParticipant(
        withEventType(state, event.type),
        {
          participantId: event.participantId,
          conversationId: event.conversationId,
          agentId: event.agentId,
          role: event.role,
          capabilities: event.capabilities,
          activeSessionIds: []
        }
      );
      return ensureConversationParticipant(
        withParticipant,
        event.conversationId,
        event.agentId,
        timestamp
      );
    }
    case "runtime.error": {
      return {
        ...withEventType(state, event.type),
        lastError: {
          code: event.code,
          message: event.message,
          recoverable: event.recoverable
        }
      };
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
  const recentEventIds = [
    ...(state.eventStream.recentEventIds ?? []),
    envelope.eventId
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

  return {
    ...state,
    eventStream: {
      lastEventId: envelope.eventId,
      lastCursor: envelope.cursor,
      lastOccurredAt: envelope.occurredAt,
      recentEventIds: trimmedRecentEventIds,
      seenEventIds
    }
  };
};

export const rendererStoreReducer = (
  state: RendererStoreState = createInitialRendererStoreState(),
  action: RendererStoreAction
): RendererStoreState => {
  switch (action.type) {
    case "store/hydrateSnapshot":
      return hydrateFromSnapshot(state, action.snapshot);
    case "store/hydrateSessionWindow": {
      const baseState =
        action.mode === "prepend"
          ? state
          : disposeSessionState(state, action.sessionId);
      return mergeSnapshotIntoState(baseState, action.snapshot);
    }
    case "store/disposeSession":
      return disposeSessionState(state, action.sessionId);
    case "store/ingestEvent":
      return applyRuntimeEvent(state, action.event);
    case "store/ingestEnvelope": {
      if (state.eventStream.seenEventIds[action.envelope.eventId]) {
        return state;
      }
      const next = applyRuntimeEvent(
        state,
        action.envelope.event,
        action.envelope.occurredAt
      );
      return markEnvelopeInEventStream(next, action.envelope);
    }
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
