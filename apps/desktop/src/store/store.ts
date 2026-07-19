import {
  createIngestEnvelopeAction,
  createIngestEnvelopesAction,
  createHydrateSnapshotAction,
  createIngestEventAction
} from "./intake.js";
import { rendererMetaReducer } from "./reducer.js";
import {
  createInitialRendererStoreState,
  normalizeRendererDomainSnapshot
} from "./state.js";
import type { RendererStoreAction, RendererStoreState } from "./types.js";
import {
  DomainReplica,
  type DomainChangeSet,
  type DomainReadModel
} from "@another-workbench/core";
import type {
  DomainSnapshot,
  EventEnvelope,
  RuntimeEvent
} from "@another-workbench/shared";

type Listener = (state: RendererStoreState, action: RendererStoreAction) => void;
type RevisionListener = () => void;

export type RendererStoreSubscriptionSnapshot = {
  revision: number;
  domainRevision: number;
  state: RendererStoreState;
  domain: DomainReadModel;
};

export type RendererStore = {
  getState: () => RendererStoreState;
  getRevision: () => number;
  getDomainReadModel: () => DomainReadModel;
  getSubscriptionSnapshot: () => RendererStoreSubscriptionSnapshot;
  dispatch: (action: RendererStoreAction) => RendererStoreState;
  subscribe: (listener: Listener) => () => void;
  subscribeMeta: (listener: RevisionListener) => () => void;
  subscribeSession: (sessionId: string, listener: RevisionListener) => () => void;
  subscribeConversation: (
    conversationId: string,
    listener: RevisionListener
  ) => () => void;
  hydrateSnapshot: (snapshot: DomainSnapshot, cursor?: string) => RendererStoreState;
  hydrateSessionWindow: (
    sessionId: string,
    snapshot: DomainSnapshot,
    mode?: "replace" | "prepend",
    cursor?: string
  ) => RendererStoreState;
  disposeSession: (sessionId: string) => RendererStoreState;
  ingestEvent: (event: RuntimeEvent) => RendererStoreState;
  ingestEnvelope: (envelope: EventEnvelope) => RendererStoreState;
  ingestEnvelopes: (envelopes: EventEnvelope[]) => RendererStoreState;
};

const applySnapshotActionToReplica = (
  replica: DomainReplica,
  action: RendererStoreAction
): void => {
  switch (action.type) {
    case "store/hydrateSnapshot":
      replica.replaceSnapshot(normalizeRendererDomainSnapshot(action.snapshot));
      return;
    case "store/hydrateSessionWindow": {
      const snapshot = normalizeRendererDomainSnapshot(action.snapshot);
      if (action.mode === "prepend") {
        replica.mergeSnapshot(snapshot, {
          scope: { sessionId: action.sessionId }
        });
        return;
      }
      replica.replaceSessionWindowSnapshot(action.sessionId, snapshot);
      return;
    }
    default:
      return;
  }
};

const createSubscriptionSnapshot = (
  state: RendererStoreState,
  revision: number,
  domainReplica: DomainReplica
): RendererStoreSubscriptionSnapshot => ({
  revision,
  domainRevision: domainReplica.getRevision(),
  state,
  domain: domainReplica.readModel
});

export const createRendererStore = (
  initialState?: RendererStoreState
): RendererStore => {
  let state = initialState ?? createInitialRendererStoreState();
  const domainReplica = new DomainReplica();
  let revision = 0;
  let subscriptionSnapshot = createSubscriptionSnapshot(
    state,
    revision,
    domainReplica
  );
  const listeners = new Set<Listener>();
  const metaListeners = new Set<RevisionListener>();
  const sessionListeners = new Map<string, Set<RevisionListener>>();
  const conversationListeners = new Map<string, Set<RevisionListener>>();

  const notifyDomain = (changes: DomainChangeSet): void => {
    if (changes.fullReset) {
      for (const listenersForScope of sessionListeners.values()) {
        for (const listener of listenersForScope) listener();
      }
      for (const listenersForScope of conversationListeners.values()) {
        for (const listener of listenersForScope) listener();
      }
      return;
    }
    for (const sessionId of changes.sessionIds) {
      for (const listener of sessionListeners.get(sessionId) ?? []) listener();
    }
    for (const conversationId of changes.conversationIds) {
      for (const listener of conversationListeners.get(conversationId) ?? []) listener();
    }
  };

  const subscribeScoped = (
    registry: Map<string, Set<RevisionListener>>,
    id: string,
    listener: RevisionListener
  ): (() => void) => {
    const scoped = registry.get(id) ?? new Set<RevisionListener>();
    scoped.add(listener);
    registry.set(id, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) registry.delete(id);
    };
  };

  const dispatch = (action: RendererStoreAction): RendererStoreState => {
    const previousState = state;
    const disposedConversationIdBeforeMutation =
      action.type === "store/disposeSession"
        ? domainReplica.resolveConversationIdBySessionId(action.sessionId)
        : undefined;
    let reducedState = rendererMetaReducer(state, action);
    let changes: DomainChangeSet | undefined;

    if (action.type === "store/hydrateSnapshot" || action.type === "store/hydrateSessionWindow") {
      const beforeRevision = domainReplica.getRevision();
      applySnapshotActionToReplica(domainReplica, action);
      changes = {
        revision: domainReplica.getRevision(),
        fullReset: action.type === "store/hydrateSnapshot",
        conversationIds: new Set(action.snapshot.conversations.map((item) => item.conversationId)),
        sessionIds: new Set(action.snapshot.sessions.map((item) => item.sessionId)),
        turnIds: new Set(action.snapshot.turns.map((item) => item.turnId))
      };
      if (domainReplica.getRevision() === beforeRevision) changes = undefined;
    } else if (action.type === "store/disposeSession") {
      const beforeRevision = domainReplica.getRevision();
      const conversationId = domainReplica.resolveConversationIdBySessionId(action.sessionId);
      if (conversationId) {
        changes = domainReplica.applyBatch([
          {
            occurredAt: new Date().toISOString(),
            event: {
              type: "session.disposed",
              conversationId,
              sessionId: action.sessionId,
              disposedAt: new Date().toISOString()
            }
          }
        ]);
      }
      if (domainReplica.getRevision() !== beforeRevision) {
        changes ??= {
          revision: domainReplica.getRevision(),
          fullReset: false,
          conversationIds: new Set(conversationId ? [conversationId] : []),
          sessionIds: new Set([action.sessionId]),
          turnIds: new Set()
        };
      }
    } else if (action.type === "store/ingestEvent") {
      changes = domainReplica.applyBatch([{ event: action.event }]);
    } else if (action.type === "store/ingestEnvelope") {
      if (reducedState !== previousState) {
        changes = domainReplica.applyBatch([action.envelope]);
      }
    } else if (action.type === "store/ingestEnvelopes") {
      const accepted = action.envelopes.filter(
        (envelope) =>
          !previousState.eventStream.seenEventIds[envelope.eventId] &&
          Boolean(reducedState.eventStream.seenEventIds[envelope.eventId])
      );
      if (accepted.length > 0) changes = domainReplica.applyBatch(accepted);
    }

    const disposedEvent =
      action.type === "store/ingestEvent" && action.event.type === "session.disposed"
        ? action.event
        : action.type === "store/ingestEnvelope" &&
            action.envelope.event.type === "session.disposed"
          ? action.envelope.event
          : action.type === "store/ingestEnvelopes"
            ? [...action.envelopes]
                .reverse()
                .map((envelope) => envelope.event)
                .find((event) => event.type === "session.disposed")
            : undefined;
    const disposedSessionId =
      action.type === "store/disposeSession"
        ? action.sessionId
        : disposedEvent?.type === "session.disposed"
          ? disposedEvent.sessionId
          : undefined;
    const disposedConversationId =
      disposedEvent?.type === "session.disposed"
        ? disposedEvent.conversationId
        : disposedConversationIdBeforeMutation;
    if (
      disposedSessionId &&
      previousState.activeSessionId === disposedSessionId
    ) {
      const nextSession =
        (disposedConversationId
          ? domainReplica.getConversation(disposedConversationId)?.activeSessionId
          : undefined) ?? domainReplica.listSessions().at(0)?.sessionId;
      reducedState = {
        ...reducedState,
        activeConversationId: nextSession
          ? domainReplica.resolveConversationIdBySessionId(nextSession)
          : disposedConversationId ?? reducedState.activeConversationId,
        activeSessionId: nextSession
      };
    }

    if (reducedState !== previousState || changes) {
      state = reducedState;
      revision += 1;
      subscriptionSnapshot = createSubscriptionSnapshot(
        state,
        revision,
        domainReplica
      );
    }
    if (
      reducedState.activeConversationId !== previousState.activeConversationId ||
      reducedState.activeSessionId !== previousState.activeSessionId ||
      reducedState.refreshSignals !== previousState.refreshSignals ||
      reducedState.lastError !== previousState.lastError
    ) {
      for (const listener of metaListeners) listener();
    }
    if (changes) notifyDomain(changes);
    for (const listener of listeners) {
      listener(state, action);
    }
    return state;
  };

  return {
    getState: () => state,
    getRevision: () => revision,
    getDomainReadModel: () => domainReplica.readModel,
    getSubscriptionSnapshot: () => subscriptionSnapshot,
    dispatch,
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeMeta: (listener) => {
      metaListeners.add(listener);
      return () => metaListeners.delete(listener);
    },
    subscribeSession: (sessionId, listener) =>
      subscribeScoped(sessionListeners, sessionId, listener),
    subscribeConversation: (conversationId, listener) =>
      subscribeScoped(conversationListeners, conversationId, listener),
    hydrateSnapshot: (snapshot: DomainSnapshot, cursor?: string) =>
      dispatch(createHydrateSnapshotAction(snapshot, cursor)),
    hydrateSessionWindow: (sessionId, snapshot, mode = "replace", cursor) =>
      dispatch({
        type: "store/hydrateSessionWindow",
        sessionId,
        snapshot,
        mode,
        cursor
      }),
    disposeSession: (sessionId) =>
      dispatch({
        type: "store/disposeSession",
        sessionId
      }),
    ingestEvent: (event: RuntimeEvent) =>
      dispatch(createIngestEventAction(event)),
    ingestEnvelope: (envelope: EventEnvelope) =>
      dispatch(createIngestEnvelopeAction(envelope)),
    ingestEnvelopes: (envelopes: EventEnvelope[]) =>
      dispatch(createIngestEnvelopesAction(envelopes))
  };
};
